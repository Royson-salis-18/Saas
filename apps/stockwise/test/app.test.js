import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createStockWise } from '../src/app.js';

const boot = (options = {}) => startTestApp(createStockWise, options);
const TODAY = '2026-10-25';
const dayOffset = (n) => new Date(Date.UTC(2026, 9, 25) + n * 86400000).toISOString().slice(0, 10);

/** sku,date,qty rows for the last `days` days with a per-day quantity function. */
const salesCsv = (sku, days, qtyFn) => ['sku,date,qty', ...Array.from({ length: days }, (_, i) => `${sku},${dayOffset(i - days + 1)},${qtyFn(i)}`)].join('\n');

const PRODUCTS = [
  'sku,name,supplier,stock,lead_time,cost,moq,case_size',
  'A-100,Basmati 5kg,Agro Foods,50,7,10,1,1', // steady 10/day => reorder now, qty 160
  'B-200,Dal 1kg,Agro Foods,0,7,2,1,1', // steady 5/day, out of stock
  'C-300,Tea 250g,Chai Co,900,7,3,1,1', // steady 5/day, 180 days cover => overstock
  'D-400,Old stock,Chai Co,40,7,5,1,1', // never sold => dead (once old enough)
  'E-500,Healthy,Chai Co,400,7,1,1,1', // steady 10/day, 40 days cover => ok
].join('\n');

async function ready(t, plan = 'pro') {
  const c = t.client();
  await c.signup();
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  await c.post('/import/products', { csv: PRODUCTS });
  const sales = [salesCsv('A-100', 56, () => 10), salesCsv('B-200', 56, () => 5), salesCsv('C-300', 56, () => 5), salesCsv('E-500', 56, () => 10)]
    .map((s, i) => (i === 0 ? s : s.split('\n').slice(1).join('\n')))
    .join('\n');
  await c.post('/import/sales', { csv: sales });
  t.app.db.run(`UPDATE products SET created_on = '2026-01-01'`);
  return c;
}
const prod = (t, sku) => t.app.db.get('SELECT * FROM products WHERE sku = ?', sku);

test('landing page', async () => {
  const t = await boot();
  try {
    const home = (await t.client().get('/')).text;
    assert.match(home, /Stop guessing your reorders/);
    assert.match(home, /₹3,999/);
    assert.match(home, /\$119/);
  } finally {
    await t.close();
  }
});

test('imports products and sales; recommendations match the maths', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM products').n, 5);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM sales').n, 56 * 4);
    assert.equal(prod(t, 'A-100').unit_cost, 1000);

    const list = (await c.get('/products')).text;
    assert.match(list, /Reorder now/);
    assert.match(list, /Out of stock/);
    assert.match(list, /Overstocked/);
    assert.match(list, /Dead stock/);
    assert.match(list, /Healthy/);

    const a = (await c.get(`/products/${prod(t, 'A-100').id}`)).text;
    assert.match(a, /Reorder point/);
    assert.match(a, /<div class="stat-value">160<\/div>/, 'suggested order: 210 target - 50 on hand');
    assert.match(a, /\$1,600/, '160 x $10');

    const dash = (await c.get('/dashboard')).text;
    assert.match(dash, /Need ordering now/);
    assert.match(dash, /2 out of stock|1 out of stock/);
    assert.match(dash, /Cash tied up/);
  } finally {
    await t.close();
  }
});

test('dead and overstocked stock are priced', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const dash = (await c.get('/dashboard')).text;
    // C-300: 900 on hand, 5/day => 180d cover, excess over 120d = 300 units x $3 = $900; D-400 dead: 40 x $5 = $200
    assert.match(dash, /\$1,100/);
  } finally {
    await t.close();
  }
});

test('reorder plan groups by supplier, can be downloaded, and marking as ordered is idempotent', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const plan = (await c.get('/orders')).text;
    assert.match(plan, /Agro Foods/);
    assert.ok(!plan.includes('Chai Co'), 'no urgent Chai Co items');
    assert.match(plan, /A-100/);
    assert.match(plan, /B-200/);
    assert.match(plan, /Hi Agro Foods,/);

    const csv = await c.get('/orders.csv?supplier=Agro%20Foods');
    assert.match(csv.text, /^sku,name,quantity,pack_size,unit_cost,line_cost/);
    assert.match(csv.text, /A-100,Basmati 5kg,160,1,10,1600/);
    assert.match(csv.headers.get('content-disposition'), /attachment/);

    await c.post('/orders/mark', { supplier: 'Agro Foods', soon: '0' });
    assert.equal(prod(t, 'A-100').on_order, 160);
    assert.equal(prod(t, 'B-200').on_order, 105, 'out-of-stock SKU orders up to its target: 5/day x (7+14) days');
    const after = (await c.get('/orders')).text;
    assert.ok(!after.includes('A-100'), 'ordered items drop off the plan');

    await c.post('/orders/mark', { supplier: 'Agro Foods', soon: '0' });
    assert.equal(prod(t, 'A-100').on_order, 160, 'double submit does not double-order');
  } finally {
    await t.close();
  }
});

test('receiving stock moves units from on-order to on-hand', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const { id } = prod(t, 'A-100');
    await c.post('/orders/mark', { supplier: 'Agro Foods', soon: '0' });
    await c.post(`/products/${id}/receive`, { qty: '100' });
    const p = prod(t, 'A-100');
    assert.equal(p.on_hand, 150);
    assert.equal(p.on_order, 60);
    await c.post(`/products/${id}/receive`, { qty: '500' });
    assert.equal(prod(t, 'A-100').on_order, 0, 'never negative');
    assert.equal((await c.post(`/products/${id}/receive`, { qty: '-5' })).status, 303);
    assert.equal(prod(t, 'A-100').on_hand, 650);
    await c.post(`/products/${id}/stock`, { on_hand: '12' });
    assert.equal(prod(t, 'A-100').on_hand, 12);
  } finally {
    await t.close();
  }
});

test('"reorder soon" items only appear when asked for', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    t.app.db.run(`UPDATE products SET on_hand = 100 WHERE sku = 'E-500'`); // 10/day => position 100: soon (ROP 70..140)
    assert.ok(!(await c.get('/orders')).text.includes('E-500'));
    assert.match((await c.get('/orders?soon=1')).text, /E-500/);
  } finally {
    await t.close();
  }
});

test('re-importing sales replaces rather than double counts; unknown SKUs are reported', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const before = t.app.db.get(`SELECT SUM(qty) AS q FROM sales WHERE product_id = ?`, prod(t, 'A-100').id).q;
    const r = await c.post('/import/sales', { csv: `${salesCsv('A-100', 56, () => 10)}\nGHOST,${TODAY},5` });
    assert.equal(r.status, 200, 'page re-rendered with the problem list');
    assert.match(r.text, /GHOST/);
    assert.match(r.text, /not in your product list/);
    assert.equal(t.app.db.get(`SELECT SUM(qty) AS q FROM sales WHERE product_id = ?`, prod(t, 'A-100').id).q, before);
    const bad = await c.post('/import/sales', { csv: 'sku,qty\nA,1' });
    assert.match(bad.text, /Missing column: date/);
  } finally {
    await t.close();
  }
});

test('product re-import updates by SKU and leaves blank cells alone', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/import/products', { csv: 'sku,stock,supplier\nA-100,75,' });
    const p = prod(t, 'A-100');
    assert.equal(p.on_hand, 75);
    assert.equal(p.supplier, 'Agro Foods', 'blank supplier does not erase it');
    assert.equal(p.unit_cost, 1000, 'omitted columns untouched');
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM products').n, 5);
    const bad = await c.post('/import/products', { csv: 'name,stock\nX,1' });
    assert.match(bad.text, /Couldn't find a SKU column/);
  } finally {
    await t.close();
  }
});

test('stale sales data triggers a visible warning', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    assert.ok(!(await c.get('/dashboard')).text.includes('latest sales data is from'));
    t.clock.t += 10 * 86400000;
    assert.match((await c.get('/dashboard')).text, /latest sales data is from/);
  } finally {
    await t.close();
  }
});

test('service level changes safety stock for lumpy demand', async () => {
  const t = await boot();
  try {
    const c = await ready(t, 'pro');
    const lumpy = salesCsv('E-500', 56, (i) => (i % 2 ? 20 : 0));
    await c.post('/import/sales', { csv: lumpy });
    const id = prod(t, 'E-500').id;
    t.app.db.run(`UPDATE products SET on_hand = 100`);
    const read = async () => {
      const page = (await c.get(`/products/${id}`)).text;
      return Number(page.match(/incl\. (\d+) safety stock/)[1]);
    };
    await c.post('/settings', { service_level: '90', review_days: '14', window_days: '56', overstock_days: '120', dead_days: '60' });
    const s90 = await read();
    await c.post('/settings', { service_level: '99', review_days: '14', window_days: '56', overstock_days: '120', dead_days: '60' });
    const s99 = await read();
    assert.ok(s99 > s90, `99% (${s99}) needs more safety stock than 90% (${s90})`);
    assert.ok(s90 > 30 && s99 < 80, 'sane magnitude: z x sd(10) x sqrt(7)');
  } finally {
    await t.close();
  }
});

test('free plan caps SKUs on import and manual add', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const rows = Array.from({ length: 30 }, (_, i) => `S${i},Item ${i},Sup,5,7,1,1,1`);
    await c.post('/import/products', { csv: ['sku,name,supplier,stock,lead_time,cost,moq,case_size', ...rows].join('\n') });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM products').n, 20);
    await c.post('/products', { sku: 'EXTRA', name: 'x' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM products').n, 20);
    assert.match((await c.get('/billing')).text, /products \(SKUs\)/);
  } finally {
    await t.close();
  }
});

test('manual product form validates and rejects duplicates', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    assert.equal((await c.post('/products', { sku: '', name: 'x' })).status, 400);
    assert.equal((await c.post('/products', { sku: 'M1', name: 'Manual', on_hand: '12', unit_cost: '$4.50', lead_time_days: '3' })).status, 303);
    assert.equal(prod(t, 'M1').unit_cost, 450);
    assert.equal(prod(t, 'M1').lead_time_days, 3);
    const dup = await c.post('/products', { sku: 'M1', name: 'Again' });
    assert.equal(dup.status, 400);
    assert.match(dup.text, /already exists/);
  } finally {
    await t.close();
  }
});

test('tenant isolation', async () => {
  const t = await boot();
  try {
    const a = await ready(t);
    const b = t.client();
    await b.signup('b@example.com');
    const { id } = prod(t, 'A-100');
    assert.equal((await b.get(`/products/${id}`)).status, 404);
    for (const p of ['edit', 'receive', 'stock', 'delete']) assert.equal((await b.post(`/products/${id}/${p}`, { sku: 'x', qty: '1', on_hand: '1' })).status, 404, p);
    assert.ok(!(await b.get('/products')).text.includes('A-100'));
    assert.ok(!(await b.get('/products.csv')).text.includes('A-100'));
    assert.equal((await b.get('/orders.csv?supplier=Agro%20Foods')).status, 404);
    await b.post('/import/sales', { csv: `sku,date,qty\nA-100,${TODAY},999` });
    assert.equal(t.app.db.get('SELECT SUM(qty) AS q FROM sales WHERE day = ? AND product_id = ?', TODAY, id).q, 10, "B's import can't touch A's sales");
    assert.equal(prod(t, 'A-100').on_hand, 50);
    void a;
  } finally {
    await t.close();
  }
});

test('product names and suppliers are escaped everywhere; csv exports neutralise formulas', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const evil = '<img src=x onerror=alert(1)>';
    await c.post('/import/products', { csv: `sku,name,supplier,stock,lead_time,cost\nX-1,"${evil}","=HYPERLINK(""http://evil"")",0,7,1` });
    await c.post('/import/sales', { csv: salesCsv('X-1', 20, () => 3) });
    const id = prod(t, 'X-1').id;
    for (const p of ['/dashboard', '/products', `/products/${id}`, '/orders', '/orders?soon=1']) {
      const page = (await c.get(p)).text;
      assert.ok(!page.includes('<img src=x'), p);
    }
    const csv = (await c.get('/products.csv')).text;
    assert.match(csv, /'=HYPERLINK/);
    const po = await c.get(`/orders.csv?supplier=${encodeURIComponent('=HYPERLINK("http://evil")')}`);
    assert.equal(po.status, 200);
    assert.ok(!/^=/m.test(po.text.split('\n')[1] ?? ''));
  } finally {
    await t.close();
  }
});
