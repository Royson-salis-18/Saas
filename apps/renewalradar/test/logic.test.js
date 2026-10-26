import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, annualCost, nextRenewal, nextReminder, noticeDeadline, parseContractCsv, summarise, urgency, normCycle } from '../src/logic.js';

const c = (o = {}) => ({ name: 'CRM', amount: 120000, cycle: 'yearly', renewal_date: '2026-12-31', notice_days: 30, auto_renew: 1, status: 'active', category: 'Software', reminder_for: null, reminder_level: null, ...o });

test('adding months clamps to the end of shorter months and crosses years', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(addMonths('2026-12-31', 12), '2027-12-31');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-05-10', 24), '2028-05-10');
});

test('annual cost and renewal dates follow the billing cycle', () => {
  assert.equal(annualCost(c({ amount: 1000, cycle: 'monthly' })), 12000);
  assert.equal(annualCost(c({ amount: 1000, cycle: 'quarterly' })), 4000);
  assert.equal(annualCost(c({ amount: 1000, cycle: 'half_yearly' })), 2000);
  assert.equal(annualCost(c({ amount: 1000, cycle: 'two_yearly' })), 500);
  assert.equal(nextRenewal(c({ renewal_date: '2026-11-30', cycle: 'monthly' })), '2026-12-30');
  assert.equal(nextRenewal(c({ renewal_date: '2026-12-31', cycle: 'yearly' })), '2027-12-31');
  assert.equal(noticeDeadline(c()), '2026-12-01');
});

test('urgency ladder', () => {
  const today = '2026-10-25';
  assert.equal(urgency(c({ status: 'cancelled' }), today), 'cancelled');
  assert.equal(urgency(c({ renewal_date: '2026-10-01' }), today), 'lapsed');
  assert.equal(urgency(c({ renewal_date: '2026-11-10', notice_days: 30 }), today), 'locked', 'notice window already missed');
  assert.equal(urgency(c({ renewal_date: '2026-12-05', notice_days: 30 }), today), 'act', 'deadline 5 Nov is 11 days away');
  assert.equal(urgency(c({ renewal_date: '2026-12-20', notice_days: 20 }), today), 'soon', 'renews in 56 days, deadline 36 days away');
  assert.equal(urgency(c({ renewal_date: '2026-12-31', notice_days: 30 }), today), 'ok', 'renews in 67 days');
  assert.equal(urgency(c({ renewal_date: '2027-06-01' }), today), 'ok');
  assert.equal(urgency(c({ renewal_date: '2026-10-25', notice_days: 0 }), today), 'act', 'renews today with no notice period');
});

test('reminders fire once per level, tightest first, and reset for the next renewal', () => {
  const k = c({ renewal_date: '2026-12-31', notice_days: 30 }); // deadline 2026-12-01
  assert.equal(nextReminder(k, '2026-11-10', 14), null);
  assert.equal(nextReminder(k, '2026-11-17', 14), 14);
  assert.equal(nextReminder({ ...k, reminder_for: k.renewal_date, reminder_level: 14 }, '2026-11-20', 14), null, 'already told at 14');
  assert.equal(nextReminder({ ...k, reminder_for: k.renewal_date, reminder_level: 14 }, '2026-11-28', 14), 3);
  assert.equal(nextReminder({ ...k, reminder_for: k.renewal_date, reminder_level: 3 }, '2026-12-01', 14), 0, 'on the deadline day');
  assert.equal(nextReminder({ ...k, reminder_for: k.renewal_date, reminder_level: 0 }, '2026-12-10', 14), null);
  assert.equal(nextReminder(k, '2026-12-01', 14), 0, 'a late-added contract jumps straight to the tightest level');
  assert.equal(nextReminder({ ...k, reminder_for: '2025-12-31', reminder_level: 0 }, '2026-11-17', 14), 14, 'a new renewal date resets the history');
  assert.equal(nextReminder(k, '2027-01-02', 14), null, 'nothing after the renewal date');
  assert.equal(nextReminder(c({ status: 'cancelled' }), '2026-11-30', 14), null);
});

test('summary: annual commitment by category, urgency counts, savings from cancellations', () => {
  const today = '2026-10-25';
  const s = summarise([
    c({ name: 'A', amount: 1000, cycle: 'monthly', category: 'Software', renewal_date: '2026-11-05', notice_days: 30, auto_renew: 1 }),
    c({ name: 'B', amount: 50000, cycle: 'yearly', category: 'Insurance', renewal_date: '2026-11-20', notice_days: 12, auto_renew: 0 }),
    c({ name: 'C', amount: 2000, cycle: 'quarterly', category: '', renewal_date: '2027-03-01' }),
    c({ name: 'D', amount: 900, cycle: 'monthly', status: 'cancelled' }),
    c({ name: 'E', amount: 100, renewal_date: '2026-09-01' }),
  ], today);
  assert.equal(s.active, 4);
  assert.equal(s.annual, 12000 + 50000 + 8000 + 100);
  assert.deepEqual(s.byCategory, { Software: 12100, Insurance: 50000, Other: 8000 });
  assert.equal(s.locked, 1, 'A: deadline passed');
  assert.equal(s.act, 1, 'B');
  assert.equal(s.lapsed, 1, 'E');
  assert.equal(s.next30, 2);
  assert.equal(s.next30Value, 1000 + 50000);
  assert.equal(s.cancelledSaving, 10800);
  assert.equal(s.autoRenewShare, Math.round(((12000 + 8000 + 100) / s.annual) * 100));
});

test('contract csv: aliases, cycles, date formats, auto-renew, errors', () => {
  const csv = ['Subscription,Provider,Cost,Billing,Renews On,Notice,Auto Renew,Type', 'Zoho CRM,Zoho,"₹12,000",Annual,15/03/2027,30,Yes,Software', 'Office lease,Landlord,45000,monthly,2027-01-01,90,no,Rent', 'Mystery,X,10,fortnightly,2027-01-01,,,', 'Bad date,X,10,yearly,soon,,,', 'Neg,X,abc,yearly,2027-01-01,,,', ',X,10,yearly,2027-01-01,,,', 'Long notice,X,10,yearly,2027-01-01,999,,'].join('\n');
  const r = parseContractCsv(csv, { dayFirst: true });
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { name: 'Zoho CRM', vendor: 'Zoho', category: 'Software', amount: 1200000, cycle: 'yearly', renewal_date: '2027-03-15', notice_days: 30, auto_renew: 1 });
  assert.equal(r.rows[1].auto_renew, 0);
  assert.equal(r.errors.length, 5);
  assert.deepEqual(parseContractCsv('name,cost\nA,1').missing, ['renewal_date']);
  assert.equal(normCycle('Annually'), 'yearly');
  assert.equal(normCycle('weekly'), null);
});
