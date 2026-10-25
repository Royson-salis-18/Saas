// Pure collection logic: when to chase an invoice, what to say, how to report on it.

import { daysBetween, formatDate, formatMoney, isEmail, isISODate, parseAmount, parseCsvObjects, parseDateLoose, toMinor } from '@saas/core';

export const STAGES = [
  { key: 'pre_due', offset: -3, label: 'Heads-up, 3 days before due' },
  { key: 'due', offset: 0, label: 'Due today' },
  { key: 'late_3', offset: 3, label: 'Gentle reminder, 3 days late' },
  { key: 'late_7', offset: 7, label: 'Firm reminder, 7 days late' },
  { key: 'late_14', offset: 14, label: 'Final notice, 14 days late' },
  { key: 'late_30', offset: 30, label: 'Escalation, 30 days late' },
];
export const DEFAULT_STAGES = STAGES.map((s) => s.key);
const FIRST_CONTACT_MAX_OFFSET = 3; // the first email an invoice ever gets is never harsher than this stage

export const daysOverdue = (inv, today) => daysBetween(inv.due_date, today);

/** paid | void | overdue | due_today | upcoming */
export function statusOf(inv, today) {
  if (inv.status === 'paid' || inv.status === 'void') return inv.status;
  const late = daysOverdue(inv, today);
  return late > 0 ? 'overdue' : late === 0 ? 'due_today' : 'upcoming';
}

/**
 * Which stage (index into STAGES) should be sent for this invoice right now, or null.
 *  - Only the most recent applicable stage is sent: an invoice imported 40 days late
 *    does not get six emails in a row.
 *  - The first email is capped at a polite tone no matter how late the invoice is.
 *  - A minimum gap between emails prevents rapid escalation.
 */
export function nextStage(inv, today, enabledKeys = DEFAULT_STAGES, { nowMs = Date.now(), minGapDays = 4 } = {}) {
  if (inv.status !== 'open' || inv.reminders_paused || inv.claimed_paid_at) return null;
  const late = daysOverdue(inv, today);
  let pick = -1;
  STAGES.forEach((s, i) => {
    if (enabledKeys.includes(s.key) && s.offset <= late) pick = i;
  });
  if (pick < 0) return null;
  const previous = inv.last_stage ?? -1;
  if (previous < 0) {
    let cap = -1;
    STAGES.forEach((s, i) => {
      if (enabledKeys.includes(s.key) && s.offset <= FIRST_CONTACT_MAX_OFFSET) cap = i;
    });
    if (cap >= 0 && pick > cap) pick = cap;
  }
  if (pick <= previous) return null;
  if (inv.last_reminder_at && nowMs - inv.last_reminder_at < minGapDays * 86400000) return null;
  return pick;
}

export function reminderVars({ inv, today, settings, user, payUrl }) {
  const late = Math.max(0, daysOverdue(inv, today));
  return {
    client: inv.client_name,
    number: inv.number,
    amount: formatMoney(inv.amount, inv.currency),
    due_date: formatDate(inv.due_date),
    days: late,
    business: settings.business_name || user.name,
    signoff: settings.signoff || settings.business_name || user.name,
    pay_url: payUrl,
    pay_link: inv.pay_link,
    instructions: settings.payment_instructions,
    late_fee: settings.late_fee_note,
  };
}

function footer(v, { late }) {
  const lines = [];
  if (v.pay_link) lines.push(`Pay online: ${v.pay_link}`);
  lines.push(`Invoice details: ${v.pay_url}`);
  if (v.instructions) lines.push('', 'Payment details:', v.instructions);
  if (late && v.late_fee) lines.push('', v.late_fee);
  lines.push('', 'If you have already paid, thank you — please ignore this message or use the “I’ve already paid” button on the invoice page.', '', v.signoff);
  return lines.join('\n');
}

const TEMPLATES = {
  pre_due: (v) => ({
    subject: `Invoice ${v.number} is due on ${v.due_date}`,
    body: `Hi ${v.client},\n\nA quick heads-up that invoice ${v.number} for ${v.amount} is due on ${v.due_date}.\n\n${footer(v, { late: false })}`,
  }),
  due: (v) => ({
    subject: `Invoice ${v.number} is due today`,
    body: `Hi ${v.client},\n\nInvoice ${v.number} for ${v.amount} is due today (${v.due_date}).\n\nThank you for your business.\n\n${footer(v, { late: false })}`,
  }),
  late_3: (v) => ({
    subject: `Reminder: invoice ${v.number} was due ${v.due_date}`,
    body: `Hi ${v.client},\n\nThis is a friendly reminder that invoice ${v.number} for ${v.amount} was due on ${v.due_date} and we haven't received payment yet.\n\nCould you let me know when to expect it?\n\n${footer(v, { late: true })}`,
  }),
  late_7: (v) => ({
    subject: `Overdue: invoice ${v.number} (${v.amount}) — please confirm payment date`,
    body: `Hi ${v.client},\n\nInvoice ${v.number} for ${v.amount} is now ${v.days} days overdue (due ${v.due_date}).\n\nPlease arrange payment this week, or reply with the date we can expect it. If something is holding it up, tell me and I'll help sort it out.\n\n${footer(v, { late: true })}`,
  }),
  late_14: (v) => ({
    subject: `Final notice: invoice ${v.number} is ${v.days} days overdue`,
    body: `Hi ${v.client},\n\nDespite earlier reminders, invoice ${v.number} for ${v.amount} remains unpaid, ${v.days} days after its due date of ${v.due_date}.\n\nPlease settle it within the next 5 days, or reply today to agree a payment plan.\n\n${footer(v, { late: true })}`,
  }),
  late_30: (v) => ({
    subject: `Action needed: invoice ${v.number} is ${v.days} days overdue`,
    body: `Hi ${v.client},\n\nInvoice ${v.number} for ${v.amount} is now ${v.days} days overdue and our earlier messages have not been answered.\n\nUnless we hear from you in the next few days, we will have to pause further work and escalate this to our accounts team. I'd much rather resolve it directly — please reply today.\n\n${footer(v, { late: true })}`,
  }),
};

export function renderReminder(stageIdx, vars) {
  return TEMPLATES[STAGES[stageIdx].key](vars);
}

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90'];
export const BUCKET_LABELS = { current: 'Not yet due', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90: '90+ days' };

/** Receivables aging per currency: { USD: { current: {n,total}, ..., total } } (minor units). */
export function agingBuckets(invoices, today) {
  const out = {};
  for (const inv of invoices) {
    if (inv.status !== 'open') continue;
    const cur = (out[inv.currency] ??= Object.fromEntries([...BUCKETS.map((b) => [b, { n: 0, total: 0 }]), ['all', { n: 0, total: 0 }]]));
    const late = daysOverdue(inv, today);
    const key = late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90';
    for (const k of [key, 'all']) {
      cur[k].n++;
      cur[k].total += inv.amount;
    }
  }
  return out;
}

/** Headline numbers per currency (minor units). */
export function summarize(invoices, today) {
  const month = today.slice(0, 7);
  const out = {};
  for (const inv of invoices) {
    const s = (out[inv.currency] ??= { outstanding: 0, overdue: 0, overdueCount: 0, dueSoon: 0, collectedMonth: 0, collectedAfterReminder: 0, delays: [] });
    if (inv.status === 'open') {
      s.outstanding += inv.amount;
      const late = daysOverdue(inv, today);
      if (late > 0) {
        s.overdue += inv.amount;
        s.overdueCount++;
      } else if (late >= -7) s.dueSoon += inv.amount;
    } else if (inv.status === 'paid' && inv.paid_on) {
      if (inv.paid_on.startsWith(month)) s.collectedMonth += inv.amount;
      if (inv.paid_after_reminder) s.collectedAfterReminder += inv.amount;
      if (daysBetween(inv.paid_on, today) <= 90) s.delays.push(Math.max(0, daysBetween(inv.due_date, inv.paid_on)));
    }
  }
  for (const s of Object.values(out)) {
    s.avgDelay = s.delays.length ? Math.round(s.delays.reduce((a, b) => a + b, 0) / s.delays.length) : null;
    delete s.delays;
  }
  return out;
}

/** Group overdue open invoices by client, biggest debtor first. */
export function topDebtors(invoices, today, limit = 8) {
  const m = new Map();
  for (const inv of invoices) {
    if (inv.status !== 'open' || daysOverdue(inv, today) <= 0) continue;
    const k = `${inv.client_name.toLowerCase()}|${inv.currency}`;
    const e = m.get(k) ?? { client: inv.client_name, currency: inv.currency, total: 0, count: 0, oldest: 0 };
    e.total += inv.amount;
    e.count++;
    e.oldest = Math.max(e.oldest, daysOverdue(inv, today));
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

export const CSV_ALIASES = {
  number: ['invoice', 'invoice_no', 'invoice_number', 'inv', 'inv_no', 'bill_no', 'invoice_id'],
  client: ['client_name', 'customer', 'customer_name', 'party', 'name', 'bill_to', 'company'],
  email: ['client_email', 'customer_email', 'email_address', 'e_mail'],
  amount: ['total', 'amount_due', 'balance', 'outstanding', 'invoice_amount', 'amount_outstanding', 'balance_due'],
  currency: ['ccy', 'cur'],
  due_date: ['due', 'due_on', 'payment_due', 'payment_due_date', 'duedate'],
  issue_date: ['date', 'invoice_date', 'issued', 'issued_on', 'issue'],
  link: ['pay_link', 'payment_link', 'pay_url'],
  status: ['state', 'payment_status'],
};

/**
 * Turn pasted CSV into validated invoice records.
 * Returns { rows: [...], errors: [{ line, message }], missing: [...columns] }.
 */
export function parseInvoiceCsv(text, { dayFirst = false, defaultCurrency = 'USD' } = {}) {
  const { rows: raw, missing } = parseCsvObjects(text, { aliases: CSV_ALIASES, required: ['number', 'client', 'amount', 'due_date'], maxRows: 5000 });
  if (missing.length) return { rows: [], errors: [], missing };
  const rows = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const line = i + 2;
    const number = (r.number ?? '').slice(0, 60);
    const amount = parseAmount(r.amount);
    const due = parseDateLoose(r.due_date, { dayFirst });
    const issue = r.issue_date ? parseDateLoose(r.issue_date, { dayFirst }) : null;
    if (!number) return errors.push({ line, message: 'Missing invoice number' });
    if (!r.client) return errors.push({ line, message: `Invoice ${number}: missing client name` });
    if (!Number.isFinite(amount) || amount <= 0) return errors.push({ line, message: `Invoice ${number}: amount "${r.amount}" is not a positive number` });
    if (!due) return errors.push({ line, message: `Invoice ${number}: could not read due date "${r.due_date}"` });
    if (seen.has(number.toLowerCase())) return errors.push({ line, message: `Invoice ${number}: duplicate number in this file` });
    seen.add(number.toLowerCase());
    const email = (r.email ?? '').toLowerCase();
    const currency = /^[A-Za-z]{3}$/.test(r.currency ?? '') ? r.currency.toUpperCase() : defaultCurrency;
    rows.push({
      number,
      client_name: r.client.slice(0, 120),
      client_email: isEmail(email) ? email : '',
      amount: toMinor(amount),
      currency,
      issue_date: issue && isISODate(issue) ? issue : null,
      due_date: due,
      pay_link: /^https?:\/\//i.test(r.link ?? '') ? r.link.slice(0, 500) : '',
      paid: /^(paid|closed|settled)$/i.test(r.status ?? ''),
    });
  });
  return { rows, errors, missing: [] };
}
