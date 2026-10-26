import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, costPerUnit, dishCost, exTax, margin, normUnit, parseIngredientCsv, priceImpact, status, suggestPrice } from '../src/logic.js';

const paneer = { id: 1, name: 'Paneer', unit: 'kg', pack_qty: 1, pack_price: 36000, yield_pct: 100 };
const tomato = { id: 2, name: 'Tomato', unit: 'kg', pack_qty: 1, pack_price: 4000, yield_pct: 90 };
const oil = { id: 3, name: 'Oil', unit: 'l', pack_qty: 5, pack_price: 75000, yield_pct: 100 };
const ings = new Map([paneer, tomato, oil].map((i) => [i.id, i]));

test('unit conversion stays within families', () => {
  assert.equal(convert(150, 'g', 'kg'), 0.15);
  assert.equal(convert(2, 'kg', 'g'), 2000);
  assert.equal(convert(250, 'ml', 'l'), 0.25);
  assert.equal(convert(3, 'pcs', 'pcs'), 3);
  assert.equal(convert(1, 'g', 'ml'), null);
  assert.equal(convert(1, 'kg', 'pcs'), null);
  assert.equal(convert(1, 'cup', 'g'), null);
});

test('cost per usable unit accounts for pack size and trim loss', () => {
  assert.equal(costPerUnit(paneer), 36000);
  assert.ok(Math.abs(costPerUnit(tomato) - 4444.444) < 0.01, '90% yield makes usable tomato dearer');
  assert.equal(costPerUnit(oil), 15000, '5 litre pack');
  assert.equal(costPerUnit({ ...paneer, yield_pct: 0 }) > 0, true, 'zero yield cannot divide by zero');
});

test('dish cost: mixed units, yield, portions', () => {
  const items = [{ ingredient_id: 1, qty: 150, unit: 'g' }, { ingredient_id: 2, qty: 200, unit: 'g' }, { ingredient_id: 3, qty: 30, unit: 'ml' }];
  const c = dishCost({ portions: 2 }, items, ings);
  assert.deepEqual(c.lines.map((l) => l.cost), [5400, 889, 450]);
  assert.equal(c.total, 6739);
  assert.equal(c.perPortion, 3369, 'rounded once at the end from the unrounded total: 6738.89 / 2');
  assert.deepEqual(c.problems, []);
});

test('bad recipe lines are reported, not silently costed', () => {
  const c = dishCost({ portions: 1 }, [{ ingredient_id: 1, qty: 2, unit: 'pcs' }, { ingredient_id: 99, qty: 1, unit: 'g' }], ings);
  assert.equal(c.total, 0);
  assert.equal(c.problems.length, 2);
  assert.match(c.problems[0], /cannot convert pcs to kg/);
  assert.equal(dishCost({ portions: 0 }, [], ings).perPortion, 0, 'zero portions treated as one');
});

test('margin, tax and suggested price', () => {
  assert.deepEqual(margin(18000, 3150), { foodCostPct: 17.5, margin: 14850, marginPct: 82.5 });
  assert.deepEqual(margin(0, 100), { foodCostPct: null, margin: null, marginPct: null });
  assert.equal(exTax(10500, 5), 10000);
  assert.equal(exTax(10500, 0), 10500);
  assert.deepEqual(suggestPrice(3150, 30), { exact: 10500, rounded: 10500 });
  assert.deepEqual(suggestPrice(3144, 30), { exact: 10480, rounded: 10500 });
  assert.deepEqual(suggestPrice(0, 30), { exact: 0, rounded: 0 });
  assert.equal(status(null, 30), 'no_price');
  assert.equal(status(28, 30), 'ok');
  assert.equal(status(30, 30), 'ok');
  assert.equal(status(33, 30), 'watch');
  assert.equal(status(40, 30), 'over');
});

test('price impact shows which dishes tip over target', () => {
  const dishes = [{ id: 10, name: 'Paneer wrap', portions: 1, sell_price: 20000 }, { id: 11, name: 'Tomato soup', portions: 1, sell_price: 9000 }, { id: 12, name: 'Water', portions: 1, sell_price: 1000 }];
  const itemsByDish = new Map([[10, [{ ingredient_id: 1, qty: 150, unit: 'g' }]], [11, [{ ingredient_id: 2, qty: 200, unit: 'g' }]], [12, []]]);
  const r = priceImpact({ id: 1, newPackPrice: 56000, dishes, itemsByDish, ingredients: ings, taxPct: 0, targetPct: 30 });
  assert.equal(r.affected.length, 1, 'only dishes that use the ingredient');
  assert.deepEqual([r.affected[0].before, r.affected[0].after], [5400, 8400]);
  assert.deepEqual([r.affected[0].pctBefore, r.affected[0].pctAfter], [27, 42]);
  assert.equal(r.newlyOver, 1);
  assert.equal(priceImpact({ id: 1, newPackPrice: 36000, dishes, itemsByDish, ingredients: ings, taxPct: 0, targetPct: 30 }).newlyOver, 0);
});

test('units are normalised', () => {
  for (const [raw, want] of [['KG', 'kg'], ['Grams', 'g'], ['ltr', 'l'], ['Nos', 'pcs'], ['ml', 'ml'], ['bunch', null], ['', null]]) assert.equal(normUnit(raw), want, raw);
});

test('ingredient csv: aliases, units, yield, errors', () => {
  const csv = ['Item,UOM,Pack Size,Price,Yield,Vendor', 'Paneer,kg,1,"₹360",100,Dairy Co', 'Tomato,KG,1,40,90,Veg Mart', 'Eggs,nos,30,"180",,Farm', 'Mystery,bunch,1,10,,', 'Flour,kg,0,50,,', 'Salt,kg,1,abc,,', 'paneer,kg,1,1,,'].join('\n');
  const r = parseIngredientCsv(csv);
  assert.deepEqual(r.rows.map((x) => [x.name, x.unit, x.pack_qty, x.pack_price, x.yield_pct]), [['Paneer', 'kg', 1, 36000, 100], ['Tomato', 'kg', 1, 4000, 90], ['Eggs', 'pcs', 30, 18000, 100]]);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors.map((e) => e.message).join('|'), /not recognised[\s\S]*above zero[\s\S]*not a number[\s\S]*duplicate/);
  assert.deepEqual(parseIngredientCsv('name,qty\nA,1').missing, ['pack_price']);
});
