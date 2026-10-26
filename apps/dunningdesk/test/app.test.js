import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createDunningDesk } from '../src/app.js';

const boot = (options = {}) => startTestApp(createDunningDesk, options);
const CSV = [
  'invoice,client,email,amount,due_date',
  'INV-1,Acme Ltd,billing@acme.test,1200,2026-10-15',
  'INV-2,Beta LLC,pay@beta.test,300,2026-12-01',
].join('\n');
const outbox = (t) => t.app.db.all('SELECT * FROM outbox ORDER BY id');

async function upgrade(t, plan = 'pro') {
  t.app.db.run(`UPDATE users SET plan = ?, plan_expires_at = ?`, plan, t.clock.t + 30 * 86400000);
}

test('landing page shows both INR and USD pricing', async () => {
  const t = await boot();
  try {
    const home = (await t.client().get('/')).text;
    assert.match(home, /₹999/);
    assert.match(home, /\$29/);
    assert.match(home, /Late invoices chased for you/);
  } finally {
    await t.close();
  }
});

test('import → scheduled run sends the right reminder once and logs it', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const imp = await c.post('/import', { csv: CSV });
    assert.equal(imp.status, 303);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM invoices').n, 2);

    // 09:00 UTC is 05:00 in New York (outside business hours): the scheduled job holds off.
    let r = await t.app.runReminders();
    assert.equal(r.sent, 0);

    t.clock.t = Date.UTC(2026, 9, 25, 15, 0, 0); // 11:00 New York, 10 days after INV-1 was due
    r = await t.app.runReminders();
    assert.equal(r.sent, 1);
    const mail = outbox(t);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_email, 'billing@acme.test');
    assert.match(mail[0].subject, /INV-1/);
    assert.match(mail[0].subject, /Reminder/, 'first contact is the gentle stage even at 10 days late');
    assert.equal(mail[0].reply_to, 'owner@example.com');
    assert.match(mail[0].body, /\/pay\//);

    // running again immediately sends nothing
    r = await t.app.runReminders();
    assert.equal(r.sent, 0);
    assert.equal(outbox(t).length, 1);

    // five days later it escalates
    t.clock.t += 5 * 86400000;
    r = await t.app.runReminders();
    assert.equal(r.sent, 1);
    assert.match(outbox(t)[1].subject, /Final notice/);
  } finally {
    await t.close();
  }
});

test('paying an invoice stops reminders and records recovery', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/import', { csv: CSV });
    t.clock.t = Date.UTC(2026, 9, 25, 15, 0, 0);
    await t.app.runReminders();
    const id = t.app.db.get(`SELECT id FROM invoices WHERE number = 'INV-1'`).id;
    await c.post(`/invoices/${id}/paid`);
    const row = t.app.db.get('SELECT status, paid_after_reminder FROM invoices WHERE id = ?', id);
    assert.equal(row.status, 'paid');
    assert.equal(row.paid_after_reminder, 1);
    t.clock.t += 10 * 86400000;
    assert.equal((await t.app.runReminders()).sent, 0);
    const dash = (await c.get('/dashboard')).text;
    assert.match(dash, /Collected after a reminder/);
    assert.match(dash, /\$1,200/);
  } finally {
    await t.close();
  }
});

test('manual reminder from the invoice page, and bad input is rejected', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/import', { csv: CSV });
    const id = t.app.db.get(`SELECT id FROM invoices WHERE number = 'INV-2'`).id;
    const ok = await c.post(`/invoices/${id}/remind`, { stage: '0' });
    assert.equal(ok.status, 303);
    assert.equal(outbox(t).length, 1);
    assert.equal(t.app.db.get('SELECT manual FROM reminders').manual, 1);
    await c.post(`/invoices/${id}/remind`, { stage: '99' });
    assert.equal(outbox(t).length, 1);
  } finally {
    await t.close();
  }
});

test('free plan caps open invoices and monthly emails', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const rows = Array.from({ length: 8 }, (_, i) => `INV-${i},Client ${i},c${i}@x.test,100,2026-10-10`);
    await c.post('/import', { csv: ['invoice,client,email,amount,due_date', ...rows].join('\n') });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM invoices').n, 5, 'free plan = 5 open invoices');
    const manual = await c.post('/invoices', { number: 'X', client_name: 'Y', amount: '10', due_date: '2026-11-01', currency: 'USD' });
    assert.equal(manual.status, 303);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM invoices').n, 5);

    t.clock.t = Date.UTC(2026, 9, 25, 15, 0, 0); // 15 days late: gentle first contact
    assert.equal((await t.app.runReminders()).sent, 5);
    t.clock.t += 5 * 86400000; // 20 days late: final notice, uses up the 10-email allowance
    assert.equal((await t.app.runReminders()).sent, 5);
    t.clock.t += 11 * 86400000; // 31 days late: escalation is due but the plan is exhausted
    const r3 = await t.app.runReminders();
    assert.equal(r3.sent, 0);
    assert.equal(r3.skippedLimit, 5);
    assert.equal(outbox(t).length, 10);
  } finally {
    await t.close();
  }
});

test('re-importing updates open invoices instead of duplicating', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await upgrade(t);
    await c.post('/import', { csv: CSV });
    await c.post('/import', { csv: 'invoice,client,email,amount,due_date\nINV-1,Acme Ltd,billing@acme.test,1500,2026-10-20' });
    const rows = t.app.db.all(`SELECT * FROM invoices WHERE number = 'INV-1'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 150000);
    assert.equal(rows[0].due_date, '2026-10-20');
  } finally {
    await t.close();
  }
});

test('import with a missing column explains what to fix', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const r = await c.post('/import', { csv: 'invoice,client\nA,B' });
    assert.equal(r.status, 200);
    assert.match(r.text, /Missing required column/);
    assert.match(r.text, /amount, due_date/);
  } finally {
    await t.close();
  }
});

test('public pay page: shows invoice, client can claim paid, owner is emailed, reminders pause', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/import', { csv: CSV });
    await c.post('/settings', { business_name: 'Studio <X>', payment_instructions: 'UPI: studio@bank', auto_send: '1', stages: ['due', 'late_3'], min_gap_days: '4' });
    const inv = t.app.db.get(`SELECT * FROM invoices WHERE number = 'INV-1'`);

    const anon = t.client();
    const page = await anon.get(`/pay/${inv.public_token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Studio &lt;X&gt;/, 'business name is escaped');
    assert.match(page.text, /UPI: studio@bank/);
    assert.ok(!page.text.includes('csrf-token'));
    assert.equal((await anon.get('/pay/not-a-token')).status, 404);

    const claim = await anon.request('POST', `/pay/${inv.public_token}/paid`);
    assert.equal(claim.status, 303);
    assert.ok(t.app.db.get('SELECT claimed_paid_at AS c FROM invoices WHERE id = ?', inv.id).c);
    assert.ok(outbox(t).some((m) => m.to_email === 'owner@example.com' && /says invoice INV-1 is paid/.test(m.subject)));

    t.clock.t = Date.UTC(2026, 9, 25, 15, 0, 0);
    const before = outbox(t).length;
    await t.app.runReminders();
    assert.ok(!outbox(t).slice(before).some((m) => m.to_email === 'billing@acme.test'), 'no reminder after the client claims payment');
  } finally {
    await t.close();
  }
});

test('tenants cannot read, edit or chase each other\'s invoices', async () => {
  const t = await boot();
  try {
    const a = t.client();
    const b = t.client();
    await a.signup('a@example.com');
    await b.signup('b@example.com');
    await a.post('/import', { csv: CSV });
    const id = t.app.db.get(`SELECT id FROM invoices WHERE number = 'INV-1'`).id;
    assert.equal((await b.get(`/invoices/${id}`)).status, 404);
    assert.equal((await b.post(`/invoices/${id}/paid`)).status, 404);
    assert.equal((await b.post(`/invoices/${id}/delete`)).status, 404);
    assert.equal((await b.post(`/invoices/${id}/remind`, { stage: '0' })).status, 404);
    assert.ok(!(await b.get('/invoices?filter=all')).text.includes('Acme'));
    assert.ok(!(await b.get('/invoices.csv')).text.includes('Acme'));
    assert.equal(t.app.db.get('SELECT status FROM invoices WHERE id = ?', id).status, 'open');
  } finally {
    await t.close();
  }
});

test('csv export neutralises spreadsheet formulas in client names', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/invoices', { number: 'F-1', client_name: '=HYPERLINK("http://evil")', amount: '10', due_date: '2026-11-01', currency: 'USD' });
    const csv = (await c.get('/invoices.csv')).text;
    assert.match(csv, /'=HYPERLINK/);
  } finally {
    await t.close();
  }
});

test('invoice form validation', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const bad = await c.post('/invoices', { number: 'A', client_name: 'B', amount: '-5', due_date: '2026-11-01' });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /greater than zero/);
    const dup = async () => c.post('/invoices', { number: 'D', client_name: 'B', amount: '5', due_date: '2026-11-01', currency: 'USD' });
    assert.equal((await dup()).status, 303);
    assert.equal((await dup()).status, 400);
  } finally {
    await t.close();
  }
});

test('INR users get day-first dates and rupee formatting', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup('in@example.com', 'correct horse battery', { currency: 'INR' });
    await c.post('/import', { csv: 'invoice,client,email,amount,due_date\nI-1,Sharma,s@x.test,"1,23,456",05/10/2026' });
    const row = t.app.db.get('SELECT * FROM invoices');
    assert.equal(row.due_date, '2026-10-05');
    assert.equal(row.currency, 'INR');
    assert.equal(row.amount, 12345600);
    assert.match((await c.get('/dashboard')).text, /₹1,23,456/);
  } finally {
    await t.close();
  }
});

test('promise to pay holds reminders until the date, then resumes automatically', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await upgrade(t);
    await c.post('/import', { csv: CSV });
    const id = t.app.db.get(`SELECT id FROM invoices WHERE number = 'INV-1'`).id;
    t.clock.t = Date.UTC(2026, 9, 25, 15, 0, 0);
    for (const bad of ['2026-10-01', '2027-06-01', 'soon', '']) await c.post(`/invoices/${id}/promise`, { date: bad });
    assert.equal(t.app.db.get('SELECT promise_date AS p FROM invoices WHERE id = ?', id).p, null, 'past, too-far and invalid dates are refused');
    await c.post(`/invoices/${id}/promise`, { date: '2026-11-02' });
    assert.match((await c.get(`/invoices/${id}`)).text, /promised to pay by/);
    assert.match((await c.get('/invoices?filter=open')).text, /Promised 2 Nov 2026/);
    assert.equal((await t.app.runReminders()).sent, 0, 'on hold while promised');
    t.clock.t = Date.UTC(2026, 10, 2, 15, 0, 0);
    assert.equal((await t.app.runReminders()).sent, 0, 'still on hold on the promised day itself');
    t.clock.t = Date.UTC(2026, 10, 3, 15, 0, 0);
    assert.equal((await t.app.runReminders()).sent, 1, 'broken promise: reminders resume');
    await c.post(`/invoices/${id}/promise-clear`);
    assert.equal(t.app.db.get('SELECT promise_date AS p FROM invoices WHERE id = ?', id).p, null);
  } finally {
    await t.close();
  }
});

test('promise to pay is per account', async () => {
  const t = await boot();
  try {
    const a = t.client();
    await a.signup('a@example.com');
    await a.post('/import', { csv: CSV });
    const b = t.client();
    await b.signup('b@example.com');
    assert.equal((await b.post('/invoices/1/promise', { date: '2026-11-02' })).status, 404);
  } finally {
    await t.close();
  }
});
