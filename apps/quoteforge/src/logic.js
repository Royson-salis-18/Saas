// Quote maths and helpers. All money is integer minor units (paise / cents).

import { daysBetween, parseAmount, toMinor } from '@saas/core';

export const TAX_MODES = [
  ['none', 'No tax'],
  ['gst_intra', 'GST — same state (CGST + SGST)'],
  ['gst_inter', 'GST — other state (IGST)'],
  ['sales_tax', 'Sales tax'],
  ['vat', 'VAT'],
];

const lineAmount = (qty, unitPrice) => Math.round((Math.round(qty * 1000) * unitPrice) / 1000);
const pctOf = (amount, percent) => Math.round((amount * Math.round(percent * 100)) / 10000);

/**
 * items: [{ qty, unit_price }]; opts: { discountType: 'percent'|'amount', discountValue (percent, or
 * minor units for 'amount'), taxMode, taxRate (percent) }.
 * Returns { lines, subtotal, discount, taxable, taxes: [{label, rate, amount}], taxTotal, total }.
 */
export function computeTotals(items, { discountType = 'amount', discountValue = 0, taxMode = 'none', taxRate = 0 } = {}) {
  const lines = items.map((i) => lineAmount(i.qty, i.unit_price));
  const subtotal = lines.reduce((a, b) => a + b, 0);
  let discount = 0;
  if (discountType === 'percent') discount = pctOf(subtotal, Math.min(100, Math.max(0, discountValue)));
  else discount = Math.min(subtotal, Math.max(0, Math.round(discountValue)));
  const taxable = subtotal - discount;
  const rate = Math.max(0, Math.min(100, Number(taxRate) || 0));
  const taxes = [];
  if (taxMode === 'gst_intra') {
    const half = rate / 2;
    taxes.push({ label: 'CGST', rate: half, amount: pctOf(taxable, half) }, { label: 'SGST', rate: half, amount: pctOf(taxable, half) });
  } else if (taxMode === 'gst_inter') {
    taxes.push({ label: 'IGST', rate, amount: pctOf(taxable, rate) });
  } else if (taxMode === 'sales_tax') {
    taxes.push({ label: 'Sales tax', rate, amount: pctOf(taxable, rate) });
  } else if (taxMode === 'vat') {
    taxes.push({ label: 'VAT', rate, amount: pctOf(taxable, rate) });
  }
  const taxTotal = taxes.reduce((a, t) => a + t.amount, 0);
  return { lines, subtotal, discount, taxable, taxes, taxTotal, total: taxable + taxTotal };
}

/** Effective display status: sent/viewed quotes past their validity date read as expired. */
export function effectiveStatus(q, today) {
  if (['sent', 'viewed'].includes(q.status) && q.valid_until && q.valid_until < today) return 'expired';
  return q.status;
}

export const formatQuoteNumber = (prefix, n, revision = 1) => `${prefix}${String(n).padStart(4, '0')}${revision > 1 ? `-R${revision}` : ''}`;

/** Parse repeated line-item fields from a form body. Returns { items, error }. */
export function parseItems(body, toArray) {
  const desc = toArray(body.desc);
  const qty = toArray(body.qty);
  const unit = toArray(body.unit);
  const price = toArray(body.price);
  const items = [];
  for (let i = 0; i < desc.length && i < 100; i++) {
    const d = String(desc[i] ?? '').trim().slice(0, 500);
    const rawPrice = String(price[i] ?? '').trim();
    const rawQty = String(qty[i] ?? '').trim();
    if (!d && !rawPrice) continue; // blank row
    if (!d) return { items: [], error: `Line ${i + 1} needs a description.` };
    const q = rawQty === '' ? 1 : parseAmount(rawQty);
    const p = rawPrice === '' ? 0 : parseAmount(rawPrice);
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000) return { items: [], error: `Line ${i + 1}: quantity must be greater than zero.` };
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) return { items: [], error: `Line ${i + 1}: price must be zero or more.` };
    items.push({ description: d, qty: Math.round(q * 1000) / 1000, unit: String(unit[i] ?? '').trim().slice(0, 20), unit_price: toMinor(p) });
  }
  if (!items.length) return { items: [], error: 'Add at least one line item.' };
  return { items, error: '' };
}

/** Pipeline analytics. Quotes: { status, total, currency, valid_until, responded_at, sent_at }. */
export function pipelineStats(quotes, today, nowMs) {
  const out = {};
  const monthStart = today.slice(0, 7);
  const cutoff = nowMs - 90 * 86400000;
  for (const q of quotes) {
    const s = (out[q.currency] ??= { pipeline: 0, awaiting: 0, acceptedMonth: 0, acceptedMonthN: 0, won: 0, lost: 0 });
    const st = effectiveStatus(q, today);
    if (st === 'sent' || st === 'viewed') {
      s.pipeline += q.total;
      s.awaiting++;
    }
    if (st === 'accepted' && q.responded_at && new Date(q.responded_at).toISOString().startsWith(monthStart)) {
      s.acceptedMonth += q.total;
      s.acceptedMonthN++;
    }
    const decidedAt = q.responded_at ?? q.sent_at ?? 0;
    if (decidedAt >= cutoff || st === 'expired') {
      if (st === 'accepted') s.won++;
      else if (st === 'declined' || st === 'expired') s.lost++;
    }
  }
  for (const s of Object.values(out)) s.rate = s.won + s.lost ? Math.round((s.won / (s.won + s.lost)) * 100) : null;
  return out;
}

export const needsFollowUp = (q, today, nowMs, days = 3) =>
  ['sent', 'viewed'].includes(q.status) && !(q.valid_until && q.valid_until < today) && q.sent_at && nowMs - q.sent_at >= days * 86400000 && !q.followed_up_at;

export { daysBetween };
