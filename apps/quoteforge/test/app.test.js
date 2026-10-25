import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createQuoteForge } from '../src/app.js';

const boot = (options = {}) => startTestApp(createQuoteForge, options);
const outbox = (t) => t.app.db.all('SELECT * FROM outbox ORDER BY id');
const quote = (t, id = 1) => t.app.db.get('SELECT * FROM quotes WHERE id = ?', id);

const FORM = {
  customer_name: 'Sharma Builders', customer_email: 'sharma@example.com', customer_phone: '+91 98765 43210', title: 'Office fit-out',
  currency: 'INR', valid_until: '2026-11-15', discount_type: 'percent', discount_value: '10', tax_mode: 'gst_intra', tax_rate: '18',
  desc: ['Tiles', 'Labour'], qty: ['3', '1'], unit: ['', ''], price: ['1500', '2499.99'], notes: 'Thanks!', terms: '50% advance',
};

async function setup(t, plan = 'pro', signup = {}) {
  const c = t.client();
  await c.signup('owner@example.com', 'correct horse battery', signup);
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  return c;
}
const create = (c, over = {}) => c.post('/quotes', { ...FORM, ...over });

test('landing page markets GST support and shows INR + USD pricing', async () => {
  const t = await boot();
  try {
    const home = (await t.client().get('/')).text;
    assert.match(home, /GST \/ VAT \/ sales tax built in/);
    assert.match(home, /₹999/);
    assert.match(home, /\$79/);
  } finally {
    await t.close();
  }
});

test('creating a quote computes totals on the server, exactly, with sequential numbers', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    const r = await create(c, { total: '1', subtotal: '1', tax_total: '1' }); // client-supplied totals must be ignored
    assert.equal(r.status, 303);
    const q = quote(t);
    assert.equal(q.number, 'Q-0001');
    assert.equal(q.status, 'draft');
    assert.deepEqual([q.subtotal, q.discount, q.tax_total, q.total], [699999, 70000, 113400, 743399]);
    assert.equal(t.app.db.all('SELECT * FROM quote_items WHERE quote_id = 1 ORDER BY position').length, 2);
    await create(c, { customer_name: 'Second' });
    assert.equal(quote(t, 2).number, 'Q-0002');
    // deleting does not recycle numbers
    await c.post('/quotes/2/delete');
    await create(c, { customer_name: 'Third' });
    assert.equal(t.app.db.get(`SELECT number FROM quotes WHERE customer_name = 'Third'`).number, 'Q-0003');
  } finally {
    await t.close();
  }
});

test('INR accounts default to 18% GST; USD accounts to no tax', async () => {
  const t = await boot();
  try {
    const inr = await setup(t, 'pro', { currency: 'INR' });
    const page = (await inr.get('/quotes/new')).text;
    assert.match(page, /name="tax_rate" value="18"/);
    assert.match(page, /<option value="gst_intra" selected>/);
    const usd = t.client();
    await usd.signup('us@example.com');
    const p2 = (await usd.get('/quotes/new')).text;
    assert.match(p2, /<option value="none" selected>/);
  } finally {
    await t.close();
  }
});

test('form validation messages', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    const cases = [
      [{ customer_name: '' }, /Customer name is required/],
      [{ desc: [''], qty: [''], price: [''] }, /at least one line item/],
      [{ qty: ['0', '1'] }, /quantity must be greater than zero/],
      [{ price: ['abc', '1'] }, /price/],
      [{ customer_email: 'not-an-email' }, /email/],
      [{ valid_until: '31/02/2026' }, /valid/],
    ];
    for (const [over, re] of cases) {
      const r = await create(c, over);
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match(r.text, re);
      assert.match(r.text, /Sharma Builders|name="customer_name"/, 'form is redisplayed');
    }
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM quotes').n, 0);
  } finally {
    await t.close();
  }
});

test('drafts are private; sending emails the link, then the customer can open and accept', async () => {
  const t = await boot();
  try {
    const c = await setup(t, 'pro', { currency: 'INR' });
    await create(c);
    const { token } = quote(t);
    const anon = t.client();
    assert.equal((await anon.get(`/q/${token}`)).status, 404, 'drafts are never public');

    await c.post('/quotes/1/send');
    assert.equal(quote(t).status, 'sent');
    const mail = outbox(t)[0];
    assert.equal(mail.to_email, 'sharma@example.com');
    assert.match(mail.body, new RegExp(`/q/${token}`));
    assert.match(mail.subject, /Quote Q-0001/);
    assert.equal(mail.reply_to, 'owner@example.com');

    const page = await anon.get(`/q/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Quote Q-0001/);
    assert.match(page.text, /₹7,433\.99/, 'total in rupees');
    assert.match(page.text, /CGST \(9%\)/);
    assert.match(page.text, /SGST \(9%\)/);
    assert.match(page.text, /Accept quote/);
    assert.equal(quote(t).status, 'viewed');
    assert.ok(quote(t).viewed_at);
    assert.ok(!page.text.includes('csrf-token'));

    const noName = await anon.request('POST', `/q/${token}/respond`, { form: { decision: 'accept', name: '' } });
    assert.equal(noName.status, 303);
    assert.equal(quote(t).status, 'viewed', 'acceptance needs a name');

    await anon.request('POST', `/q/${token}/respond`, { form: { decision: 'accept', name: 'R. Sharma', comment: 'Go ahead' } });
    const q = quote(t);
    assert.equal(q.status, 'accepted');
    assert.equal(q.response_name, 'R. Sharma');
    assert.equal(q.response_comment, 'Go ahead');
    const ownerMail = outbox(t).find((m) => m.to_email === 'owner@example.com');
    assert.match(ownerMail.subject, /Q-0001 accepted/);

    // a second response cannot flip the decision
    await anon.request('POST', `/q/${token}/respond`, { form: { decision: 'decline', name: 'X' } });
    assert.equal(quote(t).status, 'accepted');
    assert.match((await anon.get(`/q/${token}`)).text, /Accepted by R\. Sharma/);
  } finally {
    await t.close();
  }
});

test('declining works, and expired quotes cannot be accepted', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await create(c);
    await create(c, { customer_name: 'Late Co', valid_until: '2026-10-01' });
    await c.post('/quotes/1/share');
    await c.post('/quotes/2/share');
    const anon = t.client();
    await anon.request('POST', `/q/${quote(t, 1).token}/respond`, { form: { decision: 'decline', comment: 'Too expensive' } });
    assert.equal(quote(t, 1).status, 'declined');

    const expiredPage = (await anon.get(`/q/${quote(t, 2).token}`)).text;
    assert.match(expiredPage, /expired on/);
    assert.ok(!expiredPage.includes('Accept quote'));
    await anon.request('POST', `/q/${quote(t, 2).token}/respond`, { form: { decision: 'accept', name: 'Late' } });
    assert.notEqual(quote(t, 2).status, 'accepted');
  } finally {
    await t.close();
  }
});

test('sent quotes are locked; revising creates a new draft and supersedes the old link', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await create(c);
    await c.post('/quotes/1/send');
    const edit = await c.post('/quotes/1/edit', { ...FORM, customer_name: 'Changed' });
    assert.equal(edit.status, 303);
    assert.equal(quote(t).customer_name, 'Sharma Builders', 'sent quotes cannot be edited in place');

    await c.post('/quotes/1/revise');
    const rev = quote(t, 2);
    assert.equal(rev.number, 'Q-0001-R2');
    assert.equal(rev.parent_id, 1);
    assert.equal(rev.status, 'draft');
    assert.equal(rev.total, quote(t).total);
    assert.equal(quote(t).status, 'revised');
    assert.equal(t.app.db.all('SELECT * FROM quote_items WHERE quote_id = 2').length, 2);

    const anon = t.client();
    assert.match((await anon.get(`/q/${quote(t).token}`)).text, /replaced by a newer version/);
    await c.post('/quotes/2/edit', { ...FORM, discount_value: '0' });
    assert.ok(quote(t, 2).total > 743399, 'draft revisions are editable');
    await c.post('/quotes/2/share');
    assert.match((await anon.get(`/q/${quote(t).token}`)).text, new RegExp(`/q/${quote(t, 2).token}`), 'old link points to the new quote');
    await anon.request('POST', `/q/${quote(t).token}/respond`, { form: { decision: 'accept', name: 'X' } });
    assert.equal(quote(t).status, 'revised', 'superseded quotes cannot be accepted');
  } finally {
    await t.close();
  }
});

test('free plan: monthly quote cap and branded footer; paid plans have neither footer nor the cap', async () => {
  const t = await boot();
  try {
    const c = await setup(t, 'free');
    for (let i = 0; i < 7; i++) await create(c, { customer_name: `C${i}` });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM quotes').n, 5, 'free = 5 quotes / month');
    await c.post('/quotes/1/share');
    const anon = t.client();
    assert.match((await anon.get(`/q/${quote(t).token}`)).text, /Made with/);

    t.app.db.run(`UPDATE users SET plan = 'starter', plan_expires_at = ?`, t.clock.t + 86400000);
    assert.ok(!(await anon.get(`/q/${quote(t).token}`)).text.includes('Made with'));
    await create(c, { customer_name: 'After upgrade' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM quotes').n, 6);
  } finally {
    await t.close();
  }
});

test('emailing is limited by plan; sharing the link still works', async () => {
  const t = await boot();
  try {
    const c = await setup(t, 'free');
    for (let i = 0; i < 10; i++) t.app.db.run(`INSERT INTO outbox (user_id, to_email, subject, body, status, created_at) VALUES (1, 'x@y.co', 's', 'b', 'logged', ?)`, t.clock.t);
    await create(c);
    await c.post('/quotes/1/send');
    assert.equal(quote(t).status, 'draft', 'not sent when the email allowance is used up');
    await c.post('/quotes/1/share');
    assert.equal(quote(t).status, 'sent');
  } finally {
    await t.close();
  }
});

test('follow-ups: dashboard flags stale quotes, manual reminder, auto job sends once in business hours', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await create(c);
    await c.post('/quotes/1/send');
    assert.ok(!(await c.get('/dashboard')).text.includes('Needs a follow-up'));
    t.clock.t = Date.UTC(2026, 9, 29, 15, 0, 0); // 4 days later, 11:00 New York
    assert.match((await c.get('/dashboard')).text, /Needs a follow-up/);

    // auto follow-up is off by default
    assert.equal(await t.app.runFollowups(), 0);
    await c.post('/settings', { quote_prefix: 'Q-', validity_days: '14', tax_mode: 'none', tax_rate: '0', auto_followup: '1', followup_days: '3' });
    assert.equal(await t.app.runFollowups(), 1);
    assert.equal(await t.app.runFollowups(), 0, 'only once per quote');
    const mail = outbox(t).at(-1);
    assert.match(mail.subject, /Following up on quote Q-0001/);
    assert.ok(quote(t).followed_up_at);
    assert.ok(!(await c.get('/dashboard')).text.includes('Needs a follow-up'));

    // outside business hours the job holds off
    await create(c, { customer_name: 'Night owl' });
    await c.post('/quotes/2/send');
    t.clock.t += 5 * 86400000;
    t.clock.t = Date.UTC(2026, 10, 3, 5, 0, 0); // 00:00 New York
    assert.equal(await t.app.runFollowups(), 0);
  } finally {
    await t.close();
  }
});

test('manual reminder emails the customer and records it', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await create(c);
    await c.post('/quotes/1/send');
    await c.post('/quotes/1/remind');
    assert.equal(outbox(t).length, 2);
    assert.ok(quote(t).followed_up_at);
    await c.post('/quotes/1/extend');
    assert.equal(quote(t).valid_until, '2026-11-29', 'extends from the current validity date');
  } finally {
    await t.close();
  }
});

test('tenant isolation and public-link scoping', async () => {
  const t = await boot();
  try {
    const a = await setup(t);
    const b = t.client();
    await b.signup('b@example.com');
    await create(a);
    for (const p of ['/quotes/1', '/quotes/1/preview']) assert.equal((await b.get(p)).status, 404, p);
    for (const p of ['send', 'share', 'remind', 'revise', 'duplicate', 'delete', 'extend', 'status', 'edit']) assert.equal((await b.post(`/quotes/1/${p}`, FORM)).status, 404, p);
    assert.ok(!(await b.get('/quotes')).text.includes('Sharma'));
    assert.ok(!(await b.get('/quotes.csv')).text.includes('Sharma'));
    assert.equal((await t.client().get('/q/guess-the-token')).status, 404);
    assert.equal(quote(t).status, 'draft');
  } finally {
    await t.close();
  }
});

test('customer-supplied text is escaped on every page, including the public one', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    const evil = '<img src=x onerror=alert(1)>';
    await create(c, { customer_name: evil, notes: evil, terms: evil, title: evil, customer_address: evil, desc: [evil, 'ok'] });
    await c.post('/quotes/1/share');
    await c.post('/settings', { business_name: evil, address: evil, tax_id: evil, logo_url: 'javascript:alert(1)', quote_prefix: 'Q-', validity_days: '14', tax_mode: 'none', tax_rate: '0', followup_days: '3' });
    const anon = t.client();
    const pages = [(await anon.get(`/q/${quote(t).token}`)).text, (await c.get('/quotes/1')).text, (await c.get('/quotes')).text, (await c.get('/dashboard')).text, (await c.get('/settings')).text];
    for (const p of pages) {
      assert.ok(!p.includes('<img src=x'), 'no raw injected tag');
      assert.ok(!p.includes('javascript:alert'), 'no javascript: URL');
    }
  } finally {
    await t.close();
  }
});

test('duplicate copies items into a fresh draft with its own number and link', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await create(c);
    await c.post('/quotes/1/duplicate');
    const d = quote(t, 2);
    assert.equal(d.number, 'Q-0002');
    assert.equal(d.status, 'draft');
    assert.notEqual(d.token, quote(t).token);
    assert.equal(d.total, quote(t).total);
    assert.equal(t.app.db.all('SELECT * FROM quote_items WHERE quote_id = 2').length, 2);
  } finally {
    await t.close();
  }
});

test('settings: custom prefix, branding on the public document, csv export', async () => {
  const t = await boot();
  try {
    const c = await setup(t, 'pro', { currency: 'INR' });
    await c.post('/settings', { business_name: 'Mangaluru Interiors', tax_id: '29ABCDE1234F1Z5', address: '12 MG Road\nMangaluru', logo_url: 'https://example.com/logo.png', quote_prefix: 'MI/', validity_days: '30', tax_mode: 'gst_inter', tax_rate: '12', followup_days: '3' });
    await create(c, { tax_mode: 'gst_inter', tax_rate: '12' });
    const q = quote(t);
    assert.equal(q.number, 'MI/0001');
    await c.post('/quotes/1/share');
    const page = (await t.client().get(`/q/${q.token}`)).text;
    assert.match(page, /Mangaluru Interiors/);
    assert.match(page, /GSTIN: 29ABCDE1234F1Z5/);
    assert.match(page, /https:\/\/example\.com\/logo\.png/);
    assert.match(page, /IGST \(12%\)/);
    const csv = (await c.get('/quotes.csv')).text;
    assert.match(csv, /^number,customer,title,status/);
    assert.match(csv, /MI\/0001,Sharma Builders/);
  } finally {
    await t.close();
  }
});
