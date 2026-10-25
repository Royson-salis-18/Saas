import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandStats, parseProductCsv, parseSalesCsv, poText, purchaseOrders, recommend, summarise } from '../src/logic.js';

const TODAY = '2026-10-25';
const product = (o = {}) => ({ sku: 'A1', name: 'Widget', supplier: 'Acme', on_hand: 50, on_order: 0, unit_cost: 1000, lead_time_days: 7, min_order_qty: 1, pack_size: 1, created_on: '2026-01-01', ...o });
const steady = (perDay, days = 56) => ({ total: perDay * days, sumsq: perDay * perDay * days, first_day: '2026-01-01', last_day: TODAY });
const settings = { service_level: '95', review_days: 14, window_days: 56, overstock_days: 120, dead_days: 60 };
const rec = (p, agg, s = settings) => recommend(p, demandStats(agg, TODAY, s.window_days), s, TODAY);

test('steady demand: reorder point = demand x lead time; order up to lead time + review period', () => {
  const r = rec(product({ on_hand: 50 }), steady(10));
  assert.equal(r.avg, 10);
  assert.equal(r.safety, 0, 'no variability, no safety stock');
  assert.equal(r.reorderPoint, 70);
  assert.equal(r.target, 210);
  assert.equal(r.status, 'reorder_now');
  assert.equal(r.qty, 160);
  assert.equal(r.orderCost, 160000);
  assert.equal(r.cover, 5);
  assert.equal(r.stockoutDate, '2026-10-30');
});

test('order quantity respects pack size and minimum order quantity', () => {
  assert.equal(rec(product({ pack_size: 24 }), steady(10)).qty, 168, '160 rounded up to 7 cases of 24');
  assert.equal(rec(product({ min_order_qty: 200 }), steady(10)).qty, 200);
  assert.equal(rec(product({ min_order_qty: 200, pack_size: 24 }), steady(10)).qty, 216, 'MOQ first, then whole cases');
  assert.equal(rec(product({ on_hand: 69.4 }), steady(10)).qty, 141, 'fractional need rounds up to a whole unit');
});

test('intermittent demand earns safety stock (service level matters)', () => {
  const lumpy = { total: 560, sumsq: 28 * 400, first_day: '2026-01-01', last_day: TODAY }; // 0 / 20 alternating
  const stats = demandStats(lumpy, TODAY, 56);
  assert.equal(stats.avg, 10);
  assert.ok(Math.abs(stats.sd - 10) < 1e-9);
  const r95 = rec(product({ on_hand: 100 }), lumpy);
  assert.ok(Math.abs(r95.safety - 1.6449 * 10 * Math.sqrt(7)) < 1e-6);
  assert.ok(Math.abs(r95.reorderPoint - (70 + 43.52)) < 0.05);
  assert.equal(r95.status, 'reorder_now', '100 on hand is below 113.5');
  const r99 = rec(product({ on_hand: 100 }), lumpy, { ...settings, service_level: '99' });
  assert.ok(r99.safety > r95.safety);
  const r90 = rec(product({ on_hand: 100 }), lumpy, { ...settings, service_level: '90' });
  assert.ok(r90.safety < r95.safety);
});

test('inventory position counts stock already on order', () => {
  assert.equal(rec(product({ on_hand: 50, on_order: 200 }), steady(10)).status, 'ok', 'a PO is already on its way');
  const r = rec(product({ on_hand: 50, on_order: 100 }), steady(10));
  assert.equal(r.position, 150);
  assert.equal(r.status, 'ok');
  assert.equal(rec(product({ on_hand: 50, on_order: 30 }), steady(10)).qty, 130, 'only the shortfall is ordered: 210 - 80');
});

test('status ladder: stockout, reorder now, reorder soon, ok, overstock', () => {
  assert.equal(rec(product({ on_hand: 0 }), steady(10)).status, 'stockout');
  assert.equal(rec(product({ on_hand: 0 }), steady(10)).qty, 210);
  assert.equal(rec(product({ on_hand: 70 }), steady(10)).status, 'reorder_now', 'at the reorder point');
  const soon = rec(product({ on_hand: 100 }), steady(10));
  assert.equal(soon.status, 'reorder_soon');
  assert.equal(soon.qty, 110);
  assert.equal(rec(product({ on_hand: 300 }), steady(10)).status, 'ok');
  assert.equal(rec(product({ on_hand: 300 }), steady(10)).qty, 0);
  const over = rec(product({ on_hand: 2000 }), steady(10));
  assert.equal(over.status, 'overstock');
  assert.equal(over.tiedUp, 800 * 1000, '800 units beyond 120 days of cover');
  assert.equal(over.qty, 0);
});

test('dead stock needs on-hand units, no recent sales, and an old enough SKU', () => {
  const none = { total: 0, sumsq: 0, first_day: null, last_day: null };
  const dead = rec(product({ on_hand: 100 }), none);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.tiedUp, 100000);
  assert.equal(rec(product({ on_hand: 100, created_on: '2026-10-20' }), none).status, 'no_data', 'new SKU: give it time');
  assert.equal(rec(product({ on_hand: 0 }), none).status, 'no_data');
  const oldSale = { total: 0, sumsq: 0, first_day: '2026-03-01', last_day: '2026-03-10' };
  assert.equal(rec(product({ on_hand: 5 }), oldSale).status, 'dead', 'last sale months ago');
});

test('a product first sold 10 days ago is averaged over 11 days, not the whole window', () => {
  const s = demandStats({ total: 110, sumsq: 1100, first_day: '2026-10-15', last_day: TODAY }, TODAY, 56);
  assert.equal(s.n, 11);
  assert.equal(s.avg, 10);
  assert.equal(s.sd, 0);
});

test('lead time scales the reorder point; zero lead time is safe', () => {
  assert.equal(rec(product({ lead_time_days: 21 }), steady(10)).reorderPoint, 210);
  const r = rec(product({ lead_time_days: 0, on_hand: 3 }), steady(10));
  assert.equal(r.reorderPoint, 0);
  assert.ok(Number.isFinite(r.qty));
});

const rows = (list) => list.map(([p, agg]) => ({ p, rec: rec(p, agg) }));

test('purchase orders group by supplier, biggest first; "soon" items are opt-in', () => {
  const list = rows([
    [product({ sku: 'A', supplier: 'Acme', on_hand: 50 }), steady(10)], // reorder now: 160 x 1000
    [product({ sku: 'B', supplier: 'Acme', on_hand: 0, unit_cost: 500 }), steady(10)], // stockout: 210 x 500
    [product({ sku: 'C', supplier: 'Zed', on_hand: 100 }), steady(10)], // soon: 110 x 1000
    [product({ sku: 'D', supplier: 'Zed', on_hand: 900 }), steady(10)], // ok
    [product({ sku: 'E', supplier: '', on_hand: 10 }), steady(5)], // no supplier
  ]);
  const pos = purchaseOrders(list);
  assert.deepEqual(pos.map((p) => p.supplier), ['Acme', ''], 'Zed only has a "soon" item');
  assert.equal(pos[0].lines[0].p.sku, 'B', 'stockouts first');
  assert.equal(pos[0].total, 160000 + 105000);
  const withSoon = purchaseOrders(list, { includeSoon: true });
  assert.ok(withSoon.some((p) => p.supplier === 'Zed' && p.lines.length === 1));
  const s = summarise(list);
  assert.equal(s.skus, 5);
  assert.equal(s.stockout, 1);
  assert.equal(s.reorderNow, 2);
  assert.equal(s.reorderSoon, 1);
  assert.equal(s.reorderCost, 160000 + 105000 + rec(product({ on_hand: 10 }), steady(5)).orderCost);
});

test('PO email text lists items, case counts and a required-by date', () => {
  const list = rows([[product({ sku: 'A', pack_size: 24, lead_time_days: 10 }), steady(10)]]);
  const text = poText({ po: purchaseOrders(list)[0], business: 'Acme Traders', today: TODAY, user: 'Priya' });
  assert.match(text, /Hi Acme,/);
  assert.match(text, /A \(Widget\): 192 \(8 x 24\)/, 'lead time 10 -> order up to 240; 190 needed = 8 cases of 24');
  assert.match(text, /Required by: 2026-11-04/);
  assert.match(text, /Priya$/);
});

test('product csv: tally/zoho style headers, decimals, duplicates, bad numbers', () => {
  const csv = [
    'Item Code,Product Name,Vendor,Closing Stock,Incoming,Purchase Price,Lead Time,MOQ,Case Size',
    'SKU-1,Basmati Rice 5kg,Agro Foods,"1,250",300,"₹410.50",5,100,10',
    'SKU-2,,Agro Foods,12.5,,,,,',
    'SKU-3,Bad Stock,X,lots,,,,,',
    'sku-1,Duplicate,X,1,,,,,',
    ',No sku,X,1,,,,,',
  ].join('\n');
  const r = parseProductCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { sku: 'SKU-1', name: 'Basmati Rice 5kg', supplier: 'Agro Foods', on_hand: 1250, on_order: 300, unit_cost: 41050, lead_time_days: 5, min_order_qty: 100, pack_size: 10 });
  assert.equal(r.rows[1].name, 'SKU-2', 'name falls back to SKU');
  assert.equal(r.rows[1].on_hand, 12.5);
  assert.equal(r.rows[1].lead_time_days, null, 'blank cells leave existing values alone');
  assert.deepEqual(r.errors.map((e) => e.line), [4, 5, 6]);
  assert.deepEqual(parseProductCsv('name,stock\nA,1').missing, ['sku']);
});

test('sales csv: sums per sku/day, nets returns, rejects future and unreadable rows', () => {
  const csv = [
    'SKU,Date,Qty',
    'A,05/10/2026,3',
    'A,05/10/2026,2',
    'A,06/10/2026,-1',
    'A,07/10/2026,4',
    'A,07/10/2026,-10',
    'B,31/12/2030,5',
    'B,notadate,5',
    'B,08/10/2026,many',
    ',08/10/2026,1',
  ].join('\n');
  const r = parseSalesCsv(csv, { dayFirst: true, today: TODAY });
  assert.deepEqual(r.rows, [
    { sku: 'A', day: '2026-10-05', qty: 5 },
    { sku: 'A', day: '2026-10-06', qty: 0 },
    { sku: 'A', day: '2026-10-07', qty: 0 },
  ]);
  assert.equal(r.skipped, 4);
  assert.match(r.errors.map((e) => e.message).join('|'), /future/);
  assert.deepEqual(parseSalesCsv('sku,qty\nA,1').missing, ['date']);
});
