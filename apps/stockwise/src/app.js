import {
  HttpError,
  addDays,
  badge,
  card,
  ring,
  vbars,
  clean,
  createApp,
  csrfField,
  download,
  emptyState,
  field,
  formatDate,
  formatMoney,
  html,
  pageHeader,
  parseAmount,
  redirect,
  statGrid,
  table,
  toCsv,
  toMinor,
} from '@saas/core';
import {
  DEFAULTS,
  abcClasses,
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  demandStats,
  parseProductCsv,
  parseSalesCsv,
  poText,
  purchaseOrders,
  recommend,
  summarise,
} from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    supplier TEXT NOT NULL DEFAULT '',
    on_hand REAL NOT NULL DEFAULT 0,
    on_order REAL NOT NULL DEFAULT 0,
    unit_cost INTEGER NOT NULL DEFAULT 0,
    lead_time_days INTEGER NOT NULL DEFAULT 7,
    min_order_qty REAL NOT NULL DEFAULT 1,
    pack_size REAL NOT NULL DEFAULT 1,
    created_on TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, sku)
  );
  CREATE INDEX products_user_supplier ON products (user_id, supplier);
  CREATE TABLE sales (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    qty REAL NOT NULL,
    PRIMARY KEY (product_id, day)
  ) WITHOUT ROWID;
  `,
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { skus: 20 }, blurb: 'Try it on your fastest movers.', features: ['Reorder points & safety stock', 'Purchase-order drafts'] },
  starter: { label: 'Starter', price: { INR: 1499, USD: 49 }, limits: { skus: 300 }, blurb: 'For single-location shops and small distributors.', features: ['CSV import & export', 'Dead-stock report'] },
  pro: { label: 'Pro', price: { INR: 3999, USD: 119 }, limits: { skus: 2000 }, featured: true, blurb: 'For growing distributors and D2C brands.', features: ['Everything in Starter', 'Priority support'] },
  business: { label: 'Business', price: { INR: 7499, USD: 249 }, limits: { skus: 20000 }, blurb: 'For large catalogues and multiple suppliers.', features: ['Everything in Pro', 'Onboarding call'] },
};

const num = (v, d = NaN) => {
  const n = parseAmount(v);
  return Number.isFinite(n) ? n : d;
};
const fmtQty = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));

export function createStockWise(options = {}) {
  const app = createApp({
    slug: 'stockwise',
    name: 'StockWise',
    tagline: 'Know what to reorder, how much, and what is tying up your cash',
    accent: '#b8f23b',
    glyph: 'cube',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/products', label: 'Products' },
      { href: '/orders', label: 'Reorder plan' },
      { href: '/import', label: 'Import' },
      { href: '/settings', label: 'Settings' },
    ],
    plans: PLANS,
    limitLabels: { skus: 'products (SKUs)' },
    migrations: MIGRATIONS,
    settingsDefaults: { business_name: '', ...DEFAULTS },
    usage: (db, user) => ({ skus: db.get('SELECT COUNT(*) AS n FROM products WHERE user_id = ?', user.id).n }),
    marketing: {
      preview: { chartTitle: 'Stock by status (SKUs)', ringTitle: 'Healthy stock', bars: [{ label: 'Healthy', value: 148 }, { label: 'Soon', value: 23 }, { label: 'Reorder', value: 12 }, { label: 'Out', value: 4 }, { label: 'Excess', value: 17 }, { label: 'Dead', value: 9 }], ring: { value: 70, text: '70%', label: 'of SKUs', note: '₹4.2L tied up in excess and dead stock' }, kpis: [{ label: 'Need ordering now', value: '16', delta: '4 out of stock', deltaTone: 'bad' }, { label: 'Stock value', value: '₹38.4L', delta: '213 SKUs' }, { label: 'Cash tied up', value: '₹4.2L', delta: '26 SKUs', deltaTone: 'warn' }] },
      audience: 'For distributors, retailers and D2C brands',
      headline: 'Stop guessing your reorders. Stop stockouts and dead stock.',
      sub: 'Upload your stock and sales exports. StockWise calculates reorder points with safety stock, tells you what to buy this week and how much, drafts the purchase order per supplier, and shows how much cash is sitting in stock that does not move.',
      points: [
        { title: 'Reorder before you run out', body: 'Reorder points from real sales history and supplier lead times, with safety stock matched to your service level.' },
        { title: 'Purchase orders in one click', body: 'Items grouped by supplier, rounded to your minimum order quantities and case packs, ready to email or download.' },
        { title: 'Free the cash in dead stock', body: 'See overstocked and non-moving items and exactly how much working capital they tie up.' },
        { title: 'Works from your spreadsheets', body: 'No integration project. Export a stock list and a sales report from Tally, Zoho, Shopify, Excel — and go.' },
      ],
      steps: [
        { title: 'Upload products and sales', body: 'Two CSV files. Headers from popular tools are recognised automatically.' },
        { title: 'Review the reorder plan', body: 'Stockouts and urgent items first, with suggested quantities and costs.' },
        { title: 'Order and track', body: 'Mark a supplier’s order as placed so open orders count towards your stock position.' },
      ],
      faq: [
        { q: 'How is the order quantity calculated?', a: 'When stock plus open orders falls to the reorder point (demand during the lead time plus safety stock), StockWise orders up to cover the lead time plus your review period, then applies minimum order quantities and case packs.' },
        { q: 'Does it handle seasonal or lumpy demand?', a: 'Variability in daily sales raises the safety stock automatically. You can change the demand window and service level in Settings.' },
        { q: 'Which numbers do I need to provide?', a: 'Stock on hand, supplier lead time and unit cost per SKU, plus daily sales history. Lead time defaults to 7 days.' },
      ],
    },
    ...options,
  });

  const { db } = app;

  // ---- analysis --------------------------------------------------------------
  function analyse(userId, settings, today) {
    const win = Math.max(7, Number(settings.window_days) || DEFAULTS.window_days);
    const products = db.all('SELECT * FROM products WHERE user_id = ? ORDER BY sku COLLATE NOCASE', userId);
    const windowed = new Map(
      db
        .all(
          `SELECT s.product_id AS pid, SUM(s.qty) AS total, SUM(s.qty * s.qty) AS sumsq FROM sales s JOIN products p ON p.id = s.product_id
           WHERE p.user_id = ? AND s.day > ? AND s.day <= ? GROUP BY s.product_id`,
          userId, addDays(today, -win), today,
        )
        .map((r) => [r.pid, r]),
    );
    const spans = new Map(
      db
        .all(`SELECT s.product_id AS pid, MIN(s.day) AS first_day, MAX(s.day) AS last_day FROM sales s JOIN products p ON p.id = s.product_id WHERE p.user_id = ? GROUP BY s.product_id`, userId)
        .map((r) => [r.pid, r]),
    );
    const rows = products.map((p) => {
      const span = spans.get(p.id);
      const w = windowed.get(p.id);
      const stats = demandStats(span ? { total: w?.total ?? 0, sumsq: w?.sumsq ?? 0, first_day: span.first_day, last_day: span.last_day } : null, today, win);
      return { p, stats, rec: recommend(p, stats, settings, today) };
    });
    const classes = abcClasses(rows);
    for (const r of rows) r.abc = classes.get(r.p.id);
    return rows;
  }

  const getProduct = (ctx, id) => {
    const p = db.get('SELECT * FROM products WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!p) throw new HttpError(404, 'Product not found');
    return p;
  };
  const skuCount = (userId) => db.get('SELECT COUNT(*) AS n FROM products WHERE user_id = ?', userId).n;
  const latestSale = (userId) => db.get('SELECT MAX(s.day) AS d FROM sales s JOIN products p ON p.id = s.product_id WHERE p.user_id = ?', userId)?.d ?? null;
  const money = (ctx) => (minor) => formatMoney(minor, ctx.user.currency);

  // ---- dashboard -----------------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const today = ctx.today();
    if (!skuCount(ctx.user.id)) {
      return ctx.page('Dashboard', html`${pageHeader('Dashboard')}${emptyState('Import your stock list to get started', 'Upload a products CSV (SKU, stock, supplier, lead time, cost) and a sales CSV (SKU, date, quantity).', html`<p><a class="btn btn-primary" href="/import">Import data</a> <a class="btn" href="/products/new">Add a product</a></p>`)}`);
    }
    const rows = analyse(ctx.user.id, ctx.settings, today);
    const s = summarise(rows);
    const m = money(ctx);
    const last = latestSale(ctx.user.id);
    const staleDays = last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : null;
    const urgent = rows.filter((r) => ['stockout', 'reorder_now'].includes(r.rec.status)).sort((a, b) => (a.rec.cover ?? 0) - (b.rec.cover ?? 0)).slice(0, 10);
    const tied = rows.filter((r) => r.rec.tiedUp > 0).sort((a, b) => b.rec.tiedUp - a.rec.tiedUp).slice(0, 8);
    return ctx.page(
      'Dashboard',
      html`${pageHeader('Dashboard', html`<a class="btn btn-primary" href="/orders">Open reorder plan</a>`)}
      ${last === null ? html`<div class="flash flash-err">No sales history yet — recommendations need it. <a href="/import">Import sales</a></div>` : staleDays > 7 ? html`<div class="flash flash-err">Your latest sales data is from ${formatDate(last)} (${staleDays} days ago). Recommendations are only as fresh as your last import. <a href="/import">Import sales</a></div>` : ''}
      ${statGrid([
        { label: 'Need ordering now', value: s.stockout + s.reorderNow, tone: s.stockout + s.reorderNow ? 'bad' : 'good', hint: `${s.stockout} out of stock · est. ${m(s.reorderCost)}` },
        { label: 'Reorder soon', value: s.reorderSoon, tone: s.reorderSoon ? 'warn' : '' },
        { label: 'Stock value', value: m(s.stockValue), hint: `${s.skus} SKUs` },
        { label: 'Class A SKUs', value: rows.filter((r) => r.abc === 'A').length, hint: 'about 80% of consumption value' },
        { label: 'Cash tied up in excess / dead stock', value: m(s.tiedUp), tone: s.tiedUp ? 'warn' : 'good', hint: `${s.overstock} overstocked · ${s.dead} dead` },
      ])}
      <div class="viz">${card('Stock health by status', vbars({ height: 170, items: [{ label: 'Healthy', value: rows.length - s.stockout - s.reorderNow - s.reorderSoon - s.overstock - s.dead - rows.filter((r) => r.rec.status === 'no_data').length }, { label: 'Soon', value: s.reorderSoon, tone: 'warn' }, { label: 'Reorder', value: s.reorderNow, tone: 'bad' }, { label: 'Out', value: s.stockout, tone: 'bad' }, { label: 'Excess', value: s.overstock }, { label: 'Dead', value: s.dead }] }))}
        ${card('Healthy SKUs', html`${ring({ value: rows.filter((r) => ['ok'].includes(r.rec.status)).length, max: rows.length, text: `${Math.round((rows.filter((r) => r.rec.status === 'ok').length / rows.length) * 100)}%`, label: 'of SKUs' })}<p class="muted center">${m(s.tiedUp)} tied up in excess and dead stock</p>`, { className: 'ring-card' })}</div>
      <div class="grid-2">
        ${card('Most urgent', table({
          columns: [
            { label: 'Product', render: (r) => html`<a href="/products/${r.p.id}"><strong>${r.p.sku}</strong></a><span class="sub">${r.p.name}</span>` },
            { label: 'Cover', align: 'right', render: (r) => (r.rec.cover === null ? '—' : `${Math.floor(r.rec.cover)}d`) },
            { label: 'Order', align: 'right', render: (r) => fmtQty(r.rec.qty) },
            { label: '', render: (r) => badge(STATUS_LABEL[r.rec.status], STATUS_TONE[r.rec.status]) },
          ],
          rows: urgent,
          empty: 'Nothing urgent. 🎉',
        }))}
        ${card('Cash tied up', table({
          columns: [
            { label: 'Product', render: (r) => html`<a href="/products/${r.p.id}"><strong>${r.p.sku}</strong></a><span class="sub">${r.p.name}</span>` },
            { label: 'On hand', align: 'right', render: (r) => fmtQty(r.p.on_hand) },
            { label: 'Tied up', align: 'right', render: (r) => m(r.rec.tiedUp) },
            { label: '', render: (r) => badge(STATUS_LABEL[r.rec.status], STATUS_TONE[r.rec.status]) },
          ],
          rows: tied,
          empty: 'No excess or dead stock detected.',
        }))}
      </div>`,
    );
  });

  // ---- products ------------------------------------------------------------------
  const FILTERS = [['all', 'All'], ['action', 'Needs action'], ['stockout', 'Out of stock'], ['reorder_soon', 'Soon'], ['overstock', 'Overstocked'], ['dead', 'Dead stock'], ['A', 'Class A'], ['B', 'Class B'], ['C', 'Class C']];

  app.get('/products', (ctx) => {
    const filter = FILTERS.some(([k]) => k === ctx.query.filter) ? ctx.query.filter : 'all';
    const q = clean(ctx.query.q, 80).toLowerCase();
    const rows = analyse(ctx.user.id, ctx.settings, ctx.today())
      .filter((r) => {
        const st = r.rec.status;
        if (filter === 'action' && !['stockout', 'reorder_now'].includes(st)) return false;
        if (['A', 'B', 'C'].includes(filter) && r.abc !== filter) return false;
        if (['stockout', 'reorder_soon', 'overstock', 'dead'].includes(filter) && st !== filter) return false;
        return !q || [r.p.sku, r.p.name, r.p.supplier].some((v) => v.toLowerCase().includes(q));
      })
      .sort((a, b) => STATUS_ORDER.indexOf(a.rec.status) - STATUS_ORDER.indexOf(b.rec.status) || a.p.sku.localeCompare(b.p.sku));
    const m = money(ctx);
    return ctx.page(
      'Products',
      html`${pageHeader('Products', html`<a class="btn" href="/products.csv">Export CSV</a><a class="btn btn-primary" href="/products/new">Add product</a>`)}
      <div class="pill-row">${FILTERS.map(([k, l]) => html`<a href="/products?filter=${k}" class="${k === filter ? 'active' : ''}">${l}</a>`)}</div>
      <form method="get" action="/products" class="inline-form" style="margin-bottom:1rem"><input type="hidden" name="filter" value="${filter}"><input type="text" name="q" value="${q}" placeholder="Search SKU, name, supplier"><button class="btn" type="submit">Search</button></form>
      ${card('', table({
        columns: [
          { label: 'Product', render: (r) => html`<a href="/products/${r.p.id}"><strong>${r.p.sku}</strong></a><span class="sub">${r.p.name}${r.p.supplier ? ` · ${r.p.supplier}` : ''}</span>` },
          { label: 'On hand', align: 'right', render: (r) => html`${fmtQty(r.p.on_hand)}${r.p.on_order ? html`<span class="sub">+${fmtQty(r.p.on_order)} ordered</span>` : ''}` },
          { label: 'Daily sales', align: 'right', render: (r) => (r.rec.avg ? r.rec.avg.toFixed(1) : '—') },
          { label: 'Cover', align: 'right', render: (r) => (r.rec.cover === null ? '—' : `${Math.floor(r.rec.cover)}d`) },
          { label: 'Reorder point', align: 'right', render: (r) => (r.rec.avg ? Math.ceil(r.rec.reorderPoint) : '—') },
          { label: 'Order qty', align: 'right', render: (r) => (r.rec.qty ? html`<strong>${fmtQty(r.rec.qty)}</strong><span class="sub">${m(r.rec.orderCost)}</span>` : '—') },
          { label: 'ABC', render: (r) => badge(r.abc, r.abc === 'A' ? 'good' : r.abc === 'B' ? 'info' : 'neutral') },
          { label: 'Status', render: (r) => badge(STATUS_LABEL[r.rec.status], STATUS_TONE[r.rec.status]) },
        ],
        rows: rows.slice(0, 400),
        empty: q ? 'No products match your search.' : 'No products in this view.',
      }))}
      ${rows.length > 400 ? html`<p class="muted">Showing 400 of ${rows.length}. Use search or filters to narrow down.</p>` : ''}`,
    );
  });

  app.get('/products.csv', (ctx) => {
    const rows = analyse(ctx.user.id, ctx.settings, ctx.today());
    return download('stockwise-products.csv', toCsv(rows, [
      { label: 'sku', value: (r) => r.p.sku }, { label: 'name', value: (r) => r.p.name }, { label: 'supplier', value: (r) => r.p.supplier },
      { label: 'on_hand', value: (r) => r.p.on_hand }, { label: 'on_order', value: (r) => r.p.on_order }, { label: 'unit_cost', value: (r) => r.p.unit_cost / 100 },
      { label: 'lead_time_days', value: (r) => r.p.lead_time_days }, { label: 'avg_daily_sales', value: (r) => +r.rec.avg.toFixed(2) },
      { label: 'reorder_point', value: (r) => Math.ceil(r.rec.reorderPoint) }, { label: 'abc_class', value: (r) => r.abc }, { label: 'status', value: (r) => STATUS_LABEL[r.rec.status] }, { label: 'suggested_order_qty', value: (r) => r.rec.qty },
    ]));
  });

  const productForm = (ctx, p = {}, error = '') =>
    html`${error ? html`<div class="flash flash-err">${error}</div>` : ''}
    <form method="post" action="${p.id ? `/products/${p.id}/edit` : '/products'}">${csrfField(ctx)}
      <div class="row">
        ${field({ label: 'SKU', name: 'sku', value: p.sku ?? '', required: true })}
        ${field({ label: 'Name', name: 'name', value: p.name ?? '' })}
        ${field({ label: 'Supplier', name: 'supplier', value: p.supplier ?? '' })}
      </div>
      <div class="row">
        ${field({ label: 'On hand', name: 'on_hand', value: p.on_hand ?? 0, attrs: { inputmode: 'decimal' } })}
        ${field({ label: 'On order (open POs)', name: 'on_order', value: p.on_order ?? 0, attrs: { inputmode: 'decimal' } })}
        ${field({ label: `Unit cost (${ctx.user.currency})`, name: 'unit_cost', value: p.unit_cost ? p.unit_cost / 100 : '', attrs: { inputmode: 'decimal' } })}
      </div>
      <div class="row">
        ${field({ label: 'Lead time (days)', name: 'lead_time_days', type: 'number', value: p.lead_time_days ?? 7, attrs: { min: 0, max: 365 } })}
        ${field({ label: 'Minimum order qty', name: 'min_order_qty', value: p.min_order_qty ?? 1, attrs: { inputmode: 'decimal' } })}
        ${field({ label: 'Order in multiples of (case size)', name: 'pack_size', value: p.pack_size ?? 1, attrs: { inputmode: 'decimal' } })}
      </div>
      <button class="btn btn-primary" type="submit">${p.id ? 'Save changes' : 'Add product'}</button>
    </form>`;

  function readProductForm(ctx) {
    const b = ctx.body;
    const v = {
      sku: clean(b.sku, 60), name: clean(b.name, 150), supplier: clean(b.supplier, 100),
      on_hand: num(b.on_hand, 0), on_order: Math.max(0, num(b.on_order, 0)), unit_cost: Math.max(0, toMinor(num(b.unit_cost, 0))),
      lead_time_days: Math.min(365, Math.max(0, Math.round(num(b.lead_time_days, 7)))), min_order_qty: Math.max(0, num(b.min_order_qty, 1)), pack_size: Math.max(1, num(b.pack_size, 1)),
    };
    v.name ||= v.sku;
    return { v, error: v.sku ? '' : 'SKU is required.' };
  }

  app.get('/products/new', (ctx) => ctx.page('Add product', html`${pageHeader('Add product')}${card('', productForm(ctx))}`));

  app.post('/products', (ctx) => {
    const { v, error } = readProductForm(ctx);
    const again = (msg) => ctx.page('Add product', html`${pageHeader('Add product')}${card('', productForm(ctx, v, msg))}`, { status: 400 });
    if (error) return again(error);
    const limitMsg = ctx.checkLimit('skus', skuCount(ctx.user.id));
    if (limitMsg) return redirect('/products', { err: limitMsg });
    if (db.get('SELECT 1 AS x FROM products WHERE user_id = ? AND sku = ?', ctx.user.id, v.sku)) return again(`SKU ${v.sku} already exists.`);
    const id = db.run(
      `INSERT INTO products (user_id, sku, name, supplier, on_hand, on_order, unit_cost, lead_time_days, min_order_qty, pack_size, created_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.user.id, v.sku, v.name, v.supplier, v.on_hand, v.on_order, v.unit_cost, v.lead_time_days, v.min_order_qty, v.pack_size, ctx.today(), ctx.now(),
    ).id;
    return redirect(`/products/${id}`, { ok: 'Product added.' });
  });

  app.get('/products/:id', (ctx) => {
    const p = getProduct(ctx, ctx.params.id);
    const today = ctx.today();
    const row = analyse(ctx.user.id, ctx.settings, today).find((r) => r.p.id === p.id);
    const r = row.rec;
    const win = Number(ctx.settings.window_days) || 56;
    const sales = new Map(db.all('SELECT day, qty FROM sales WHERE product_id = ? AND day > ?', p.id, addDays(today, -60)).map((s) => [s.day, s.qty]));
    const series = Array.from({ length: 60 }, (_, i) => sales.get(addDays(today, i - 59)) ?? 0);
    const max = Math.max(1, ...series);
    const m = money(ctx);
    const act = (path, label, extra = {}, cls = 'btn') => html`<form method="post" action="/products/${p.id}/${path}" class="inline-form">${csrfField(ctx)}${extra.input ?? ''}<button class="${cls}" type="submit">${label}</button></form>`;
    return ctx.page(
      p.sku,
      html`${pageHeader(html`${p.sku} ${badge(STATUS_LABEL[r.status], STATUS_TONE[r.status])}`, '', `${p.name}${p.supplier ? ` · ${p.supplier}` : ''}`)}
      ${statGrid([
        { label: 'On hand', value: fmtQty(p.on_hand), hint: p.on_order ? `+${fmtQty(p.on_order)} on order` : '' },
        { label: 'Avg daily sales', value: r.avg ? r.avg.toFixed(1) : '—', hint: `last ${win} days` },
        { label: 'Days of cover', value: r.cover === null ? '—' : `${Math.floor(r.cover)}`, hint: r.stockoutDate ? `runs out ~${formatDate(r.stockoutDate)}` : '' },
        { label: 'Reorder point', value: r.avg ? Math.ceil(r.reorderPoint) : '—', hint: r.avg ? `incl. ${Math.ceil(r.safety)} safety stock` : '' },
        { label: 'Suggested order', value: r.qty ? fmtQty(r.qty) : '—', tone: r.qty ? 'warn' : '', hint: r.qty ? `${m(r.orderCost)} · arrives by ${formatDate(r.arriveBy)}` : '' },
      ])}
      ${card('Daily sales, last 60 days', html`<div class="bars lat" style="height:80px">${series.map((q, i) => html`<i style="height:${q ? Math.max(4, Math.round((q / max) * 100)) : 2}%" title="${addDays(today, i - 59)}: ${q}"></i>`)}</div><p class="help">Peak ${fmtQty(max === 1 && !series.some(Boolean) ? 0 : max)} units/day.</p>`)}
      <div class="grid-2">
        ${card('Stock movements', html`
          <div class="actions">
            <form method="post" action="/products/${p.id}/receive" class="inline-form">${csrfField(ctx)}<input type="number" step="any" min="0" name="qty" placeholder="Qty received" required style="width:9rem"><button class="btn" type="submit">Receive stock</button></form>
            <form method="post" action="/products/${p.id}/stock" class="inline-form">${csrfField(ctx)}<input type="number" step="any" name="on_hand" placeholder="Count" required style="width:9rem"><button class="btn" type="submit">Set stock count</button></form>
          </div>
          <p class="help">Receiving moves units from “on order” to “on hand”.</p>`)}
        ${card('Details', productForm(ctx, p))}
      </div>
      ${act('delete', 'Delete product', {}, 'btn btn-danger')}`,
    );
  });

  app.post('/products/:id/edit', (ctx) => {
    const p = getProduct(ctx, ctx.params.id);
    const { v, error } = readProductForm(ctx);
    if (error) return redirect(`/products/${p.id}`, { err: error });
    if (v.sku !== p.sku && db.get('SELECT 1 AS x FROM products WHERE user_id = ? AND sku = ?', ctx.user.id, v.sku)) return redirect(`/products/${p.id}`, { err: `SKU ${v.sku} already exists.` });
    db.run('UPDATE products SET sku = ?, name = ?, supplier = ?, on_hand = ?, on_order = ?, unit_cost = ?, lead_time_days = ?, min_order_qty = ?, pack_size = ? WHERE id = ?', v.sku, v.name, v.supplier, v.on_hand, v.on_order, v.unit_cost, v.lead_time_days, v.min_order_qty, v.pack_size, p.id);
    return redirect(`/products/${p.id}`, { ok: 'Saved.' });
  });

  app.post('/products/:id/receive', (ctx) => {
    const p = getProduct(ctx, ctx.params.id);
    const qty = num(ctx.body.qty);
    if (!Number.isFinite(qty) || qty <= 0) return redirect(`/products/${p.id}`, { err: 'Enter a quantity greater than zero.' });
    db.run('UPDATE products SET on_hand = on_hand + ?, on_order = MAX(0, on_order - ?) WHERE id = ?', qty, qty, p.id);
    return redirect(`/products/${p.id}`, { ok: `Received ${fmtQty(qty)} units.` });
  });

  app.post('/products/:id/stock', (ctx) => {
    const p = getProduct(ctx, ctx.params.id);
    const n = num(ctx.body.on_hand);
    if (!Number.isFinite(n)) return redirect(`/products/${p.id}`, { err: 'Enter the counted quantity.' });
    db.run('UPDATE products SET on_hand = ? WHERE id = ?', n, p.id);
    return redirect(`/products/${p.id}`, { ok: 'Stock count updated.' });
  });

  app.post('/products/:id/delete', (ctx) => {
    db.run('DELETE FROM products WHERE id = ?', getProduct(ctx, ctx.params.id).id);
    return redirect('/products', { ok: 'Product deleted.' });
  });

  // ---- reorder plan & purchase orders --------------------------------------------
  app.get('/orders', (ctx) => {
    const today = ctx.today();
    const includeSoon = ctx.query.soon === '1';
    const rows = analyse(ctx.user.id, ctx.settings, today);
    const pos = purchaseOrders(rows, { includeSoon });
    const m = money(ctx);
    const business = ctx.settings.business_name || ctx.user.name;
    if (!rows.length) return ctx.page('Reorder plan', html`${pageHeader('Reorder plan')}${emptyState('No products yet', 'Import your products and sales first.', html`<p><a class="btn btn-primary" href="/import">Import data</a></p>`)}`);
    return ctx.page(
      'Reorder plan',
      html`${pageHeader('Reorder plan', html`<a class="btn ${includeSoon ? '' : 'btn-primary'}" href="/orders">Urgent only</a><a class="btn ${includeSoon ? 'btn-primary' : ''}" href="/orders?soon=1">Include “reorder soon”</a>`,
        pos.length ? `${pos.reduce((n, p) => n + p.lines.length, 0)} items across ${pos.length} supplier${pos.length === 1 ? '' : 's'} · about ${m(pos.reduce((n, p) => n + p.total, 0))}` : 'Nothing to order right now.')}
      ${pos.length ? '' : emptyState('You are covered', 'No product is at or below its reorder point. Check back after your next sales import.')}
      ${pos.map((po, idx) => card(
        '',
        html`<div class="page-header"><div><h2 style="margin:0">${po.supplier || 'No supplier set'}</h2><p class="muted">${po.lines.length} item${po.lines.length === 1 ? '' : 's'} · ${m(po.total)}</p></div>
          <div class="actions">
            <a class="btn btn-sm" href="/orders.csv?supplier=${encodeURIComponent(po.supplier)}&soon=${includeSoon ? 1 : 0}">Download CSV</a>
            <button class="btn btn-sm" type="button" data-copy="#po${idx}">Copy PO email</button>
            <form method="post" action="/orders/mark" class="inline" data-confirm="Mark these items as ordered? They will count as on order and drop off this plan.">${csrfField(ctx)}<input type="hidden" name="supplier" value="${po.supplier}"><input type="hidden" name="soon" value="${includeSoon ? 1 : 0}"><button class="btn btn-sm btn-primary" type="submit">Mark as ordered</button></form>
          </div></div>
        ${table({
          columns: [
            { label: 'Product', render: (l) => html`<a href="/products/${l.p.id}"><strong>${l.p.sku}</strong></a><span class="sub">${l.p.name}</span>` },
            { label: 'On hand', align: 'right', render: (l) => fmtQty(l.p.on_hand) },
            { label: 'Cover', align: 'right', render: (l) => (l.rec.cover === null ? '—' : `${Math.floor(l.rec.cover)}d`) },
            { label: 'Order', align: 'right', render: (l) => html`<strong>${fmtQty(l.rec.qty)}</strong>${l.p.pack_size > 1 ? html`<span class="sub">${l.rec.qty / l.p.pack_size} × ${l.p.pack_size}</span>` : ''}` },
            { label: 'Cost', align: 'right', render: (l) => m(l.rec.orderCost) },
            { label: '', render: (l) => badge(STATUS_LABEL[l.rec.status], STATUS_TONE[l.rec.status]) },
          ],
          rows: po.lines,
        })}
        <textarea id="po${idx}" rows="8" readonly class="mono" style="margin-top:.8rem">${poText({ po, business, today, user: ctx.user.name })}</textarea>`,
      ))}`,
    );
  });

  app.get('/orders.csv', (ctx) => {
    const supplier = String(ctx.query.supplier ?? '');
    const po = purchaseOrders(analyse(ctx.user.id, ctx.settings, ctx.today()), { includeSoon: ctx.query.soon === '1' }).find((x) => x.supplier === supplier);
    if (!po) throw new HttpError(404, 'Nothing to order for that supplier.');
    return download(`purchase-order-${supplier || 'unassigned'}.csv`, toCsv(po.lines, [
      { label: 'sku', value: (l) => l.p.sku }, { label: 'name', value: (l) => l.p.name }, { label: 'quantity', value: (l) => l.rec.qty },
      { label: 'pack_size', value: (l) => l.p.pack_size }, { label: 'unit_cost', value: (l) => l.p.unit_cost / 100 }, { label: 'line_cost', value: (l) => l.rec.orderCost / 100 },
    ]));
  });

  app.post('/orders/mark', (ctx) => {
    const supplier = String(ctx.body.supplier ?? '');
    const po = purchaseOrders(analyse(ctx.user.id, ctx.settings, ctx.today()), { includeSoon: ctx.body.soon === '1' }).find((x) => x.supplier === supplier);
    if (!po) return redirect('/orders', { err: 'Those items are no longer due — nothing was changed.' });
    db.tx(() => po.lines.forEach((l) => db.run('UPDATE products SET on_order = on_order + ? WHERE id = ? AND user_id = ?', l.rec.qty, l.p.id, ctx.user.id)));
    return redirect('/orders', { ok: `Marked ${po.lines.length} item${po.lines.length === 1 ? '' : 's'} as ordered from ${supplier || 'your supplier'}.` });
  });

  // ---- import ----------------------------------------------------------------------
  const importPage = (ctx, extra = '', values = {}) =>
    ctx.page(
      'Import data',
      html`${pageHeader('Import data', '', 'Two simple files. Re-importing is safe: products are updated by SKU, and sales replace the same SKU + date.')}${extra}
      <div class="grid-2">
        ${card('1. Products & stock', html`<form method="post" action="/import/products">${csrfField(ctx)}
          <p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#products_csv"></p>
          ${field({ label: 'CSV', name: 'csv', type: 'textarea', rows: 9, id: 'products_csv', value: values.products ?? '', required: true, placeholder: 'sku,name,supplier,stock,lead_time,cost,moq,case_size\nA-100,Basmati 5kg,Agro Foods,120,5,410,100,10' })}
          <p class="help">Columns: sku (required), name, supplier, stock / on_hand, on_order, cost, lead_time, moq, case_size. Blank cells keep existing values.</p>
          <button class="btn btn-primary" type="submit">Import products</button></form>`)}
        ${card('2. Sales history', html`<form method="post" action="/import/sales">${csrfField(ctx)}
          <p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#sales_csv"></p>
          ${field({ label: 'CSV', name: 'csv', type: 'textarea', rows: 9, id: 'sales_csv', value: values.sales ?? '', required: true, placeholder: 'sku,date,qty\nA-100,2026-10-01,14\nA-100,2026-10-02,9' })}
          <p class="help">One row per sale or per day: sku, date, qty. Eight or more weeks of history gives the best results.</p>
          <button class="btn btn-primary" type="submit">Import sales</button></form>`)}
      </div>`,
    );
  app.get('/import', (ctx) => importPage(ctx));

  const errorTable = (errors) => card(`${errors.length} row${errors.length === 1 ? '' : 's'} need attention`, table({ columns: [{ label: 'Line', render: (e) => e.line }, { label: 'Problem', render: (e) => e.message }], rows: errors.slice(0, 100) }));

  app.post('/import/products', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    let parsed;
    try {
      parsed = parseProductCsv(text);
    } catch (err) {
      return importPage(ctx, html`<div class="flash flash-err">${err.message}</div>`, { products: text });
    }
    if (parsed.missing.length) return importPage(ctx, html`<div class="flash flash-err">Couldn't find a SKU column. Add a header row such as <span class="mono">sku,name,stock,supplier</span>.</div>`, { products: text });
    let created = 0;
    let updated = 0;
    let overLimit = 0;
    db.tx(() => {
      let total = skuCount(ctx.user.id);
      const limit = ctx.limit('skus');
      for (const r of parsed.rows) {
        const existing = db.get('SELECT id FROM products WHERE user_id = ? AND sku = ? COLLATE NOCASE', ctx.user.id, r.sku);
        if (existing) {
          db.run(
            `UPDATE products SET name = ?, supplier = CASE WHEN ? != '' THEN ? ELSE supplier END, on_hand = COALESCE(?, on_hand), on_order = COALESCE(?, on_order), unit_cost = COALESCE(?, unit_cost),
             lead_time_days = COALESCE(?, lead_time_days), min_order_qty = COALESCE(?, min_order_qty), pack_size = COALESCE(?, pack_size) WHERE id = ?`,
            r.name, r.supplier, r.supplier, r.on_hand, r.on_order, r.unit_cost, r.lead_time_days, r.min_order_qty, r.pack_size, existing.id,
          );
          updated++;
        } else if (total + 1 > limit) {
          overLimit++;
        } else {
          db.run(
            `INSERT INTO products (user_id, sku, name, supplier, on_hand, on_order, unit_cost, lead_time_days, min_order_qty, pack_size, created_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ctx.user.id, r.sku, r.name, r.supplier, r.on_hand ?? 0, r.on_order ?? 0, r.unit_cost ?? 0, r.lead_time_days ?? 7, r.min_order_qty ?? 1, r.pack_size ?? 1, ctx.today(), ctx.now(),
          );
          total++;
          created++;
        }
      }
    });
    const msg = `Imported ${created} new, updated ${updated}${overLimit ? `; ${overLimit} skipped because your ${ctx.planInfo.label} plan allows ${ctx.limit('skus').toLocaleString('en-US')} SKUs — upgrade on the Billing page` : ''}.`;
    if (parsed.errors.length) return importPage(ctx, html`<div class="flash flash-ok">${msg}</div>${errorTable(parsed.errors)}`);
    return redirect('/dashboard', { ok: msg });
  }, { maxBody: 5 * 1024 * 1024 });

  app.post('/import/sales', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    const today = ctx.today();
    let parsed;
    try {
      parsed = parseSalesCsv(text, { dayFirst: ctx.user.currency === 'INR', today });
    } catch (err) {
      return importPage(ctx, html`<div class="flash flash-err">${err.message}</div>`, { sales: text });
    }
    if (parsed.missing.length) return importPage(ctx, html`<div class="flash flash-err">Missing column${parsed.missing.length > 1 ? 's' : ''}: ${parsed.missing.join(', ')}. The header row should be <span class="mono">sku,date,qty</span>.</div>`, { sales: text });
    const ids = new Map(db.all('SELECT id, sku FROM products WHERE user_id = ?', ctx.user.id).map((p) => [p.sku.toLowerCase(), p.id]));
    const unknown = new Set();
    let applied = 0;
    let first = null;
    let last = null;
    db.tx(() => {
      for (const r of parsed.rows) {
        const pid = ids.get(r.sku.toLowerCase());
        if (!pid) {
          unknown.add(r.sku);
          continue;
        }
        db.run('INSERT OR REPLACE INTO sales (product_id, day, qty) VALUES (?, ?, ?)', pid, r.day, r.qty);
        applied++;
        if (!first || r.day < first) first = r.day;
        if (!last || r.day > last) last = r.day;
      }
      db.run('DELETE FROM sales WHERE day < ? AND product_id IN (SELECT id FROM products WHERE user_id = ?)', addDays(today, -400), ctx.user.id);
    });
    const msg = applied ? `Loaded ${applied.toLocaleString('en-US')} daily sales records (${formatDate(first)} – ${formatDate(last)}).` : 'No sales rows were loaded.';
    const problems = [...parsed.errors];
    if (unknown.size) problems.push({ line: '—', message: `${unknown.size} SKU${unknown.size === 1 ? '' : 's'} not in your product list were skipped: ${[...unknown].slice(0, 8).join(', ')}${unknown.size > 8 ? '…' : ''}. Import those products first.` });
    if (problems.length) return importPage(ctx, html`<div class="flash ${applied ? 'flash-ok' : 'flash-err'}">${msg}</div>${errorTable(problems)}`);
    return redirect('/dashboard', { ok: msg });
  }, { maxBody: 12 * 1024 * 1024 });

  // ---- settings ----------------------------------------------------------------------
  app.get('/settings', (ctx) => {
    const s = ctx.settings;
    return ctx.page(
      'Settings',
      html`${pageHeader('Settings', '', 'These control every recommendation.')}
      <form method="post" action="/settings">${csrfField(ctx)}
        ${card('Planning rules', html`
          ${field({ label: 'Service level', name: 'service_level', type: 'select', options: [['90', '90% — lean stock'], ['95', '95% — balanced'], ['98', '98% — protect availability'], ['99', '99% — near-zero stockouts']], value: String(s.service_level), help: 'Higher service levels hold more safety stock.' })}
          ${field({ label: 'Order cycle (days of cover beyond lead time)', name: 'review_days', type: 'number', value: s.review_days, attrs: { min: 0, max: 180 }, help: 'How often you place orders. Shorter = smaller, more frequent orders.' })}
          ${field({ label: 'Demand window (days)', name: 'window_days', type: 'number', value: s.window_days, attrs: { min: 14, max: 180 }, help: 'How much recent history drives the average. 56 (8 weeks) suits most businesses.' })}
          ${field({ label: 'Overstock above (days of cover)', name: 'overstock_days', type: 'number', value: s.overstock_days, attrs: { min: 30, max: 720 } })}
          ${field({ label: 'Dead stock after (days without a sale)', name: 'dead_days', type: 'number', value: s.dead_days, attrs: { min: 14, max: 720 } })}`)}
        ${card('Purchase orders', field({ label: 'Business name (shown in PO emails)', name: 'business_name', value: s.business_name, placeholder: ctx.user.name }))}
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>`,
    );
  });

  app.post('/settings', (ctx) => {
    const b = ctx.body;
    const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || d));
    ctx.saveSettings({
      business_name: clean(b.business_name, 100),
      service_level: ['90', '95', '98', '99'].includes(b.service_level) ? b.service_level : '95',
      review_days: int(b.review_days, 0, 180, 14),
      window_days: int(b.window_days, 14, 180, 56),
      overstock_days: int(b.overstock_days, 30, 720, 120),
      dead_days: int(b.dead_days, 14, 720, 60),
    });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  return app;
}
