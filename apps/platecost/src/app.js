import {
  HttpError, badge, card, clean, createApp, csrfField, download, emptyState, field, formatDate, formatMoney, html, pageHeader, raw,
  parseAmount, redirect, ring, statGrid, table, toArray, toCsv, toMinor, vbars,
} from '@saas/core';
import { UNITS, costPerUnit, convert, dishCost, exTax, margin, normUnit, parseIngredientCsv, priceImpact, status, suggestPrice } from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE ingredients (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'kg',
    pack_qty REAL NOT NULL DEFAULT 1,
    pack_price INTEGER NOT NULL DEFAULT 0,
    yield_pct REAL NOT NULL DEFAULT 100,
    supplier TEXT NOT NULL DEFAULT '',
    updated_on TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name COLLATE NOCASE)
  );
  CREATE TABLE price_history (
    id INTEGER PRIMARY KEY,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    pack_price INTEGER NOT NULL
  );
  CREATE INDEX price_history_ing ON price_history (ingredient_id, id);
  CREATE TABLE dishes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    portions REAL NOT NULL DEFAULT 1,
    sell_price INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name COLLATE NOCASE)
  );
  CREATE TABLE dish_items (
    id INTEGER PRIMARY KEY,
    dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    qty REAL NOT NULL,
    unit TEXT NOT NULL
  );
  CREATE INDEX dish_items_dish ON dish_items (dish_id, position);
  CREATE INDEX dish_items_ing ON dish_items (ingredient_id);
  `,
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { ingredients: 25, dishes: 8 }, blurb: 'Cost your first menu items.', features: ['Food-cost % and margin', 'Price-change alerts'] },
  starter: { label: 'Starter', price: { INR: 999, USD: 39 }, limits: { ingredients: 150, dishes: 60 }, blurb: 'For a single café or bakery.', features: ['CSV import & export', 'Price history'] },
  pro: { label: 'Pro', price: { INR: 2499, USD: 79 }, limits: { ingredients: 600, dishes: 250 }, featured: true, blurb: 'For busy restaurants and cloud kitchens.', features: ['Everything in Starter', 'Priority support'] },
  business: { label: 'Business', price: { INR: 4999, USD: 149 }, limits: { ingredients: 3000, dishes: 1500 }, blurb: 'For groups and multi-brand kitchens.', features: ['Everything in Pro', 'Onboarding call'] },
};

const ST_LABEL = { ok: 'On target', watch: 'Watch', over: 'Over target', no_price: 'No price' };
const ST_TONE = { ok: 'good', watch: 'warn', over: 'bad', no_price: 'neutral' };

export function createPlateCost(options = {}) {
  const app = createApp({
    slug: 'platecost',
    name: 'PlateCost',
    tagline: 'Know what every dish really costs — and earns',
    accent: '#b8f23b',
    glyph: 'plate',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/dishes', label: 'Dishes' },
      { href: '/ingredients', label: 'Ingredients' },
      { href: '/import', label: 'Import' },
      { href: '/settings', label: 'Settings' },
    ],
    plans: PLANS,
    limitLabels: { ingredients: 'ingredients', dishes: 'dishes' },
    migrations: MIGRATIONS,
    settingsDefaults: { business_name: '', target_pct: 30, tax_pct: 0 },
    usage: (db, user) => ({
      ingredients: db.get('SELECT COUNT(*) AS n FROM ingredients WHERE user_id = ?', user.id).n,
      dishes: db.get('SELECT COUNT(*) AS n FROM dishes WHERE user_id = ?', user.id).n,
    }),
    marketing: {
      audience: 'For cafés, bakeries, restaurants and cloud kitchens',
      headline: 'Know the real cost of every dish before the supplier invoice hurts.',
      sub: 'Enter your ingredient prices and recipes once. PlateCost shows food-cost %, margin per plate and the price that hits your target — and when a supplier raises a price, which dishes just stopped making money.',
      preview: { chartTitle: 'Food cost % by dish (target 30%)', ringTitle: 'Dishes on target', bars: [{ label: 'Wrap', value: 42 }, { label: 'Biryani', value: 36 }, { label: 'Soup', value: 31 }, { label: 'Latte', value: 24 }, { label: 'Pasta', value: 29 }, { label: 'Brownie', value: 22 }], ring: { value: 64, text: '64%', label: 'of dishes', note: '5 dishes need a price or recipe change' }, kpis: [{ label: 'Average food cost', value: '31.4%', delta: '+1.8 pts', deltaTone: 'bad' }, { label: 'Dishes over target', value: '5', delta: 'of 14', deltaTone: 'warn' }, { label: 'Biggest mover', value: 'Paneer', delta: '+₹60/kg', deltaTone: 'bad' }] },
      points: [
        { title: 'True plate cost', body: 'Pack prices, usable yield after trimming, and recipe quantities in any unit — grams, kilos, millilitres, litres, pieces.' },
        { title: 'Price to hit your target', body: 'See the exact selling price that delivers your food-cost goal, rounded to a sensible menu price.' },
        { title: 'Supplier price alerts', body: 'Change an ingredient price and instantly see every affected dish and which ones tip over target.' },
        { title: 'Works from a spreadsheet', body: 'Import your ingredient list from a CSV in a minute. No integrations to set up.' },
      ],
      steps: [
        { title: 'Add ingredients', body: 'Pack size, pack price and usable yield.' },
        { title: 'Build recipes', body: 'Add ingredients and quantities per dish, and set the menu price.' },
        { title: 'Act on the numbers', body: 'Reprice, resize or swap — and watch the margin move.' },
      ],
      faq: [
        { q: 'What is “yield”?', a: 'The share of what you buy that ends up usable. Tomatoes at 90% yield mean 10% is lost to trimming, so each usable kilo costs more than the pack price suggests.' },
        { q: 'Does it include labour or rent?', a: 'No. PlateCost covers ingredient (food) cost and the margin over it. You decide how to treat labour and overheads.' },
        { q: 'Are the results guaranteed?', a: 'They are calculations from the prices and quantities you enter. Check them against your own records before changing menu prices.' },
      ],
    },
    ...options,
  });

  const { db } = app;
  const money = (ctx) => (m) => formatMoney(m, ctx.user.currency);
  const settingsNum = (ctx) => ({ target: Number(ctx.settings.target_pct) || 30, tax: Number(ctx.settings.tax_pct) || 0 });

  // ---- data loading --------------------------------------------------------------
  function loadAll(userId) {
    const ingredients = new Map(db.all('SELECT * FROM ingredients WHERE user_id = ?', userId).map((i) => [i.id, i]));
    const dishes = db.all('SELECT * FROM dishes WHERE user_id = ? ORDER BY name COLLATE NOCASE', userId);
    const itemsByDish = new Map();
    for (const it of db.all('SELECT di.* FROM dish_items di JOIN dishes d ON d.id = di.dish_id WHERE d.user_id = ? ORDER BY di.dish_id, di.position', userId)) {
      (itemsByDish.get(it.dish_id) ?? itemsByDish.set(it.dish_id, []).get(it.dish_id)).push(it);
    }
    return { ingredients, dishes, itemsByDish };
  }

  function analyse(ctx) {
    const { target, tax } = settingsNum(ctx);
    const all = loadAll(ctx.user.id);
    const rows = all.dishes.map((d) => {
      const cost = dishCost(d, all.itemsByDish.get(d.id) ?? [], all.ingredients);
      const m = margin(exTax(d.sell_price, tax), cost.perPortion);
      return { d, cost, m, st: status(m.foodCostPct, target), suggest: suggestPrice(cost.perPortion, target) };
    });
    return { ...all, rows, target, tax };
  }

  const getIngredient = (ctx, id) => {
    const i = db.get('SELECT * FROM ingredients WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!i) throw new HttpError(404, 'Ingredient not found');
    return i;
  };
  const getDish = (ctx, id) => {
    const d = db.get('SELECT * FROM dishes WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!d) throw new HttpError(404, 'Dish not found');
    return d;
  };

  // ---- dashboard -------------------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const a = analyse(ctx);
    const m = money(ctx);
    if (!a.ingredients.size && !a.rows.length) {
      return ctx.page('Dashboard', html`${pageHeader('Dashboard')}${emptyState('Start with your ingredients', 'Import a CSV of ingredients and their pack prices, or add them one by one. Then build your dishes.', html`<p><a class="btn btn-primary" href="/import">Import ingredients</a> <a class="btn" href="/ingredients">Add manually</a></p>`)}`);
    }
    const priced = a.rows.filter((r) => r.m.foodCostPct !== null);
    const avg = priced.length ? Math.round((priced.reduce((n, r) => n + r.m.foodCostPct, 0) / priced.length) * 10) / 10 : null;
    const over = a.rows.filter((r) => ['over', 'watch'].includes(r.st));
    const onTarget = priced.filter((r) => r.st === 'ok').length;
    const worst = [...priced].sort((x, y) => y.m.foodCostPct - x.m.foodCostPct).slice(0, 7);
    return ctx.page(
      'Dashboard',
      html`${pageHeader('Dashboard', html`<a class="btn btn-primary" href="/dishes/new">New dish</a>`, `Target food cost: ${a.target}%`)}
      ${statGrid([
        { label: 'Dishes', value: a.rows.length, hint: `${a.ingredients.size} ingredients` },
        { label: 'Average food cost', value: avg === null ? '—' : `${avg}%`, tone: avg !== null && avg > a.target ? 'warn' : '', hint: `target ${a.target}%` },
        { label: 'Need attention', value: over.length, tone: over.length ? 'bad' : 'good', hint: 'above target food cost' },
        { label: 'Average margin per plate', value: priced.length ? m(Math.round(priced.reduce((n, r) => n + r.m.margin, 0) / priced.length)) : '—', hint: 'before labour and overheads' },
      ])}
      ${priced.length ? html`<div class="viz">${card('Highest food cost % by dish', vbars({ height: 170, format: (v) => `${v}%`, items: worst.map((r) => ({ label: r.d.name.slice(0, 9), value: Math.round(r.m.foodCostPct), tone: r.st === 'over' ? 'bad' : r.st === 'watch' ? 'warn' : '' })) }))}
        ${card('Dishes on target', html`${ring({ value: onTarget, max: priced.length, text: `${Math.round((onTarget / priced.length) * 100)}%`, label: 'of priced dishes' })}<p class="muted center">${priced.length - onTarget} above the ${a.target}% target</p>`, { className: 'ring-card' })}</div>` : ''}
      ${card('Fix these first', table({
        columns: [
          { label: 'Dish', render: (r) => html`<a href="/dishes/${r.d.id}"><strong>${r.d.name}</strong></a>${r.d.category ? html`<span class="sub">${r.d.category}</span>` : ''}` },
          { label: 'Cost / plate', align: 'right', render: (r) => m(r.cost.perPortion) },
          { label: 'Price', align: 'right', render: (r) => m(r.d.sell_price) },
          { label: 'Food cost', align: 'right', render: (r) => (r.m.foodCostPct === null ? '—' : `${r.m.foodCostPct}%`) },
          { label: 'Price for target', align: 'right', render: (r) => m(Math.round(r.suggest.rounded * (1 + a.tax / 100))) },
          { label: '', render: (r) => badge(ST_LABEL[r.st], ST_TONE[r.st]) },
        ],
        rows: [...over].sort((x, y) => y.m.foodCostPct - x.m.foodCostPct).slice(0, 10),
        empty: a.rows.length ? 'Every priced dish is within target. 🎉' : 'Add your first dish to see costs here.',
      }))}`,
    );
  });

  // ---- ingredients -------------------------------------------------------------------
  const unitOptions = UNITS.map((u) => [u, u]);
  const ingredientForm = (ctx, i = {}) => html`<form method="post" action="${i.id ? `/ingredients/${i.id}/edit` : '/ingredients'}">${csrfField(ctx)}
    <div class="row">
      ${field({ label: 'Name', name: 'name', value: i.name ?? '', required: true })}
      ${field({ label: 'Supplier', name: 'supplier', value: i.supplier ?? '' })}
    </div>
    <div class="row">
      ${field({ label: 'Pack size', name: 'pack_qty', value: i.pack_qty ?? 1, required: true, attrs: { inputmode: 'decimal' } })}
      ${field({ label: 'Unit', name: 'unit', type: 'select', options: unitOptions, value: i.unit ?? 'kg' })}
      ${field({ label: `Pack price (${ctx.user.currency})`, name: 'pack_price', value: i.pack_price != null ? i.pack_price / 100 : '', required: true, attrs: { inputmode: 'decimal' } })}
      ${field({ label: 'Usable yield %', name: 'yield_pct', value: i.yield_pct ?? 100, attrs: { inputmode: 'decimal' }, help: 'Share left after trimming/cooking loss.' })}
    </div>
    <button class="btn btn-primary" type="submit">${i.id ? 'Save changes' : 'Add ingredient'}</button></form>`;

  function readIngredient(ctx) {
    const b = ctx.body;
    const qty = parseAmount(b.pack_qty);
    const price = parseAmount(b.pack_price);
    const y = b.yield_pct === '' || b.yield_pct === undefined ? 100 : parseAmount(b.yield_pct);
    const v = { name: clean(b.name, 120), supplier: clean(b.supplier, 100), unit: UNITS.includes(b.unit) ? b.unit : 'kg', pack_qty: qty, pack_price: toMinor(price), yield_pct: y };
    let error = '';
    if (!v.name) error = 'Name is required.';
    else if (!Number.isFinite(qty) || qty <= 0) error = 'Pack size must be above zero.';
    else if (!Number.isFinite(price) || price < 0 || price > 1e9) error = 'Enter the pack price.';
    else if (!Number.isFinite(y) || y <= 0 || y > 100) error = 'Yield must be between 1 and 100.';
    return { v, error };
  }

  app.get('/ingredients', (ctx) => {
    const m = money(ctx);
    const rows = db.all(`SELECT i.*, (SELECT COUNT(DISTINCT dish_id) FROM dish_items WHERE ingredient_id = i.id) AS used FROM ingredients i WHERE user_id = ? ORDER BY name COLLATE NOCASE`, ctx.user.id);
    return ctx.page(
      'Ingredients',
      html`${pageHeader('Ingredients', html`<a class="btn" href="/ingredients.csv">Export CSV</a><a class="btn" href="/import">Import CSV</a>`)}
      ${card('Add an ingredient', ingredientForm(ctx))}
      ${card('', table({
        columns: [
          { label: 'Ingredient', render: (i) => html`<a href="/ingredients/${i.id}"><strong>${i.name}</strong></a>${i.supplier ? html`<span class="sub">${i.supplier}</span>` : ''}` },
          { label: 'Pack', render: (i) => `${i.pack_qty} ${i.unit}` },
          { label: 'Pack price', align: 'right', render: (i) => m(i.pack_price) },
          { label: 'Cost per usable unit', align: 'right', render: (i) => html`${m(Math.round(costPerUnit(i)))} / ${i.unit}` },
          { label: 'Yield', align: 'right', render: (i) => `${i.yield_pct}%` },
          { label: 'Used in', align: 'right', render: (i) => `${i.used} dish${i.used === 1 ? '' : 'es'}` },
        ],
        rows: rows, empty: 'No ingredients yet.',
      }))}`,
    );
  });

  app.get('/ingredients.csv', (ctx) => {
    const rows = db.all('SELECT * FROM ingredients WHERE user_id = ? ORDER BY name COLLATE NOCASE', ctx.user.id);
    return download('ingredients.csv', toCsv(rows, [
      { key: 'name', label: 'name' }, { key: 'unit', label: 'unit' }, { key: 'pack_qty', label: 'pack_qty' }, { label: 'pack_price', value: (r) => r.pack_price / 100 },
      { key: 'yield_pct', label: 'yield' }, { key: 'supplier', label: 'supplier' },
    ]));
  });

  app.post('/ingredients', (ctx) => {
    const { v, error } = readIngredient(ctx);
    if (error) return redirect('/ingredients', { err: error });
    const limitMsg = ctx.checkLimit('ingredients', db.get('SELECT COUNT(*) AS n FROM ingredients WHERE user_id = ?', ctx.user.id).n);
    if (limitMsg) return redirect('/ingredients', { err: limitMsg });
    if (db.get('SELECT 1 AS x FROM ingredients WHERE user_id = ? AND name = ? COLLATE NOCASE', ctx.user.id, v.name)) return redirect('/ingredients', { err: `${v.name} already exists. Edit it instead.` });
    const id = db.tx(() => {
      const iid = db.run('INSERT INTO ingredients (user_id, name, unit, pack_qty, pack_price, yield_pct, supplier, updated_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ctx.user.id, v.name, v.unit, v.pack_qty, v.pack_price, v.yield_pct, v.supplier, ctx.today(), ctx.now()).id;
      db.run('INSERT INTO price_history (ingredient_id, day, pack_price) VALUES (?, ?, ?)', iid, ctx.today(), v.pack_price);
      return iid;
    });
    return redirect(`/ingredients/${id}`, { ok: 'Ingredient added.' });
  });

  app.get('/ingredients/:id', (ctx) => {
    const i = getIngredient(ctx, ctx.params.id);
    const m = money(ctx);
    const history = db.all('SELECT * FROM price_history WHERE ingredient_id = ? ORDER BY id DESC LIMIT 20', i.id);
    const used = db.all('SELECT DISTINCT d.id, d.name FROM dish_items di JOIN dishes d ON d.id = di.dish_id WHERE di.ingredient_id = ? AND d.user_id = ? ORDER BY d.name COLLATE NOCASE', i.id, ctx.user.id);
    return ctx.page(
      i.name,
      html`${pageHeader(i.name, '', `${i.pack_qty} ${i.unit} for ${m(i.pack_price)} · ${m(Math.round(costPerUnit(i)))} per usable ${i.unit}`)}
      <div class="grid-2">
        ${card('Price history', table({ columns: [{ label: 'Date', render: (h) => formatDate(h.day) }, { label: 'Pack price', align: 'right', render: (h) => m(h.pack_price) }], rows: history }))}
        ${card('Used in', used.length ? html`<ul>${used.map((d) => html`<li><a href="/dishes/${d.id}">${d.name}</a></li>`)}</ul>` : html`<p class="muted">Not used in any dish yet.</p>`)}
      </div>
      ${card('Details', ingredientForm(ctx, i))}
      <form method="post" action="/ingredients/${i.id}/delete" data-confirm="Delete this ingredient?">${csrfField(ctx)}<button class="btn btn-danger" type="submit">Delete ingredient</button></form>`,
    );
  });

  app.post('/ingredients/:id/edit', (ctx) => {
    const i = getIngredient(ctx, ctx.params.id);
    const { v, error } = readIngredient(ctx);
    if (error) return redirect(`/ingredients/${i.id}`, { err: error });
    if (v.name.toLowerCase() !== i.name.toLowerCase() && db.get('SELECT 1 AS x FROM ingredients WHERE user_id = ? AND name = ? COLLATE NOCASE', ctx.user.id, v.name)) return redirect(`/ingredients/${i.id}`, { err: `${v.name} already exists.` });
    let note = '';
    if (v.pack_price !== i.pack_price || v.pack_qty !== i.pack_qty || v.yield_pct !== i.yield_pct) {
      const { target, tax } = settingsNum(ctx);
      const all = loadAll(ctx.user.id);
      const impact = priceImpact({ id: i.id, next: { ...i, unit: v.unit, pack_qty: v.pack_qty, pack_price: v.pack_price, yield_pct: v.yield_pct }, dishes: all.dishes, itemsByDish: all.itemsByDish, ingredients: all.ingredients, taxPct: tax, targetPct: target });
      note = impact.affected.length ? ` Affects ${impact.affected.length} dish${impact.affected.length === 1 ? '' : 'es'}${impact.newlyOver ? `; ${impact.newlyOver} ${impact.newlyOver === 1 ? 'is' : 'are'} now over your ${target}% target` : ''}.` : '';
    }
    db.tx(() => {
      db.run('UPDATE ingredients SET name = ?, supplier = ?, unit = ?, pack_qty = ?, pack_price = ?, yield_pct = ?, updated_on = ? WHERE id = ?', v.name, v.supplier, v.unit, v.pack_qty, v.pack_price, v.yield_pct, ctx.today(), i.id);
      if (v.pack_price !== i.pack_price) db.run('INSERT INTO price_history (ingredient_id, day, pack_price) VALUES (?, ?, ?)', i.id, ctx.today(), v.pack_price);
    });
    return redirect(`/ingredients/${i.id}`, { ok: `Saved.${note}` });
  });

  app.post('/ingredients/:id/delete', (ctx) => {
    const i = getIngredient(ctx, ctx.params.id);
    if (db.get('SELECT 1 AS x FROM dish_items WHERE ingredient_id = ?', i.id)) return redirect(`/ingredients/${i.id}`, { err: 'This ingredient is used in a recipe. Remove it from those dishes first.' });
    db.run('DELETE FROM ingredients WHERE id = ?', i.id);
    return redirect('/ingredients', { ok: 'Ingredient deleted.' });
  });

  // ---- dishes -------------------------------------------------------------------------
  app.get('/dishes', (ctx) => {
    const a = analyse(ctx);
    const m = money(ctx);
    return ctx.page(
      'Dishes',
      html`${pageHeader('Dishes', html`<a class="btn" href="/dishes.csv">Export CSV</a><a class="btn btn-primary" href="/dishes/new">New dish</a>`)}
      ${card('', table({
        columns: [
          { label: 'Dish', render: (r) => html`<a href="/dishes/${r.d.id}"><strong>${r.d.name}</strong></a>${r.d.category ? html`<span class="sub">${r.d.category}</span>` : ''}` },
          { label: 'Cost / plate', align: 'right', render: (r) => m(r.cost.perPortion) },
          { label: 'Menu price', align: 'right', render: (r) => (r.d.sell_price ? m(r.d.sell_price) : '—') },
          { label: 'Food cost', align: 'right', render: (r) => (r.m.foodCostPct === null ? '—' : `${r.m.foodCostPct}%`) },
          { label: 'Margin / plate', align: 'right', render: (r) => (r.m.margin === null ? '—' : m(r.m.margin)) },
          { label: '', render: (r) => badge(ST_LABEL[r.st], ST_TONE[r.st]) },
        ],
        rows: a.rows, empty: 'No dishes yet. Add ingredients first, then build a recipe.',
      }))}`,
    );
  });

  app.get('/dishes.csv', (ctx) => {
    const a = analyse(ctx);
    return download('dishes.csv', toCsv(a.rows, [
      { label: 'dish', value: (r) => r.d.name }, { label: 'category', value: (r) => r.d.category }, { label: 'cost_per_plate', value: (r) => r.cost.perPortion / 100 },
      { label: 'menu_price', value: (r) => r.d.sell_price / 100 }, { label: 'food_cost_pct', value: (r) => r.m.foodCostPct ?? '' }, { label: 'price_for_target', value: (r) => r.suggest.rounded / 100 },
    ]));
  });

  const lineRow = (a, it = {}) => html`<tr data-repeater-row>
    <td><select name="ing[]" aria-label="Ingredient"><option value="">Choose…</option>${[...a.ingredients.values()].sort((x, y) => x.name.localeCompare(y.name)).map((i) => html`<option value="${i.id}" ${i.id === it.ingredient_id ? raw('selected') : ''}>${i.name} (${i.unit})</option>`)}</select></td>
    <td style="width:7rem"><input type="number" step="any" min="0" name="qty[]" value="${it.qty ?? ''}" aria-label="Quantity"></td>
    <td style="width:6rem"><select name="unit[]" aria-label="Unit">${UNITS.map((u) => html`<option value="${u}" ${u === (it.unit ?? 'g') ? raw('selected') : ''}>${u}</option>`)}</select></td>
    <td style="width:2.5rem"><button type="button" class="btn btn-sm" data-repeater-remove aria-label="Remove">✕</button></td></tr>`;

  const dishForm = (ctx, a, d = {}, items = []) => html`<form method="post" action="${d.id ? `/dishes/${d.id}/edit` : '/dishes'}">${csrfField(ctx)}
    <div class="row">
      ${field({ label: 'Dish name', name: 'name', value: d.name ?? '', required: true })}
      ${field({ label: 'Category', name: 'category', value: d.category ?? '', placeholder: 'Mains, desserts…' })}
      ${field({ label: 'Plates the recipe makes', name: 'portions', value: d.portions ?? 1, attrs: { inputmode: 'decimal' } })}
      ${field({ label: `Menu price (${ctx.user.currency}${a.tax ? `, incl. ${a.tax}% tax` : ''})`, name: 'sell_price', value: d.sell_price ? d.sell_price / 100 : '', attrs: { inputmode: 'decimal' } })}
    </div>
    <div data-repeater><div class="table-wrap"><table><thead><tr><th>Ingredient</th><th>Quantity</th><th>Unit</th><th></th></tr></thead><tbody data-repeater-rows>${(items.length ? items : [{}]).map((it) => lineRow(a, it))}</tbody></table></div>
      <template data-repeater-template>${lineRow(a)}</template><p><button type="button" class="btn btn-sm" data-repeater-add>+ Add ingredient</button></p></div>
    ${field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: d.notes ?? '' })}
    <button class="btn btn-primary" type="submit">${d.id ? 'Save dish' : 'Create dish'}</button></form>`;

  function readDish(ctx, a) {
    const b = ctx.body;
    const price = b.sell_price === '' || b.sell_price === undefined ? 0 : parseAmount(b.sell_price);
    const portions = b.portions === '' || b.portions === undefined ? 1 : parseAmount(b.portions);
    const ids = toArray(b.ing); const qtys = toArray(b.qty); const units = toArray(b.unit);
    const items = [];
    let error = '';
    for (let n = 0; n < ids.length && n < 40 && !error; n++) {
      if (!ids[n] && !qtys[n]) continue;
      const ing = a.ingredients.get(Number(ids[n]));
      const qty = parseAmount(qtys[n]);
      const unit = normUnit(units[n]);
      if (!ing) error = `Line ${n + 1}: choose an ingredient.`;
      else if (!Number.isFinite(qty) || qty <= 0) error = `Line ${n + 1}: enter a quantity above zero.`;
      else if (!unit || convert(1, unit, ing.unit) === null) error = `Line ${n + 1}: ${ing.name} is measured in ${ing.unit}, so use a matching unit (${UNITS.filter((u) => convert(1, u, ing.unit) !== null).join(', ')}).`;
      else items.push({ ingredient_id: ing.id, qty, unit });
    }
    const v = { name: clean(b.name, 120), category: clean(b.category, 60), notes: clean(b.notes, 1000), portions: Number.isFinite(portions) ? portions : NaN, sell_price: toMinor(price) };
    if (!error && !v.name) error = 'Dish name is required.';
    else if (!error && (!(v.portions > 0) || v.portions > 10000)) error = 'Plates per recipe must be above zero.';
    else if (!error && (!Number.isFinite(price) || price < 0 || price > 1e9)) error = 'Enter a valid menu price.';
    else if (!error && !items.length) error = 'Add at least one ingredient.';
    return { v, items, error };
  }

  const writeItems = (dishId, items) => {
    db.run('DELETE FROM dish_items WHERE dish_id = ?', dishId);
    items.forEach((it, n) => db.run('INSERT INTO dish_items (dish_id, ingredient_id, position, qty, unit) VALUES (?, ?, ?, ?, ?)', dishId, it.ingredient_id, n, it.qty, it.unit));
  };

  app.get('/dishes/new', (ctx) => {
    const a = analyse(ctx);
    if (!a.ingredients.size) return redirect('/ingredients', { err: 'Add some ingredients first, then build a dish.' });
    return ctx.page('New dish', html`${pageHeader('New dish')}${card('', dishForm(ctx, a))}`);
  });

  app.post('/dishes', (ctx) => {
    const a = analyse(ctx);
    const { v, items, error } = readDish(ctx, a);
    const again = (msg) => ctx.page('New dish', html`${pageHeader('New dish')}<div class="flash flash-err">${msg}</div>${card('', dishForm(ctx, a, { ...v, sell_price: v.sell_price }, items))}`, { status: 400 });
    if (error) return again(error);
    const limitMsg = ctx.checkLimit('dishes', a.dishes.length);
    if (limitMsg) return redirect('/dishes', { err: limitMsg });
    if (a.dishes.some((d) => d.name.toLowerCase() === v.name.toLowerCase())) return again(`A dish called ${v.name} already exists.`);
    const id = db.tx(() => {
      const did = db.run('INSERT INTO dishes (user_id, name, category, portions, sell_price, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ctx.user.id, v.name, v.category, v.portions, v.sell_price, v.notes, ctx.now()).id;
      writeItems(did, items);
      return did;
    });
    return redirect(`/dishes/${id}`, { ok: 'Dish created.' });
  });

  app.get('/dishes/:id', (ctx) => {
    const d = getDish(ctx, ctx.params.id);
    const a = analyse(ctx);
    const r = a.rows.find((x) => x.d.id === d.id);
    const items = a.itemsByDish.get(d.id) ?? [];
    const m = money(ctx);
    const total = r.cost.total || 1;
    return ctx.page(
      d.name,
      html`${pageHeader(html`${d.name} ${badge(ST_LABEL[r.st], ST_TONE[r.st])}`, html`<form method="post" action="/dishes/${d.id}/duplicate" class="inline">${csrfField(ctx)}<button class="btn" type="submit">Duplicate</button></form>`, d.category)}
      ${r.cost.problems.length ? html`<div class="flash flash-err">${r.cost.problems.join(' · ')}</div>` : ''}
      ${statGrid([
        { label: 'Cost per plate', value: m(r.cost.perPortion), hint: d.portions > 1 ? `recipe makes ${d.portions} plates` : '' },
        { label: 'Menu price', value: d.sell_price ? m(d.sell_price) : '—', hint: a.tax ? `${m(exTax(d.sell_price, a.tax))} before ${a.tax}% tax` : '' },
        { label: 'Food cost', value: r.m.foodCostPct === null ? '—' : `${r.m.foodCostPct}%`, tone: r.st === 'over' ? 'bad' : r.st === 'watch' ? 'warn' : r.st === 'ok' ? 'good' : '', hint: `target ${a.target}%` },
        { label: 'Margin per plate', value: r.m.margin === null ? '—' : m(r.m.margin), hint: r.m.marginPct === null ? '' : `${r.m.marginPct}% of price` },
        { label: `Price for ${a.target}% target`, value: r.cost.perPortion ? m(Math.round(r.suggest.rounded * (1 + a.tax / 100))) : '—', hint: 'rounded up to a whole unit' },
      ])}
      ${card('Cost breakdown', table({
        columns: [
          { label: 'Ingredient', render: (l) => l.name }, { label: 'Quantity', align: 'right', render: (l) => `${l.qty} ${l.unit}` },
          { label: 'Cost', align: 'right', render: (l) => m(l.cost) }, { label: 'Share', align: 'right', render: (l) => `${Math.round((l.cost / total) * 100)}%` },
        ],
        rows: r.cost.lines,
      }))}
      ${card('Recipe', dishForm(ctx, a, d, items))}
      <form method="post" action="/dishes/${d.id}/delete" data-confirm="Delete this dish?">${csrfField(ctx)}<button class="btn btn-danger" type="submit">Delete dish</button></form>`,
    );
  });

  app.post('/dishes/:id/edit', (ctx) => {
    const d = getDish(ctx, ctx.params.id);
    const a = analyse(ctx);
    const { v, items, error } = readDish(ctx, a);
    if (error) return redirect(`/dishes/${d.id}`, { err: error });
    if (a.dishes.some((x) => x.id !== d.id && x.name.toLowerCase() === v.name.toLowerCase())) return redirect(`/dishes/${d.id}`, { err: `A dish called ${v.name} already exists.` });
    db.tx(() => {
      db.run('UPDATE dishes SET name = ?, category = ?, portions = ?, sell_price = ?, notes = ? WHERE id = ?', v.name, v.category, v.portions, v.sell_price, v.notes, d.id);
      writeItems(d.id, items);
    });
    return redirect(`/dishes/${d.id}`, { ok: 'Saved.' });
  });

  app.post('/dishes/:id/duplicate', (ctx) => {
    const d = getDish(ctx, ctx.params.id);
    const limitMsg = ctx.checkLimit('dishes', db.get('SELECT COUNT(*) AS n FROM dishes WHERE user_id = ?', ctx.user.id).n);
    if (limitMsg) return redirect(`/dishes/${d.id}`, { err: limitMsg });
    let name = `${d.name} (copy)`;
    for (let n = 2; db.get('SELECT 1 AS x FROM dishes WHERE user_id = ? AND name = ? COLLATE NOCASE', ctx.user.id, name); n++) name = `${d.name} (copy ${n})`;
    const id = db.tx(() => {
      const did = db.run('INSERT INTO dishes (user_id, name, category, portions, sell_price, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ctx.user.id, name, d.category, d.portions, d.sell_price, d.notes, ctx.now()).id;
      writeItems(did, db.all('SELECT * FROM dish_items WHERE dish_id = ? ORDER BY position', d.id));
      return did;
    });
    return redirect(`/dishes/${id}`, { ok: 'Duplicated.' });
  });

  app.post('/dishes/:id/delete', (ctx) => {
    db.run('DELETE FROM dishes WHERE id = ?', getDish(ctx, ctx.params.id).id);
    return redirect('/dishes', { ok: 'Dish deleted.' });
  });

  // ---- import ----------------------------------------------------------------------------
  const importPage = (ctx, extra = '', text = '') => ctx.page(
    'Import ingredients',
    html`${pageHeader('Import ingredients', '', 'Paste a CSV or choose a file. Ingredients with the same name are updated, and price changes are recorded.')}${extra}
    ${card('', html`<form method="post" action="/import">${csrfField(ctx)}
      <p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#csv"></p>
      ${field({ label: 'CSV data', name: 'csv', type: 'textarea', rows: 12, id: 'csv', value: text, required: true, placeholder: 'name,unit,pack_qty,pack_price,yield,supplier\nPaneer,kg,1,360,100,Dairy Co\nTomato,kg,1,40,90,Veg Mart' })}
      <p class="help">Columns: name, pack_price (required); unit (g, kg, ml, l, pcs), pack_qty, yield, supplier.</p>
      <button class="btn btn-primary" type="submit">Import</button></form>`)}`,
  );
  app.get('/import', (ctx) => importPage(ctx));
  app.post('/import', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    let parsed;
    try { parsed = parseIngredientCsv(text); } catch (err) { return importPage(ctx, html`<div class="flash flash-err">${err.message}</div>`, text); }
    if (parsed.missing.length) return importPage(ctx, html`<div class="flash flash-err">Missing column: ${parsed.missing.join(', ')}. The header row needs at least <span class="mono">name,pack_price</span>.</div>`, text);
    let created = 0; let updated = 0; let over = 0;
    db.tx(() => {
      let total = db.get('SELECT COUNT(*) AS n FROM ingredients WHERE user_id = ?', ctx.user.id).n;
      const limit = ctx.limit('ingredients');
      for (const r of parsed.rows) {
        const ex = db.get('SELECT * FROM ingredients WHERE user_id = ? AND name = ? COLLATE NOCASE', ctx.user.id, r.name);
        if (ex) {
          db.run('UPDATE ingredients SET unit = ?, pack_qty = ?, pack_price = ?, yield_pct = ?, supplier = CASE WHEN ? != \'\' THEN ? ELSE supplier END, updated_on = ? WHERE id = ?', r.unit, r.pack_qty, r.pack_price, r.yield_pct, r.supplier, r.supplier, ctx.today(), ex.id);
          if (ex.pack_price !== r.pack_price) db.run('INSERT INTO price_history (ingredient_id, day, pack_price) VALUES (?, ?, ?)', ex.id, ctx.today(), r.pack_price);
          updated++;
        } else if (total + 1 > limit) over++;
        else {
          const id = db.run('INSERT INTO ingredients (user_id, name, unit, pack_qty, pack_price, yield_pct, supplier, updated_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ctx.user.id, r.name, r.unit, r.pack_qty, r.pack_price, r.yield_pct, r.supplier, ctx.today(), ctx.now()).id;
          db.run('INSERT INTO price_history (ingredient_id, day, pack_price) VALUES (?, ?, ?)', id, ctx.today(), r.pack_price);
          total++; created++;
        }
      }
    });
    const msg = `Imported ${created} new, updated ${updated}${over ? `; ${over} skipped because your ${ctx.planInfo.label} plan allows ${ctx.limit('ingredients').toLocaleString('en-US')} ingredients — upgrade on the Billing page` : ''}.`;
    if (parsed.errors.length) return importPage(ctx, html`<div class="flash flash-ok">${msg}</div>${card(`${parsed.errors.length} row${parsed.errors.length === 1 ? '' : 's'} need attention`, table({ columns: [{ label: 'Line', render: (e) => e.line }, { label: 'Problem', render: (e) => e.message }], rows: parsed.errors.slice(0, 100) }))}`);
    return redirect('/ingredients', { ok: msg });
  }, { maxBody: 3 * 1024 * 1024 });

  // ---- settings -------------------------------------------------------------------------------
  app.get('/settings', (ctx) => ctx.page('Settings', html`${pageHeader('Settings')}
    <form method="post" action="/settings">${csrfField(ctx)}${card('Costing rules', html`
      ${field({ label: 'Target food cost %', name: 'target_pct', type: 'number', value: ctx.settings.target_pct, attrs: { min: 5, max: 80, step: 'any' }, help: 'Typical restaurants aim for 25–35%. Dishes above this are flagged.' })}
      ${field({ label: 'Tax included in menu prices (%)', name: 'tax_pct', type: 'number', value: ctx.settings.tax_pct, attrs: { min: 0, max: 40, step: 'any' }, help: 'Enter 0 if your menu prices exclude tax. Food cost is always measured on the price before tax.' })}
      ${field({ label: 'Business name', name: 'business_name', value: ctx.settings.business_name })}`)}
      <button class="btn btn-primary" type="submit">Save settings</button></form>`));
  app.post('/settings', (ctx) => {
    const t = parseAmount(ctx.body.target_pct);
    const x = ctx.body.tax_pct === '' ? 0 : parseAmount(ctx.body.tax_pct);
    ctx.saveSettings({ target_pct: Number.isFinite(t) ? Math.min(80, Math.max(5, t)) : 30, tax_pct: Number.isFinite(x) ? Math.min(40, Math.max(0, x)) : 0, business_name: clean(ctx.body.business_name, 100) });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  return app;
}
