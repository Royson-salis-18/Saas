// Contract / subscription renewal maths. Money is integer minor units; dates are ISO "YYYY-MM-DD".

import { addDays, daysBetween, isISODate, parseAmount, parseCsvObjects, parseDateLoose, toMinor } from '@saas/core';

export const CYCLES = {
  monthly: { label: 'Monthly', months: 1, perYear: 12 },
  quarterly: { label: 'Quarterly', months: 3, perYear: 4 },
  half_yearly: { label: 'Half-yearly', months: 6, perYear: 2 },
  yearly: { label: 'Yearly', months: 12, perYear: 1 },
  two_yearly: { label: 'Every 2 years', months: 24, perYear: 0.5 },
};

const pad = (n) => String(n).padStart(2, '0');

/** Add calendar months, clamping to the end of shorter months (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = m - 1 + n;
  const ny = y + Math.floor(t / 12);
  const nm = ((t % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, dim))}`;
}

export const annualCost = (c) => Math.round(c.amount * (CYCLES[c.cycle]?.perYear ?? 1));
export const noticeDeadline = (c) => addDays(c.renewal_date, -c.notice_days);
export const nextRenewal = (c) => addMonths(c.renewal_date, CYCLES[c.cycle]?.months ?? 12);

/**
 * cancelled | lapsed (renewal date already passed: update it) | locked (cancellation window missed, will renew)
 * | act (decide within 14 days) | soon (renews within 60 days) | ok
 */
export function urgency(c, today) {
  if (c.status === 'cancelled') return 'cancelled';
  if (c.renewal_date < today) return 'lapsed';
  const toDeadline = daysBetween(today, noticeDeadline(c));
  if (toDeadline < 0) return 'locked';
  if (toDeadline <= 14) return 'act';
  if (daysBetween(today, c.renewal_date) <= 60) return 'soon';
  return 'ok';
}

export const REMINDER_LEVELS = (lead) => [...new Set([Math.max(4, lead), 3, 0])].sort((a, b) => b - a);

/**
 * Which reminder level (days before the notice deadline) should fire now, or null. Each level fires once per
 * renewal date, tightest crossed level wins, and nothing is sent once the renewal date has passed.
 */
export function nextReminder(c, today, lead = 14) {
  if (c.status !== 'active' || c.renewal_date < today) return null;
  const toDeadline = daysBetween(today, noticeDeadline(c));
  const crossed = REMINDER_LEVELS(lead).filter((t) => toDeadline <= t);
  if (!crossed.length) return null;
  const tightest = Math.min(...crossed);
  const alerted = c.reminder_for === c.renewal_date && c.reminder_level !== null && c.reminder_level !== undefined ? c.reminder_level : Infinity;
  return alerted <= tightest ? null : tightest;
}

export function summarise(contracts, today) {
  const s = { active: 0, annual: 0, byCategory: {}, act: 0, locked: 0, lapsed: 0, next30: 0, next30Value: 0, cancelledSaving: 0, autoRenewShare: 0 };
  let auto = 0;
  for (const c of contracts) {
    if (c.status === 'cancelled') {
      s.cancelledSaving += annualCost(c);
      continue;
    }
    s.active++;
    const a = annualCost(c);
    s.annual += a;
    const cat = c.category || 'Other';
    s.byCategory[cat] = (s.byCategory[cat] ?? 0) + a;
    if (c.auto_renew) auto += a;
    const u = urgency(c, today);
    if (u === 'act') s.act++;
    if (u === 'locked') s.locked++;
    if (u === 'lapsed') s.lapsed++;
    if (c.renewal_date >= today && daysBetween(today, c.renewal_date) <= 30) {
      s.next30++;
      s.next30Value += c.amount;
    }
  }
  s.autoRenewShare = s.annual ? Math.round((auto / s.annual) * 100) : 0;
  return s;
}

export const CSV_ALIASES = {
  name: ['contract', 'subscription', 'service', 'title', 'item'],
  vendor: ['supplier', 'provider', 'company', 'vendor_name'],
  category: ['type', 'group', 'department'],
  amount: ['cost', 'price', 'fee', 'amount_per_cycle', 'renewal_amount'],
  cycle: ['billing', 'billing_cycle', 'frequency', 'period', 'term'],
  renewal_date: ['renewal', 'renews', 'renews_on', 'next_renewal', 'end_date', 'expiry', 'expires', 'due_date'],
  notice_days: ['notice', 'notice_period', 'cancel_notice', 'notice_period_days'],
  auto_renew: ['autorenew', 'auto_renewal', 'auto_renews', 'automatic'],
};

const CYCLE_ALIASES = { month: 'monthly', monthly: 'monthly', mo: 'monthly', m: 'monthly', quarter: 'quarterly', quarterly: 'quarterly', q: 'quarterly', semiannual: 'half_yearly', 'half-yearly': 'half_yearly', half_yearly: 'half_yearly', 'half yearly': 'half_yearly', year: 'yearly', yearly: 'yearly', annual: 'yearly', annually: 'yearly', y: 'yearly', '2 years': 'two_yearly', biennial: 'two_yearly', two_yearly: 'two_yearly' };
export const normCycle = (v) => CYCLE_ALIASES[String(v ?? '').trim().toLowerCase()] ?? null;
const truthy = (v) => /^(y|yes|true|1|auto|on)$/i.test(String(v ?? '').trim());

export function parseContractCsv(text, { dayFirst = false } = {}) {
  const { rows: raw, missing } = parseCsvObjects(text, { aliases: CSV_ALIASES, required: ['name', 'amount', 'renewal_date'], maxRows: 5000 });
  if (missing.length) return { rows: [], errors: [], missing };
  const rows = [];
  const errors = [];
  raw.forEach((r, i) => {
    const line = i + 2;
    const name = (r.name ?? '').slice(0, 120);
    const amount = parseAmount(r.amount);
    const date = parseDateLoose(r.renewal_date, { dayFirst });
    const cycle = r.cycle ? normCycle(r.cycle) : 'yearly';
    const notice = r.notice_days === undefined || r.notice_days === '' ? 30 : Math.round(parseAmount(r.notice_days));
    if (!name) return errors.push({ line, message: 'Missing name' });
    if (!Number.isFinite(amount) || amount < 0) return errors.push({ line, message: `${name}: amount "${r.amount}" is not a number` });
    if (!date || !isISODate(date)) return errors.push({ line, message: `${name}: could not read renewal date "${r.renewal_date}"` });
    if (!cycle) return errors.push({ line, message: `${name}: billing cycle "${r.cycle}" not recognised (monthly, quarterly, half-yearly, yearly, every 2 years)` });
    if (!Number.isFinite(notice) || notice < 0 || notice > 365) return errors.push({ line, message: `${name}: notice period must be 0–365 days` });
    rows.push({ name, vendor: (r.vendor ?? '').slice(0, 100), category: (r.category ?? '').slice(0, 50), amount: toMinor(amount), cycle, renewal_date: date, notice_days: notice, auto_renew: r.auto_renew === undefined || r.auto_renew === '' ? 1 : truthy(r.auto_renew) ? 1 : 0 });
  });
  return { rows, errors, missing: [] };
}
