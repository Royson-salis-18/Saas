// Recipe costing maths. Money is integer minor units (paise / cents); quantities are plain numbers.

import { parseAmount, parseCsvObjects, toMinor } from '@saas/core';

export const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'];
const FAMILY = { g: ['mass', 1], kg: ['mass', 1000], ml: ['vol', 1], l: ['vol', 1000], pcs: ['count', 1] };

/** Convert within a unit family (g<->kg, ml<->l). Returns null for incompatible units. */
export function convert(qty, from, to) {
  const a = FAMILY[from];
  const b = FAMILY[to];
  if (!a || !b || a[0] !== b[0]) return null;
  return (qty * a[1]) / b[1];
}

/** Cost of one usable ingredient unit (minor units, fractional). Yield < 100% raises the cost (trim, peel, cooking loss). */
export function costPerUnit(ing) {
  const yieldFactor = Math.min(1, Math.max(0.01, (ing.yield_pct ?? 100) / 100));
  return ing.pack_price / ing.pack_qty / yieldFactor;
}

/**
 * dish: { portions }, items: [{ ingredient_id, qty, unit }], ingredients: Map(id -> ingredient).
 * Returns { total, perPortion, lines: [{ name, qty, unit, cost, error }], problems }.
 */
export function dishCost(dish, items, ingredients) {
  const lines = [];
  const problems = [];
  let total = 0;
  for (const it of items) {
    const ing = ingredients.get(it.ingredient_id);
    if (!ing) { problems.push('An ingredient in this recipe was deleted'); continue; }
    const q = convert(it.qty, it.unit, ing.unit);
    if (q === null) { problems.push(`${ing.name}: cannot convert ${it.unit} to ${ing.unit}`); lines.push({ name: ing.name, qty: it.qty, unit: it.unit, cost: 0, error: true }); continue; }
    const cost = q * costPerUnit(ing);
    total += cost;
    lines.push({ name: ing.name, qty: it.qty, unit: it.unit, cost: Math.round(cost), ingredientId: ing.id });
  }
  const portions = Math.max(1, dish.portions || 1);
  return { total: Math.round(total), perPortion: Math.round(total / portions), lines, problems };
}

/** Price before tax when menu prices are tax-inclusive. */
export const exTax = (price, taxPct) => (taxPct > 0 ? Math.round(price / (1 + taxPct / 100)) : price);

export function margin(sellExTax, costPerPortion) {
  if (!sellExTax || sellExTax <= 0) return { foodCostPct: null, margin: null, marginPct: null };
  return {
    foodCostPct: Math.round((costPerPortion / sellExTax) * 1000) / 10,
    margin: sellExTax - costPerPortion,
    marginPct: Math.round(((sellExTax - costPerPortion) / sellExTax) * 1000) / 10,
  };
}

/** Price (ex tax) that achieves the target food-cost %, plus a version rounded up to a whole currency unit. */
export function suggestPrice(costPerPortion, targetPct) {
  if (!costPerPortion || targetPct <= 0) return { exact: 0, rounded: 0 };
  const exact = Math.ceil(costPerPortion / (targetPct / 100));
  return { exact, rounded: Math.ceil(exact / 100) * 100 };
}

export function status(foodCostPct, targetPct) {
  if (foodCostPct === null) return 'no_price';
  if (foodCostPct > targetPct + 5) return 'over';
  if (foodCostPct > targetPct) return 'watch';
  return 'ok';
}

/** What changes if ingredient `id` moves to `newPackPrice`? Compares every dish that uses it. */
export function priceImpact({ id, newPackPrice, next: nextIngredient, dishes, itemsByDish, ingredients, taxPct, targetPct }) {
  const next = new Map(ingredients);
  const old = ingredients.get(id);
  next.set(id, nextIngredient ?? { ...old, pack_price: newPackPrice });
  const affected = [];
  for (const d of dishes) {
    const items = itemsByDish.get(d.id) ?? [];
    if (!items.some((i) => i.ingredient_id === id)) continue;
    const before = dishCost(d, items, ingredients).perPortion;
    const after = dishCost(d, items, next).perPortion;
    const sell = exTax(d.sell_price, taxPct);
    const b = margin(sell, before);
    const a = margin(sell, after);
    affected.push({ id: d.id, name: d.name, before, after, pctBefore: b.foodCostPct, pctAfter: a.foodCostPct, newlyOver: a.foodCostPct !== null && a.foodCostPct > targetPct && !(b.foodCostPct > targetPct) });
  }
  return { affected, newlyOver: affected.filter((x) => x.newlyOver).length };
}

export const ING_ALIASES = {
  name: ['ingredient', 'item', 'item_name', 'product', 'material'],
  unit: ['uom', 'unit_of_measure', 'pack_unit'],
  pack_qty: ['quantity', 'qty', 'pack_size', 'pack_quantity', 'purchase_qty'],
  pack_price: ['price', 'cost', 'rate', 'purchase_price', 'pack_cost'],
  yield: ['yield_pct', 'yield_percent', 'usable'],
  supplier: ['vendor', 'supplier_name'],
};

const UNIT_ALIASES = { gm: 'g', gms: 'g', gram: 'g', grams: 'g', kgs: 'kg', kilo: 'kg', kilogram: 'kg', kilograms: 'kg', litre: 'l', liter: 'l', litres: 'l', liters: 'l', ltr: 'l', mls: 'ml', piece: 'pcs', pieces: 'pcs', pc: 'pcs', nos: 'pcs', each: 'pcs', unit: 'pcs', units: 'pcs' };
export const normUnit = (u) => {
  const s = String(u ?? '').trim().toLowerCase();
  return UNITS.includes(s) ? s : UNIT_ALIASES[s] ?? null;
};

export function parseIngredientCsv(text) {
  const { rows: raw, missing } = parseCsvObjects(text, { aliases: ING_ALIASES, required: ['name', 'pack_price'], maxRows: 5000 });
  if (missing.length) return { rows: [], errors: [], missing };
  const rows = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const line = i + 2;
    const name = (r.name ?? '').slice(0, 120);
    const price = parseAmount(r.pack_price);
    const qty = r.pack_qty === undefined || r.pack_qty === '' ? 1 : parseAmount(r.pack_qty);
    const unit = r.unit ? normUnit(r.unit) : 'kg';
    const y = r.yield ? parseAmount(r.yield) : 100;
    if (!name) return errors.push({ line, message: 'Missing ingredient name' });
    if (seen.has(name.toLowerCase())) return errors.push({ line, message: `${name}: duplicate name in this file (first kept)` });
    seen.add(name.toLowerCase());
    if (!Number.isFinite(price) || price < 0) return errors.push({ line, message: `${name}: price "${r.pack_price}" is not a number` });
    if (!Number.isFinite(qty) || qty <= 0) return errors.push({ line, message: `${name}: pack quantity "${r.pack_qty}" must be above zero` });
    if (!unit) return errors.push({ line, message: `${name}: unit "${r.unit}" not recognised (use g, kg, ml, l or pcs)` });
    rows.push({ name, unit, pack_qty: qty, pack_price: toMinor(price), yield_pct: Number.isFinite(y) && y > 0 && y <= 100 ? y : 100, supplier: (r.supplier ?? '').slice(0, 100) });
  });
  return { rows, errors, missing: [] };
}
