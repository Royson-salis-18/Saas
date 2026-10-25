import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceptionsCsv, guessColumns, parseAmount, parseCsv, reconcile } from '../public/reconcile.js';

const rows = (csv) => parseCsv(csv).slice(1);

test('amount parsing across formats', () => {
  assert.equal(parseAmount('₹1,23,456.78'), 123456.78);
  assert.equal(parseAmount('$1,200'), 1200);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('(500)'), -500);
  assert.equal(parseAmount('-45.5'), -45.5);
  assert.equal(parseAmount('Rs. 900'), 900);
  assert.ok(Number.isNaN(parseAmount('n/a')));
});

test('csv: quotes, delimiters, BOM', () => {
  assert.deepEqual(parseCsv('﻿a;b\n"x;y";2'), [['a', 'b'], ['x;y', '2']]);
});

test('classifies matched, short/over paid, missing and extra references', () => {
  const orders = rows('order,amount\nO1,100\nO2,200\nO3,300\nO4,400');
  const payouts = rows('ref,paid\nO1,100\nO2,150\nO3,320\nO9,55');
  const r = reconcile(orders, payouts);
  assert.deepEqual(r.matched.map((x) => x.ref), ['O1']);
  assert.deepEqual(r.mismatched.map((x) => [x.ref, x.diff]), [['O3', 2000], ['O2', -5000]].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])));
  assert.deepEqual(r.missing.map((x) => [x.ref, x.expected]), [['O4', 40000]]);
  assert.deepEqual(r.extra.map((x) => [x.ref, x.received]), [['O9', 5500]]);
  assert.equal(r.summary.underpaid, -5000);
  assert.equal(r.summary.overpaid, 2000);
  assert.equal(r.summary.expected, 100000);
  assert.equal(r.summary.received, 62500);
  assert.equal(r.summary.difference, r.summary.received - r.summary.expected);
});

test('lines are summed per reference so refunds net off; no float drift', () => {
  const r = reconcile(rows('id,amt\nA,0.1\nA,0.2'), rows('id,amt\nA,0.30'));
  assert.equal(r.matched.length, 1);
  const refund = reconcile(rows('id,amt\nB,100'), rows('id,amt\nB,100\nB,-100'));
  assert.equal(refund.mismatched[0].diff, -10000, 'a refund line reduces what was received');
});

test('tolerance: absolute and percentage', () => {
  const a = rows('id,amt\nX,1000'); const b = rows('id,amt\nX,985');
  assert.equal(reconcile(a, b).mismatched.length, 1);
  assert.equal(reconcile(a, b, { tolAbs: 15 }).matched.length, 1);
  assert.equal(reconcile(a, b, { tolPct: 2 }).matched.length, 1);
  assert.equal(reconcile(a, b, { tolPct: 1 }).mismatched.length, 1);
});

test('reference matching ignores case, spaces and punctuation when asked', () => {
  const r = reconcile(rows('id,amt\nOD-123 456,10'), rows('id,amt\nod123456,10'));
  assert.equal(r.matched.length, 1);
  assert.equal(reconcile(rows('id,amt\nOD-1,10'), rows('id,amt\nod1,10'), { stripKeys: false }).missing.length, 1);
});

test('bad rows are reported, not silently dropped', () => {
  const r = reconcile(rows('id,amt\nA,10\n,5\nC,abc'), rows('id,amt\nA,10'));
  assert.equal(r.skippedA.length, 2);
  assert.match(r.skippedA[1].reason, /not a number/);
  assert.equal(r.skippedA[0].line, 3);
});

test('column guessing and different column positions', () => {
  assert.deepEqual(guessColumns(['Date', 'Order ID', 'Net Payout']), { key: 1, amount: 2 });
  const r = reconcile(rows('x,id,amt\n1,A,10'), rows('id,note,paid\nA,hi,10'), { keyA: 1, amtA: 2, keyB: 0, amtB: 2 });
  assert.equal(r.matched.length, 1);
});

test('exception export neutralises spreadsheet formulas', () => {
  const r = reconcile(rows('id,amt\n=HYPERLINK("x"),5'), rows('id,amt\nZ,1'), { stripKeys: false });
  const csv = exceptionsCsv(r);
  assert.match(csv, /^type,reference,expected,received,difference/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /not_in_expected,Z,0,1,1/);
});

test('large files stay fast', () => {
  const n = 100000; const a = Array.from({ length: n }, (_, i) => [`O${i}`, '10']); const b = a.map((r, i) => (i % 100 ? r : [r[0], '9']));
  const t = Date.now(); const r = reconcile(a, b);
  assert.equal(r.mismatched.length, 1000);
  assert.ok(Date.now() - t < 2000);
});
