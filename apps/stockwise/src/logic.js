// Inventory maths: demand statistics, reorder points with safety stock, order
// quantities, and capital tied up in slow or dead stock.

import { addDays, daysBetween, isISODate, parseAmount, parseCsvObjects, parseDateLoose, toMinor } from '@saas/core';

/** z-scores for the cycle service level (probability of not stocking out in a cycle). */
export const SERVICE_LEVELS = { 90: 1.2816, 95: 1.6449, 98: 2.0537, 99: 2.3263 };

export const DEFAULTS = { service_level: '95', review_days: 14, window_days: 56, overstock_days: 120, dead_days: 60 };

/**
 * Daily demand statistics from SQL aggregates over the demand window.
 * agg: { total, sumsq, first_day, last_day } (window totals; first/last are all-time).
 * Days with no sales count as zero-demand days, so intermittent products get a large
 * standard deviation and therefore more safety stock. A product first sold N < window
 * days ago is averaged over N days, not the whole window.
 */
export function demandStats(agg, today, windowDays) {
  if (!agg || !agg.first_day) return { avg: 0, sd: 0, n: windowDays, lastSale: null };
  const n = Math.max(1, Math.min(windowDays, daysBetween(agg.first_day, today) + 1));
  const total = agg.total ?? 0;
  const avg = total / n;
  const variance = Math.max(0, (agg.sumsq ?? 0) / n - avg * avg);
  return { avg, sd: Math.sqrt(variance), n, lastSale: agg.last_day };
}

const roundUpToMultiple = (qty, step) => (step > 1 ? Math.ceil(qty / step - 1e-9) * step : Math.ceil(qty - 1e-9));

/**
 * (s, S) policy: when inventory position (on hand + on order) falls to the reorder point,
 * order up to  avg x (lead time + review period) + safety stock.
 */
export function recommend(p, stats, settings, today) {
  const cfg = { ...DEFAULTS, ...settings };
  const z = SERVICE_LEVELS[cfg.service_level] ?? SERVICE_LEVELS[95];
  const L = Math.max(0, p.lead_time_days);
  const R = Math.max(0, Number(cfg.review_days));
  const safety = z * stats.sd * Math.sqrt(L);
  const reorderPoint = stats.avg * L + safety;
  const position = p.on_hand + p.on_order;
  const target = stats.avg * (L + R) + safety;
  const cover = stats.avg > 0 ? p.on_hand / stats.avg : null;

  let status = 'ok';
  const noRecentSales = !stats.lastSale || daysBetween(stats.lastSale, today) > Number(cfg.dead_days);
  if (stats.avg === 0) status = p.on_hand > 0 && noRecentSales && daysBetween(p.created_on ?? today, today) >= Number(cfg.dead_days) ? 'dead' : 'no_data';
  else if (p.on_hand <= 0) status = 'stockout';
  else if (position <= reorderPoint) status = 'reorder_now';
  else if (position <= reorderPoint + stats.avg * 7) status = 'reorder_soon';
  else if (cover !== null && cover > Number(cfg.overstock_days)) status = 'overstock';

  let qty = 0;
  if (['stockout', 'reorder_now', 'reorder_soon'].includes(status)) {
    qty = Math.max(0, target - position);
    if (qty > 0) {
      qty = Math.max(qty, p.min_order_qty);
      qty = roundUpToMultiple(qty, p.pack_size);
    }
  }
  const excessUnits = status === 'overstock' ? Math.max(0, p.on_hand - stats.avg * Number(cfg.overstock_days)) : 0;
  return {
    status,
    avg: stats.avg,
    sd: stats.sd,
    safety,
    reorderPoint,
    position,
    target,
    cover,
    stockoutDate: cover !== null ? addDays(today, Math.floor(cover)) : null,
    qty,
    orderCost: Math.round(qty * p.unit_cost),
    stockValue: Math.round(p.on_hand * p.unit_cost),
    tiedUp: status === 'dead' ? Math.round(p.on_hand * p.unit_cost) : Math.round(excessUnits * p.unit_cost),
    arriveBy: addDays(today, L),
  };
}

export const STATUS_ORDER = ['stockout', 'reorder_now', 'reorder_soon', 'overstock', 'dead', 'ok', 'no_data'];
export const STATUS_LABEL = { stockout: 'Out of stock', reorder_now: 'Reorder now', reorder_soon: 'Reorder soon', overstock: 'Overstocked', dead: 'Dead stock', ok: 'Healthy', no_data: 'No sales yet' };
export const STATUS_TONE = { stockout: 'bad', reorder_now: 'bad', reorder_soon: 'warn', overstock: 'info', dead: 'neutral', ok: 'good', no_data: 'neutral' };

export function summarise(rows) {
  const s = { skus: rows.length, stockout: 0, reorderNow: 0, reorderSoon: 0, overstock: 0, dead: 0, stockValue: 0, tiedUp: 0, reorderCost: 0 };
  for (const r of rows) {
    s.stockValue += r.rec.stockValue;
    s.tiedUp += r.rec.tiedUp;
    if (r.rec.status === 'stockout') s.stockout++;
    if (r.rec.status === 'reorder_now') s.reorderNow++;
    if (r.rec.status === 'reorder_soon') s.reorderSoon++;
    if (r.rec.status === 'overstock') s.overstock++;
    if (r.rec.status === 'dead') s.dead++;
    if (['stockout', 'reorder_now'].includes(r.rec.status)) s.reorderCost += r.rec.orderCost;
  }
  return s;
}

/** Group lines that need ordering by supplier. */
export function purchaseOrders(rows, { includeSoon = false } = {}) {
  const wanted = includeSoon ? ['stockout', 'reorder_now', 'reorder_soon'] : ['stockout', 'reorder_now'];
  const by = new Map();
  for (const r of rows) {
    if (!wanted.includes(r.rec.status) || r.rec.qty <= 0) continue;
    const key = r.p.supplier || '';
    const po = by.get(key) ?? { supplier: key, lines: [], total: 0 };
    po.lines.push(r);
    po.total += r.rec.orderCost;
    by.set(key, po);
  }
  const out = [...by.values()];
  for (const po of out) po.lines.sort((a, b) => STATUS_ORDER.indexOf(a.rec.status) - STATUS_ORDER.indexOf(b.rec.status) || a.p.sku.localeCompare(b.p.sku));
  return out.sort((a, b) => b.total - a.total);
}

const num = (v, d = 0) => {
  const n = parseAmount(v);
  return Number.isFinite(n) ? n : d;
};

export const PRODUCT_ALIASES = {
  sku: ['item_code', 'item', 'code', 'product_code', 'sku_code', 'part_no', 'part_number', 'barcode'],
  name: ['product', 'product_name', 'description', 'item_name', 'title'],
  supplier: ['vendor', 'supplier_name', 'vendor_name', 'preferred_supplier'],
  on_hand: ['stock', 'qty', 'quantity', 'current_stock', 'in_stock', 'on_hand_qty', 'closing_stock', 'balance'],
  on_order: ['incoming', 'open_po', 'on_order_qty', 'ordered', 'in_transit'],
  unit_cost: ['cost', 'purchase_price', 'rate', 'cost_price', 'buy_price', 'unit_price'],
  lead_time_days: ['lead_time', 'lead', 'leadtime', 'lead_days', 'delivery_days'],
  min_order_qty: ['moq', 'minimum_order', 'min_qty', 'minimum_order_qty'],
  pack_size: ['case_size', 'pack', 'multiple', 'order_multiple', 'case_qty', 'pack_qty'],
};

export function parseProductCsv(text) {
  const { rows: raw, missing } = parseCsvObjects(text, { aliases: PRODUCT_ALIASES, required: ['sku'], maxRows: 25000 });
  if (missing.length) return { rows: [], errors: [], missing };
  const rows = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const line = i + 2;
    const sku = (r.sku ?? '').slice(0, 60);
    if (!sku) return errors.push({ line, message: 'Missing SKU' });
    if (seen.has(sku.toLowerCase())) return errors.push({ line, message: `${sku}: duplicate SKU in this file (first one kept)` });
    seen.add(sku.toLowerCase());
    const onHand = r.on_hand === undefined || r.on_hand === '' ? null : num(r.on_hand, NaN);
    if (onHand !== null && !Number.isFinite(onHand)) return errors.push({ line, message: `${sku}: stock "${r.on_hand}" is not a number` });
    rows.push({
      sku,
      name: (r.name || sku).slice(0, 150),
      supplier: (r.supplier ?? '').slice(0, 100),
      on_hand: onHand,
      on_order: r.on_order === undefined || r.on_order === '' ? null : Math.max(0, num(r.on_order)),
      unit_cost: r.unit_cost === undefined || r.unit_cost === '' ? null : Math.max(0, toMinor(num(r.unit_cost))),
      lead_time_days: r.lead_time_days === undefined || r.lead_time_days === '' ? null : Math.min(365, Math.max(0, Math.round(num(r.lead_time_days, 7)))),
      min_order_qty: r.min_order_qty === undefined || r.min_order_qty === '' ? null : Math.max(0, num(r.min_order_qty, 1)),
      pack_size: r.pack_size === undefined || r.pack_size === '' ? null : Math.max(1, num(r.pack_size, 1)),
    });
  });
  return { rows, errors, missing: [] };
}

export const SALES_ALIASES = {
  sku: PRODUCT_ALIASES.sku,
  date: ['day', 'sale_date', 'order_date', 'invoice_date', 'sold_on', 'transaction_date'],
  qty: ['quantity', 'units', 'sold', 'qty_sold', 'units_sold', 'sales_qty'],
};

/** Aggregates rows to one entry per (sku, day). Returns { rows: [{sku, day, qty}], errors, missing }. */
export function parseSalesCsv(text, { dayFirst = false, today } = {}) {
  const { rows: raw, missing } = parseCsvObjects(text, { aliases: SALES_ALIASES, required: ['sku', 'date', 'qty'], maxRows: 200000 });
  if (missing.length) return { rows: [], errors: [], missing };
  const agg = new Map();
  const errors = [];
  let skipped = 0;
  raw.forEach((r, i) => {
    const day = parseDateLoose(r.date, { dayFirst });
    const qty = parseAmount(r.qty);
    if (!r.sku || !day || !isISODate(day) || !Number.isFinite(qty) || (today && day > today)) {
      skipped++;
      if (errors.length < 50) errors.push({ line: i + 2, message: !r.sku ? 'Missing SKU' : !day ? `Could not read date "${r.date}"` : !Number.isFinite(qty) ? `Quantity "${r.qty}" is not a number` : 'Date is in the future' });
      return;
    }
    const key = `${r.sku}\u0000${day}`;
    const prev = agg.get(key);
    // returns (negative quantities) net against sales on the same day, never below zero
    agg.set(key, { sku: r.sku, day, qty: (prev?.qty ?? 0) + qty });
  });
  const rows = [...agg.values()].map((x) => ({ ...x, qty: Math.max(0, x.qty) }));
  return { rows, errors, missing: [], skipped };
}

export function poText({ po, business, today, user }) {
  const lines = po.lines.map((l) => `- ${l.p.sku}${l.p.name !== l.p.sku ? ` (${l.p.name})` : ''}: ${l.rec.qty}${l.p.pack_size > 1 ? ` (${l.rec.qty / l.p.pack_size} x ${l.p.pack_size})` : ''}`);
  return `Hi ${po.supplier || 'team'},\n\nPlease supply the following items for ${business}:\n\n${lines.join('\n')}\n\nRequired by: ${addDays(today, Math.max(...po.lines.map((l) => l.p.lead_time_days)))}\n\nPlease confirm availability, price and delivery date.\n\nThanks,\n${user}`;
}
