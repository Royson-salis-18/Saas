import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, effectiveStatus, formatQuoteNumber, needsFollowUp, parseItems, pipelineStats } from '../src/logic.js';

const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const ITEMS = [
  { qty: 3, unit_price: 150000 }, // 3 x 1,500.00
  { qty: 1, unit_price: 249999 }, // 1 x 2,499.99
];

test('GST same-state: discount, then CGST + SGST on the discounted amount, exact to the paisa', () => {
  const t = computeTotals(ITEMS, { discountType: 'percent', discountValue: 10, taxMode: 'gst_intra', taxRate: 18 });
  assert.equal(t.subtotal, 699999);
  assert.equal(t.discount, 70000);
  assert.equal(t.taxable, 629999);
  assert.deepEqual(t.taxes.map((x) => [x.label, x.rate, x.amount]), [['CGST', 9, 56700], ['SGST', 9, 56700]]);
  assert.equal(t.taxTotal, 113400);
  assert.equal(t.total, 743399);
});

test('GST other-state is a single IGST line with the same total', () => {
  const intra = computeTotals(ITEMS, { discountType: 'percent', discountValue: 10, taxMode: 'gst_intra', taxRate: 18 });
  const inter = computeTotals(ITEMS, { discountType: 'percent', discountValue: 10, taxMode: 'gst_inter', taxRate: 18 });
  assert.deepEqual(inter.taxes.map((x) => x.label), ['IGST']);
  assert.equal(inter.taxes[0].amount, 113400);
  assert.equal(inter.total, intra.total);
});

test('sales tax, VAT, no tax; fractional rates', () => {
  const base = [{ qty: 1, unit_price: 10000 }];
  assert.equal(computeTotals(base, { taxMode: 'sales_tax', taxRate: 8.25 }).total, 10825);
  assert.equal(computeTotals(base, { taxMode: 'vat', taxRate: 20 }).taxes[0].label, 'VAT');
  assert.equal(computeTotals(base, { taxMode: 'none', taxRate: 18 }).total, 10000, 'rate ignored when tax is off');
  assert.equal(computeTotals(base, { taxMode: 'gst_intra', taxRate: 5 }).taxes[0].rate, 2.5);
});

test('quantities may be fractional and are rounded to the minor unit', () => {
  assert.deepEqual(computeTotals([{ qty: 2.5, unit_price: 3333 }]).lines, [8333]);
  assert.deepEqual(computeTotals([{ qty: 0.333, unit_price: 100 }]).lines, [33]);
  assert.equal(computeTotals([{ qty: 1, unit_price: 0.1 * 100 }, { qty: 1, unit_price: 0.2 * 100 }]).subtotal, 30, 'no float drift');
});

test('discounts are clamped: never negative totals, never above 100%', () => {
  assert.equal(computeTotals(ITEMS, { discountType: 'amount', discountValue: 99_999_999 }).total, 0);
  assert.equal(computeTotals(ITEMS, { discountType: 'percent', discountValue: 250 }).total, 0);
  assert.equal(computeTotals(ITEMS, { discountType: 'percent', discountValue: -10 }).discount, 0);
  assert.equal(computeTotals(ITEMS, { discountType: 'amount', discountValue: 1000 }).discount, 1000);
  assert.equal(computeTotals([], {}).total, 0);
  assert.equal(computeTotals(ITEMS, { taxMode: 'vat', taxRate: 500 }).taxes[0].rate, 100, 'rate capped');
});

test('line items parse from repeated form fields; blank rows are skipped; bad rows explain themselves', () => {
  const ok = parseItems({ desc: ['Tiles', '', 'Labour'], qty: ['10', '', '2.5'], unit: ['sqft', '', 'hrs'], price: ['₹1,250.50', '', '40'] }, toArray);
  assert.deepEqual(ok.items, [
    { description: 'Tiles', qty: 10, unit: 'sqft', unit_price: 125050 },
    { description: 'Labour', qty: 2.5, unit: 'hrs', unit_price: 4000 },
  ]);
  assert.equal(parseItems({ desc: ['', ''], qty: ['', ''], price: ['', ''] }, toArray).error, 'Add at least one line item.');
  assert.match(parseItems({ desc: ['A'], qty: ['0'], price: ['5'] }, toArray).error, /Line 1: quantity/);
  assert.match(parseItems({ desc: ['A'], qty: ['1'], price: ['-5'] }, toArray).error, /Line 1: price/);
  assert.match(parseItems({ desc: ['A'], qty: ['1'], price: ['abc'] }, toArray).error, /price/);
  assert.match(parseItems({ desc: ['', 'B'], qty: ['1', '1'], price: ['5', '5'] }, toArray).error, /Line 1 needs a description/);
  assert.deepEqual(parseItems({ desc: 'Single', qty: '1', price: '9' }, toArray).items.length, 1, 'scalar (single-row) form bodies work');
  assert.equal(parseItems({ desc: ['Free item'], qty: [''], price: [''] }, toArray).items[0].unit_price, 0, 'free/zero-priced lines are allowed');
});

test('expiry is derived from the validity date, only for open quotes', () => {
  const q = (o) => ({ status: 'sent', valid_until: '2026-10-20', ...o });
  assert.equal(effectiveStatus(q(), '2026-10-25'), 'expired');
  assert.equal(effectiveStatus(q({ valid_until: '2026-10-25' }), '2026-10-25'), 'sent', 'valid through the end of the last day');
  assert.equal(effectiveStatus(q({ status: 'accepted' }), '2026-10-25'), 'accepted');
  assert.equal(effectiveStatus(q({ status: 'draft' }), '2026-10-25'), 'draft');
  assert.equal(effectiveStatus(q({ valid_until: null }), '2026-10-25'), 'sent');
});

test('quote numbers', () => {
  assert.equal(formatQuoteNumber('Q-', 7), 'Q-0007');
  assert.equal(formatQuoteNumber('INV/', 12345), 'INV/12345');
  assert.equal(formatQuoteNumber('Q-', 7, 3), 'Q-0007-R3');
});

test('pipeline stats: open value, monthly wins, win rate', () => {
  const NOW = Date.UTC(2026, 9, 25);
  const day = 86400000;
  const quotes = [
    { status: 'sent', total: 1000, currency: 'USD', valid_until: '2026-12-01', sent_at: NOW - day },
    { status: 'viewed', total: 2000, currency: 'USD', valid_until: '2026-12-01', sent_at: NOW - day },
    { status: 'accepted', total: 5000, currency: 'USD', responded_at: NOW - 2 * day, sent_at: NOW - 5 * day },
    { status: 'accepted', total: 700, currency: 'USD', responded_at: NOW - 40 * day, sent_at: NOW - 45 * day },
    { status: 'declined', total: 300, currency: 'USD', responded_at: NOW - 3 * day, sent_at: NOW - 6 * day },
    { status: 'sent', total: 400, currency: 'USD', valid_until: '2026-10-01', sent_at: NOW - 30 * day },
    { status: 'sent', total: 9000, currency: 'INR', valid_until: '2026-12-01', sent_at: NOW },
    { status: 'draft', total: 99999, currency: 'USD' },
  ];
  const s = pipelineStats(quotes, '2026-10-25', NOW);
  assert.equal(s.USD.pipeline, 3000);
  assert.equal(s.USD.awaiting, 2);
  assert.equal(s.USD.acceptedMonth, 5000);
  assert.equal(s.USD.acceptedMonthN, 1);
  assert.equal(s.USD.won, 2);
  assert.equal(s.USD.lost, 2, 'declined + expired');
  assert.equal(s.USD.rate, 50);
  assert.equal(s.INR.pipeline, 9000);
  assert.equal(s.INR.rate, null);
});

test('follow-up rules: open, old enough, not expired, only once', () => {
  const NOW = Date.UTC(2026, 9, 25);
  const day = 86400000;
  const base = { status: 'sent', sent_at: NOW - 4 * day, valid_until: '2026-11-30', followed_up_at: null };
  assert.ok(needsFollowUp(base, '2026-10-25', NOW, 3));
  assert.ok(needsFollowUp({ ...base, status: 'viewed' }, '2026-10-25', NOW, 3));
  assert.ok(!needsFollowUp({ ...base, sent_at: NOW - day }, '2026-10-25', NOW, 3), 'too recent');
  assert.ok(!needsFollowUp({ ...base, followed_up_at: NOW - day }, '2026-10-25', NOW, 3), 'already chased');
  assert.ok(!needsFollowUp({ ...base, valid_until: '2026-10-01' }, '2026-10-25', NOW, 3), 'expired');
  assert.ok(!needsFollowUp({ ...base, status: 'accepted' }, '2026-10-25', NOW, 3));
  assert.ok(!needsFollowUp({ ...base, status: 'draft' }, '2026-10-25', NOW, 3));
});
