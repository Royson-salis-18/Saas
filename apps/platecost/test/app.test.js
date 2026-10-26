import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createPlateCost } from '../src/app.js';

const boot = (options = {}) => startTestApp(createPlateCost, options);
const CSV = ['name,unit,pack_qty,pack_price,yield,supplier', 'Paneer,kg,1,360,100,Dairy Co', 'Tomato,kg,1,40,90,Veg Mart', 'Cooking oil,l,5,750,100,Oil Depot'].join('\n');
const ing = (t, name) => t.app.db.get('SELECT * FROM ingredients WHERE name = ?', name);

async function ready(t, plan = 'pro') {
  const c = t.client();
  await c.signup('owner@example.com', 'correct horse battery', { currency: 'INR' });
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  await c.post('/import', { csv: CSV });
  return c;
}
const curry = (t, over = {}) => ({
  name: 'Paneer curry', category: 'Mains', portions: '1', sell_price: '250',
  ing: [String(ing(t, 'Paneer').id), String(ing(t, 'Tomato').id)], qty: ['150', '200'], unit: ['g', 'g'], ...over,
});

test('landing page', async () => {
  const t = await boot();
  try {
    const home = (await t.client().get('/')).text;
    assert.match(home, /real cost of every dish/);
    assert.match(home, /₹2,499/);
  } finally {
    await t.close();
  }
});

test('import ingredients; list shows cost per usable unit (yield applied)', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM ingredients').n, 3);
    assert.equal(ing(t, 'Tomato').yield_pct, 90);
    assert.equal(ing(t, 'Cooking oil').pack_price, 75000);
    const page = (await c.get('/ingredients')).text;
    assert.match(page, /₹44\.44 \/ kg/, '₹40 / 0.9 per usable kg');
    assert.match(page, /₹150 \/ l/, '5 litre pack');
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM price_history').n, 3);
    const bad = await c.post('/import', { csv: 'name,qty\nX,1' });
    assert.match(bad.text, /Missing column: pack_price/);
  } finally {
    await t.close();
  }
});

test('a dish is costed exactly, with margin, status and a price for the target', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const r = await c.post('/dishes', curry(t, { sell_price: '180' }));
    assert.equal(r.status, 303);
    const page = (await c.get('/dishes/1')).text;
    assert.match(page, /₹62\.89/, '₹54 paneer + ₹8.89 tomato');
    assert.match(page, /34\.9%/);
    assert.match(page, /Watch/);
    assert.match(page, /₹210/, 'price for 30% target, rounded up');
    assert.match(page, /Paneer/);
    const dash = (await c.get('/dashboard')).text;
    assert.match(dash, /Fix these first/);
    assert.match(dash, /Paneer curry/);
    assert.match((await c.get('/dishes.csv')).text, /Paneer curry,Mains,62.89,180,34.9,210/);
  } finally {
    await t.close();
  }
});

test('raising a supplier price reports affected dishes and which tip over target; history is kept', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/dishes', curry(t));
    assert.match((await c.get('/dishes')).text, /On target/);
    const p = ing(t, 'Paneer');
    await c.post(`/ingredients/${p.id}/edit`, { name: 'Paneer', supplier: 'Dairy Co', pack_qty: '1', unit: 'kg', pack_price: '560', yield_pct: '100' });
    const page = (await c.get(`/ingredients/${p.id}`)).text;
    assert.match(page, /Affects 1 dish; 1 is now over your 30% target/);
    assert.match(page, /₹560/);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM price_history WHERE ingredient_id = ?', p.id).n, 2);
    assert.match((await c.get('/dishes')).text, /Over target/);
    await c.post(`/ingredients/${p.id}/edit`, { name: 'Paneer', supplier: 'Dairy Co', pack_qty: '1', unit: 'kg', pack_price: '560', yield_pct: '100' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM price_history WHERE ingredient_id = ?', p.id).n, 2, 'unchanged prices add no history');
  } finally {
    await t.close();
  }
});

test('recipe validation: unit families, quantities, missing parts', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const paneer = String(ing(t, 'Paneer').id);
    const cases = [
      [{ unit: ['pcs', 'g'] }, /measured in kg, so use a matching unit/],
      [{ qty: ['0', '200'] }, /quantity above zero/],
      [{ ing: ['', String(ing(t, 'Tomato').id)] }, /choose an ingredient/],
      [{ name: '' }, /name is required/i],
      [{ portions: '0' }, /Plates per recipe/],
      [{ ing: [], qty: [], unit: [] }, /at least one ingredient/],
      [{ ing: ['9999'], qty: ['1'], unit: ['g'] }, /choose an ingredient/],
    ];
    for (const [over, re] of cases) {
      const r = await c.post('/dishes', curry(t, over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match(r.text, re);
    }
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM dishes').n, 0);
    assert.equal((await c.post('/dishes', curry(t, { ing: [paneer], qty: ['1'], unit: ['kg'] }))).status, 303);
    const dup = await c.post('/dishes', curry(t, { name: 'PANEER CURRY', ing: [paneer], qty: ['1'], unit: ['kg'] }));
    assert.equal(dup.status, 400);
    assert.match(dup.text, /already exists/);
  } finally {
    await t.close();
  }
});

test('ingredients in use cannot be deleted; deleting the dish frees them; duplicate copies the recipe', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/dishes', curry(t));
    const id = ing(t, 'Paneer').id;
    await c.post(`/ingredients/${id}/delete`);
    assert.ok(ing(t, 'Paneer'), 'still there');
    await c.post('/dishes/1/duplicate');
    assert.equal(t.app.db.get(`SELECT name FROM dishes WHERE id = 2`).name, 'Paneer curry (copy)');
    assert.equal(t.app.db.all('SELECT * FROM dish_items WHERE dish_id = 2').length, 2);
    await c.post('/dishes/1/delete');
    await c.post('/dishes/2/delete');
    await c.post(`/ingredients/${id}/delete`);
    assert.equal(ing(t, 'Paneer'), null);
  } finally {
    await t.close();
  }
});

test('target and tax settings change the verdict and the suggested price', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/dishes', curry(t, { sell_price: '180' }));
    assert.match((await c.get('/dishes')).text, /Watch/);
    await c.post('/settings', { target_pct: '40', tax_pct: '0', business_name: '' });
    assert.match((await c.get('/dishes')).text, /On target/);
    await c.post('/settings', { target_pct: '30', tax_pct: '5', business_name: '' });
    const page = (await c.get('/dishes/1')).text;
    assert.match(page, /before 5% tax/);
    assert.match(page, /36\.7%/, '₹62.89 on ₹171.43 ex-tax');
    await c.post('/settings', { target_pct: '999', tax_pct: '-5', business_name: '' });
    assert.equal(JSON.parse(t.app.db.get('SELECT settings FROM users').settings).target_pct, 80, 'clamped');
  } finally {
    await t.close();
  }
});

test('free plan limits ingredients and dishes', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const rows = Array.from({ length: 30 }, (_, i) => `Item ${i},kg,1,${10 + i}`);
    await c.post('/import', { csv: ['name,unit,pack_qty,pack_price', ...rows].join('\n') });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM ingredients').n, 25);
    await c.post('/ingredients', { name: 'Extra', pack_qty: '1', unit: 'kg', pack_price: '5' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM ingredients').n, 25);
    const first = String(t.app.db.get('SELECT id FROM ingredients').id);
    for (let i = 0; i < 10; i++) await c.post('/dishes', { name: `Dish ${i}`, portions: '1', sell_price: '100', ing: [first], qty: ['1'], unit: ['kg'] });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM dishes').n, 8);
  } finally {
    await t.close();
  }
});

test('tenant isolation, escaping, and account deletion with recipes', async () => {
  const t = await boot();
  try {
    const a = await ready(t);
    await a.post('/ingredients', { name: '<img src=x onerror=alert(1)>', pack_qty: '1', unit: 'kg', pack_price: '10', supplier: '"><script>x</script>' });
    await a.post('/dishes', curry(t, { name: '<b>bold</b>', category: '<i>c</i>' }));
    for (const p of ['/dashboard', '/ingredients', '/dishes', '/dishes/1', '/ingredients/4']) {
      const page = (await a.get(p)).text;
      assert.ok(!page.includes('<img src=x') && !page.includes('<script>x') && !page.includes('<b>bold</b>'), p);
    }
    const b = t.client();
    await b.signup('b@example.com');
    for (const p of ['/dishes/1', '/ingredients/1']) assert.equal((await b.get(p)).status, 404, p);
    for (const p of ['/dishes/1/edit', '/dishes/1/delete', '/dishes/1/duplicate', '/ingredients/1/edit', '/ingredients/1/delete']) assert.equal((await b.post(p, { name: 'x' })).status, 404, p);
    assert.ok(!(await b.get('/ingredients.csv')).text.includes('Paneer'));
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM dishes').n, 1);
    // a dish can't use another account's ingredient
    const foreign = await b.post('/dishes', { name: 'Steal', portions: '1', sell_price: '1', ing: ['1'], qty: ['1'], unit: ['g'] });
    assert.equal(foreign.status, 400, "another account's ingredient id is rejected");
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM dishes WHERE name = ?', 'Steal').n, 0);
    await a.post('/account/delete', { current: 'correct horse battery' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM dish_items').n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM ingredients WHERE user_id = 1').n, 0);
  } finally {
    await t.close();
  }
});
