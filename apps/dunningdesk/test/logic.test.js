import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, agingBuckets, nextStage, parseInvoiceCsv, renderReminder, reminderVars, summarize, topDebtors } from '../src/logic.js';

const inv = (over = {}) => ({
  number: 'INV-1', client_name: 'Acme', amount: 100000, currency: 'USD', due_date: '2026-10-10', status: 'open',
  reminders_paused: 0, last_stage: null, last_reminder_at: null, claimed_paid_at: null, ...over,
});
const stageKey = (i) => (i === null ? null : STAGES[i].key);
const NOW = Date.UTC(2026, 9, 25);

test('nothing is sent long before the due date', () => {
  assert.equal(nextStage(inv(), '2026-10-01'), null);
});

test('heads-up goes out 3 days before due, due-notice on the day', () => {
  assert.equal(stageKey(nextStage(inv(), '2026-10-07')), 'pre_due');
  assert.equal(stageKey(nextStage(inv({ last_stage: 0, last_reminder_at: NOW - 5 * 86400000 }), '2026-10-10', undefined, { nowMs: NOW })), 'due');
});

test('late invoices escalate through the stages in order', () => {
  let last = null;
  const seen = [];
  let nowMs = NOW;
  for (const today of ['2026-10-13', '2026-10-17', '2026-10-24', '2026-11-09']) {
    const s = nextStage(inv({ last_stage: last, last_reminder_at: last === null ? null : nowMs - 5 * 86400000 }), today, undefined, { nowMs });
    seen.push(stageKey(s));
    last = s;
  }
  assert.deepEqual(seen, ['late_3', 'late_7', 'late_14', 'late_30']);
});

test('an invoice imported very late gets ONE polite email, not six', () => {
  const i = inv({ due_date: '2026-08-01' }); // ~85 days late
  const first = nextStage(i, '2026-10-25', undefined, { nowMs: NOW });
  assert.equal(stageKey(first), 'late_3', 'first contact is capped at the gentle reminder');
  // after sending, the minimum gap prevents an immediate escalation
  const after = { ...i, last_stage: first, last_reminder_at: NOW };
  assert.equal(nextStage(after, '2026-10-25', undefined, { nowMs: NOW + 3600e3 }), null);
  assert.equal(nextStage(after, '2026-10-26', undefined, { nowMs: NOW + 86400e3 }), null);
  assert.equal(stageKey(nextStage(after, '2026-10-30', undefined, { nowMs: NOW + 5 * 86400e3 })), 'late_30');
});

test('the same stage is never sent twice', () => {
  const i = inv({ last_stage: 2, last_reminder_at: NOW - 10 * 86400000 });
  assert.equal(nextStage(i, '2026-10-14', undefined, { nowMs: NOW }), null);
});

test('paid, void, paused, and client-claimed-paid invoices are left alone', () => {
  for (const over of [{ status: 'paid' }, { status: 'void' }, { reminders_paused: 1 }, { claimed_paid_at: 1 }]) {
    assert.equal(nextStage(inv({ ...over, due_date: '2026-09-01' }), '2026-10-25'), null);
  }
});

test('disabled stages are skipped', () => {
  const enabled = ['late_14'];
  assert.equal(nextStage(inv(), '2026-10-13', enabled), null);
  assert.equal(stageKey(nextStage(inv(), '2026-10-24', enabled)), 'late_14');
});

test('every stage renders a complete, well-formed email', () => {
  const vars = reminderVars({
    inv: inv({ pay_link: 'https://pay.example/x' }),
    today: '2026-10-25',
    settings: { business_name: 'Studio X', payment_instructions: 'UPI: studio@bank', late_fee_note: 'Late fee: 1.5%/month', signoff: '' },
    user: { name: 'Owner' },
    payUrl: 'https://app.example/pay/tok',
  });
  STAGES.forEach((s, i) => {
    const { subject, body } = renderReminder(i, vars);
    assert.ok(subject.includes('INV-1'), `${s.key} subject mentions invoice`);
    assert.ok(body.includes('$1,000'), `${s.key} mentions amount`);
    assert.ok(body.includes('https://app.example/pay/tok'));
    assert.ok(body.includes('https://pay.example/x'));
    assert.ok(body.includes('UPI: studio@bank'));
    assert.ok(body.trim().endsWith('Studio X'));
    assert.ok(!/undefined|null|\{/.test(subject + body), `${s.key} has no unrendered placeholders`);
    assert.equal(body.includes('Late fee'), i >= 2, `${s.key} late-fee note only on overdue stages`);
  });
});

test('aging buckets split by lateness and currency', () => {
  const today = '2026-10-25';
  const list = [
    inv({ due_date: '2026-11-01', amount: 100 }),
    inv({ due_date: '2026-10-20', amount: 200 }),
    inv({ due_date: '2026-09-10', amount: 400 }),
    inv({ due_date: '2026-08-01', amount: 800 }),
    inv({ due_date: '2026-06-01', amount: 1600 }),
    inv({ due_date: '2026-06-01', amount: 999, status: 'paid' }),
    inv({ due_date: '2026-10-01', amount: 5000, currency: 'INR' }),
  ];
  const a = agingBuckets(list, today);
  assert.deepEqual(a.USD.current, { n: 1, total: 100 });
  assert.deepEqual(a.USD.d1_30, { n: 1, total: 200 });
  assert.deepEqual(a.USD.d31_60, { n: 1, total: 400 });
  assert.deepEqual(a.USD.d61_90, { n: 1, total: 800 });
  assert.deepEqual(a.USD.d90, { n: 1, total: 1600 });
  assert.equal(a.USD.all.total, 3100);
  assert.equal(a.INR.d1_30.total, 5000);
});

test('summary reports outstanding, overdue, collected and recovery numbers', () => {
  const today = '2026-10-25';
  const s = summarize(
    [
      inv({ due_date: '2026-10-20', amount: 200 }),
      inv({ due_date: '2026-10-28', amount: 300 }),
      inv({ status: 'paid', due_date: '2026-10-10', paid_on: '2026-10-15', amount: 500, paid_after_reminder: 1 }),
      inv({ status: 'paid', due_date: '2026-09-10', paid_on: '2026-09-09', amount: 700 }),
    ],
    today,
  ).USD;
  assert.equal(s.outstanding, 500);
  assert.equal(s.overdue, 200);
  assert.equal(s.overdueCount, 1);
  assert.equal(s.dueSoon, 300);
  assert.equal(s.collectedMonth, 500);
  assert.equal(s.collectedAfterReminder, 500);
  assert.equal(s.avgDelay, 3, 'mean of 5 days late and 0 (paid early counts as 0)');
});

test('top debtors are grouped by client and sorted', () => {
  const rows = topDebtors(
    [inv({ client_name: 'A', amount: 100, due_date: '2026-10-01' }), inv({ client_name: 'a', amount: 150, due_date: '2026-09-01' }), inv({ client_name: 'B', amount: 200, due_date: '2026-10-01' })],
    '2026-10-25',
  );
  assert.equal(rows[0].client, 'A');
  assert.equal(rows[0].total, 250);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].oldest, 54);
});

test('csv import understands common accounting export headers and formats', () => {
  const csv = [
    'Invoice No,Customer Name,Email Address,Balance Due,Due On,Invoice Date,Currency',
    'A-1,"Sharma & Sons",accounts@sharma.in,"₹1,23,456.50",30/10/2026,01/10/2026,INR',
    'A-2,Beta Corp,not-an-email,$900,2026-11-05,,USD',
    'A-3,,x@y.co,100,2026-11-05,,USD',
    'A-4,Gamma,g@g.co,abc,2026-11-05,,USD',
    'A-5,Delta,d@d.co,100,someday,,USD',
    'A-1,Dup,d@d.co,100,2026-11-05,,USD',
  ].join('\n');
  const r = parseInvoiceCsv(csv, { dayFirst: true });
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], {
    number: 'A-1', client_name: 'Sharma & Sons', client_email: 'accounts@sharma.in', amount: 12345650, currency: 'INR',
    issue_date: '2026-10-01', due_date: '2026-10-30', pay_link: '', paid: false,
  });
  assert.equal(r.rows[1].client_email, '', 'invalid email is dropped, not stored');
  assert.deepEqual(r.errors.map((e) => e.line), [4, 5, 6, 7]);
  assert.match(r.errors[1].message, /not a positive number/);
  assert.match(r.errors[3].message, /duplicate/);
});

test('csv import reports missing required columns', () => {
  const r = parseInvoiceCsv('invoice,client\nA,B');
  assert.deepEqual(r.missing.sort(), ['amount', 'due_date']);
  assert.equal(r.rows.length, 0);
});

test('a promise to pay pauses reminders through the promised day only', () => {
  const i = inv({ due_date: '2026-10-01', promise_date: '2026-10-30' });
  assert.equal(nextStage(i, '2026-10-25', undefined, { nowMs: NOW }), null);
  assert.equal(nextStage(i, '2026-10-30', undefined, { nowMs: NOW }), null);
  assert.equal(stageKey(nextStage(i, '2026-10-31', undefined, { nowMs: NOW })), 'late_3');
});
