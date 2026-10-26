import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createLeadRevive } from '../src/app.js';

const CSV = [
  'name,email,phone,company,value,status,last_contact',
  'Asha Rao,asha@example.com,9876543210,Rao Realty,250000,contacted,2026-09-20',
  'Vikram Shah,vikram@example.com,,Shah & Co,50000,new,2026-10-01',
  'Recent Rita,rita@example.com,,,10000,new,2026-10-24',
  'Closed Carl,carl@example.com,,,90000,won,2026-08-01',
].join('\n');

const fakeClaude = (text, extra = {}) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], ...extra };
      },
    },
  };
};
const GOOD_AI = 'SUBJECT: Still thinking about the flat?\n\nHi Asha, I wanted to check whether the 3BHK is still on your list. If it is, I can line up two viewings this week.\n\nPriya';

const boot = (options = {}, env = {}) => startTestApp((o) => createLeadRevive({ ...o, ...options }), { env });
const outbox = (t) => t.app.db.all('SELECT * FROM outbox ORDER BY id');

async function ready(t, plan = 'pro') {
  const c = t.client();
  await c.signup();
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  await c.post('/import', { csv: CSV });
  return c;
}

test('dashboard shows revenue at risk and ranks cold leads by priority', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const page = (await c.get('/dashboard')).text;
    assert.match(page, /Revenue at risk/);
    assert.match(page, /\$300,000/, '250,000 + 50,000 across the two cold leads');
    assert.ok(page.indexOf('Asha Rao') < page.indexOf('Vikram Shah'), 'bigger, warmer lead first');
    assert.ok(!page.includes('Recent Rita'), 'recently contacted lead is not cold');
    assert.ok(!page.includes('Closed Carl'));
  } finally {
    await t.close();
  }
});

test('template drafts → edit → send via email updates the lead and logs it', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const r = await c.post('/drafts/generate', { limit: '5' });
    assert.equal(r.status, 303);
    const drafts = t.app.db.all(`SELECT * FROM followups WHERE status = 'draft' ORDER BY id`);
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((d) => d.ai === 0));

    const draftsPage = (await c.get('/drafts')).text;
    assert.match(draftsPage, /Asha Rao/);
    assert.match(draftsPage, /wa\.me\/919876543210|wa\.me\/1?9876543210/);

    const asha = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`);
    const d = drafts.find((x) => x.lead_id === asha.id);
    await c.post(`/drafts/${d.id}/send`, { subject: 'Edited subject', body: 'Edited body text for Asha.' });
    const mail = outbox(t);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to_email, 'asha@example.com');
    assert.equal(mail[0].subject, 'Edited subject');
    assert.match(mail[0].body, /Edited body text/);
    const lead = t.app.db.get('SELECT * FROM leads WHERE id = ?', asha.id);
    assert.equal(lead.last_contact_on, '2026-10-25');
    assert.equal(t.app.db.get('SELECT status FROM followups WHERE id = ?', d.id).status, 'sent');

    // sent leads are no longer cold, and a second generate only drafts for the remaining one
    await c.post('/drafts/generate', { limit: '5' });
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM followups WHERE status = 'draft'`).n, 1);
  } finally {
    await t.close();
  }
});

test('a lead never accumulates multiple open drafts', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    await c.post(`/leads/${id}/draft`);
    await c.post(`/leads/${id}/draft`);
    await c.post('/drafts/generate', { limit: '10' });
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM followups WHERE lead_id = ?`, id).n, 1);
  } finally {
    await t.close();
  }
});

test('follow-up stages advance as messages are sent', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    const stages = [];
    for (let i = 0; i < 4; i++) {
      await c.post(`/leads/${id}/draft`);
      const d = t.app.db.get(`SELECT * FROM followups WHERE lead_id = ? AND status = 'draft'`, id);
      stages.push(d.stage);
      await c.post(`/drafts/${d.id}/manual`, {});
      t.app.db.run('UPDATE leads SET last_contact_on = ? WHERE id = ?', '2026-09-01', id); // make it cold again
    }
    assert.deepEqual(stages, [0, 1, 2, 2]);
  } finally {
    await t.close();
  }
});

test('AI drafts: correct Claude call, used when valid, flagged as AI', async () => {
  const claude = fakeClaude(GOOD_AI);
  const t = await boot({ anthropic: claude });
  try {
    const c = await ready(t);
    await c.post('/settings', { business_name: 'Rao Homes', offer: 'Home search', tone: 'professional', stale_days: '7', use_ai: '1' });
    await c.post('/drafts/generate', { limit: '1' });
    assert.equal(claude.calls.length, 1);
    const call = claude.calls[0];
    assert.equal(call.model, 'claude-opus-5-5');
    assert.deepEqual(call.output_config, { effort: 'low' });
    assert.ok(call.max_tokens >= 4000);
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(forbidden in call), `${forbidden} must not be sent`);
    assert.notEqual(call.messages.at(-1).role, 'assistant', 'no prefill');
    assert.match(call.messages[0].content, /Asha Rao/);
    assert.match(call.system, /untrusted/);
    const d = t.app.db.get(`SELECT * FROM followups`);
    assert.equal(d.ai, 1);
    assert.equal(d.subject, 'Still thinking about the flat?');
    assert.match((await c.get('/drafts')).text, /AI-written/);
  } finally {
    await t.close();
  }
});

test('AI failure, refusal or unsafe output falls back to templates', async () => {
  const scenarios = [
    fakeClaude('', { stop_reason: 'refusal' }),
    fakeClaude('SUBJECT: Hi\n\nHi Asha, book here https://evil.example/x to see the flat, no pressure at all today.'),
    fakeClaude('just some text without the subject format'),
    { messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } } },
  ];
  for (const claude of scenarios) {
    const t = await boot({ anthropic: claude });
    const origError = console.error;
    console.error = () => {};
    try {
      const c = await ready(t);
      await c.post('/drafts/generate', { limit: '1' });
      const d = t.app.db.get(`SELECT * FROM followups`);
      assert.ok(d, 'a draft is still produced');
      assert.equal(d.ai, 0);
      assert.match(d.body, /^Hi Asha,/);
    } finally {
      console.error = origError;
      await t.close();
    }
  }
});

test('AI is skipped when switched off or when the plan quota is used up', async () => {
  const claude = fakeClaude(GOOD_AI);
  const t = await boot({ anthropic: claude });
  try {
    const c = await ready(t, 'free'); // free plan: 10 AI drafts
    await c.post('/settings', { stale_days: '7' }); // use_ai unchecked => off
    await c.post('/drafts/generate', { limit: '1' });
    assert.equal(claude.calls.length, 0);
    t.app.db.run(`DELETE FROM followups`);

    await c.post('/settings', { stale_days: '7', use_ai: '1' });
    const uid = t.app.db.get('SELECT id FROM users').id;
    const lid = t.app.db.get('SELECT id FROM leads').id;
    for (let i = 0; i < 10; i++) {
      t.app.db.run(`INSERT INTO followups (lead_id, user_id, stage, subject, body, status, ai, created_at) VALUES (?, ?, 0, 's', 'b', 'discarded', 1, ?)`, lid, uid, t.clock.t - 1000);
    }
    await c.post('/drafts/generate', { limit: '1' });
    assert.equal(claude.calls.length, 0, 'quota of 10 AI drafts reached');
    assert.ok(t.app.db.get(`SELECT * FROM followups WHERE status = 'draft'`));
  } finally {
    await t.close();
  }
});

test('manual send (WhatsApp/phone) records the contact without emailing', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Vikram Shah'`).id;
    await c.post(`/leads/${id}/draft`);
    const d = t.app.db.get(`SELECT id FROM followups WHERE lead_id = ?`, id);
    await c.post(`/drafts/${d.id}/manual`, {});
    assert.equal(outbox(t).length, 0);
    const lead = t.app.db.get('SELECT status, last_contact_on FROM leads WHERE id = ?', id);
    assert.equal(lead.status, 'contacted');
    assert.equal(lead.last_contact_on, '2026-10-25');
  } finally {
    await t.close();
  }
});

test('do-not-contact blocks drafting, discards open drafts, and blocks send', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    await c.post(`/leads/${id}/draft`);
    const d = t.app.db.get(`SELECT id FROM followups WHERE lead_id = ?`, id);
    await c.post(`/leads/${id}/dnc`);
    assert.equal(t.app.db.get('SELECT status FROM followups WHERE id = ?', d.id).status, 'discarded');
    await c.post(`/leads/${id}/draft`);
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM followups WHERE lead_id = ? AND status = 'draft'`, id).n, 0);
    await c.post('/drafts/generate', { limit: '10' });
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM followups WHERE lead_id = ?`, id).n, 1, 'bulk generate skips DNC leads');
    assert.equal(outbox(t).length, 0);
  } finally {
    await t.close();
  }
});

test('recovered revenue counts only wins that followed a sent follow-up', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const asha = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    const vik = t.app.db.get(`SELECT id FROM leads WHERE name = 'Vikram Shah'`).id;
    await c.post(`/leads/${asha}/draft`);
    const d = t.app.db.get(`SELECT id FROM followups WHERE lead_id = ?`, asha);
    await c.post(`/drafts/${d.id}/send`, {});
    await c.post(`/leads/${asha}/status`, { status: 'won' });
    await c.post(`/leads/${vik}/status`, { status: 'won' }); // won without us following up
    assert.equal(t.app.db.get('SELECT recovered FROM leads WHERE id = ?', asha).recovered, 1);
    assert.equal(t.app.db.get('SELECT recovered FROM leads WHERE id = ?', vik).recovered, 0);
    const dash = (await c.get('/dashboard')).text;
    assert.match(dash, /Recovered this month/);
    assert.match(dash, /\$250,000/);
    assert.ok(!dash.includes('$300,000'), 'the un-followed win is not counted as recovered');
  } finally {
    await t.close();
  }
});

test('free plan caps leads on import and enforces the monthly email limit', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const rows = Array.from({ length: 30 }, (_, i) => `Lead ${i},l${i}@x.test,,,1000,new,2026-09-01`);
    await c.post('/import', { csv: ['name,email,phone,company,value,status,last_contact', ...rows].join('\n') });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM leads').n, 25);
    // use up the 15-email allowance
    t.app.db.run(`INSERT INTO outbox (user_id, to_email, subject, body, status, created_at) VALUES (1, 'a@b.co', 's', 'b', 'logged', ?)`, t.clock.t);
    for (let i = 0; i < 14; i++) t.app.db.run(`INSERT INTO outbox (user_id, to_email, subject, body, status, created_at) VALUES (1, 'a@b.co', 's', 'b', 'logged', ?)`, t.clock.t);
    const id = t.app.db.get('SELECT id FROM leads LIMIT 1').id;
    await c.post(`/leads/${id}/draft`);
    const d = t.app.db.get('SELECT id FROM followups');
    await c.post(`/drafts/${d.id}/send`, {});
    assert.equal(t.app.db.get(`SELECT status FROM followups WHERE id = ?`, d.id).status, 'draft', 'not sent once the limit is hit');
    assert.equal(outbox(t).length, 15);
  } finally {
    await t.close();
  }
});

test('import dedupes by email and keeps existing history', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/import', { csv: 'name,email,value,status\nAsha R.,ASHA@example.com,300000,replied' });
    const rows = t.app.db.all(`SELECT * FROM leads WHERE email = 'asha@example.com'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 30000000);
    assert.equal(rows[0].status, 'replied');
    assert.equal(rows[0].phone, '9876543210', 'blank import cells do not erase existing data');
  } finally {
    await t.close();
  }
});

test('tenant isolation across leads, drafts and exports', async () => {
  const t = await boot();
  try {
    const a = await ready(t);
    const b = t.client();
    await b.signup('b@example.com');
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    await a.post(`/leads/${id}/draft`);
    const d = t.app.db.get('SELECT id FROM followups');
    assert.equal((await b.get(`/leads/${id}`)).status, 404);
    assert.equal((await b.post(`/leads/${id}/status`, { status: 'lost' })).status, 404);
    assert.equal((await b.post(`/drafts/${d.id}/send`, {})).status, 404);
    assert.equal((await b.post(`/drafts/${d.id}/discard`, {})).status, 404);
    assert.ok(!(await b.get('/leads?filter=all')).text.includes('Asha'));
    assert.ok(!(await b.get('/leads.csv')).text.includes('Asha'));
    assert.ok(!(await b.get('/drafts')).text.includes('Asha'));
  } finally {
    await t.close();
  }
});

test('lead notes with HTML are escaped everywhere they render', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/leads', { name: '<script>alert(1)</script>', company: '"><img src=x>', email: 'x@y.co', value: '10', notes: '<b>notes</b>' });
    const id = t.app.db.get(`SELECT id FROM leads WHERE email = 'x@y.co'`).id;
    for (const path of ['/leads?filter=all', `/leads/${id}`, '/dashboard']) {
      const page = (await c.get(path)).text;
      assert.ok(!page.includes('<script>alert(1)</script>'), path);
      assert.ok(!page.includes('<img src=x>'), path);
    }
  } finally {
    await t.close();
  }
});

test('snoozing hides a lead from the cold list and bulk drafts until the date, then it returns', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const id = t.app.db.get(`SELECT id FROM leads WHERE name = 'Asha Rao'`).id;
    assert.match((await c.get('/dashboard')).text, /Asha Rao/);
    await c.post(`/leads/${id}/snooze`, { days: '14' });
    assert.equal(t.app.db.get('SELECT snoozed_until AS s FROM leads WHERE id = ?', id).s, '2026-11-08');
    assert.ok(!(await c.get('/dashboard')).text.includes('Asha Rao'));
    await c.post('/drafts/generate', { limit: '10' });
    assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM followups WHERE lead_id = ?`, id).n, 0, 'no drafts for snoozed leads');
    assert.match((await c.get(`/leads/${id}`)).text, /Snoozed until 8 Nov 2026/);
    t.clock.t += 15 * 86400000;
    assert.match((await c.get('/dashboard')).text, /Asha Rao/, 'back after the snooze ends');
    await c.post(`/leads/${id}/snooze`, { days: '999' });
    assert.equal(t.app.db.get('SELECT snoozed_until AS s FROM leads WHERE id = ?', id).s, '2026-11-16', 'unknown durations fall back to a week');
    await c.post(`/leads/${id}/unsnooze`);
    assert.equal(t.app.db.get('SELECT snoozed_until AS s FROM leads WHERE id = ?', id).s, null);
    const other = t.client();
    await other.signup('o@example.com');
    assert.equal((await other.post(`/leads/${id}/snooze`, { days: '7' })).status, 404);
  } finally {
    await t.close();
  }
});
