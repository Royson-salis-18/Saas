import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escape, safeUrl } from '../src/html.js';
import { parseCsv, parseCsvObjects, toCsv } from '../src/csv.js';
import { parseAmount, formatMoney, toMinor } from '../src/money.js';
import { addDays, daysBetween, isISODate, parseDateLoose, todayIn, formatDate } from '../src/dates.js';
import { hashPassword, verifyPassword, createRateLimiter, safeNext, isEmail } from '../src/security.js';
import { Router } from '../src/router.js';
import { parseBody } from '../src/http.js';

test('html escapes interpolations but not nested html', () => {
  const evil = '<script>alert(1)</script>';
  assert.equal(html`<p>${evil}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(html`<ul>${[1, 2].map((n) => html`<li>${n}</li>`)}</ul>`.value, '<ul><li>1</li><li>2</li></ul>');
  assert.equal(html`<b>${raw('<i>x</i>')}</b>`.value, '<b><i>x</i></b>');
  assert.equal(html`${null}${undefined}${false}`.value, '');
  assert.equal(escape(`"'&`), '&quot;&#39;&amp;');
});

test('safeUrl blocks javascript: and protocol-relative URLs', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('//evil.com'), '');
  assert.equal(safeUrl('https://ok.com/x'), 'https://ok.com/x');
  assert.equal(safeUrl('/local'), '/local');
});

test('csv parses quotes, newlines, BOM and delimiters', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n"he said ""hi""",3\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2'], ['he said "hi"', '3']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('csv objects apply header aliases and report missing columns', () => {
  const r = parseCsvObjects('Client Name,Total Due\nAcme,100', {
    aliases: { client: ['client name'], amount: ['total due'] },
    required: ['client', 'amount', 'email'],
  });
  assert.deepEqual(r.rows, [{ client: 'Acme', amount: '100' }]);
  assert.deepEqual(r.missing, ['email']);
});

test('csv export neutralises formula injection', () => {
  const out = toCsv([{ a: '=HYPERLINK("x")', b: 5, c: 'a,b' }], [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.match(out, /'=HYPERLINK/);
  assert.match(out, /,5,/);
  assert.match(out, /"a,b"/);
});

test('parseAmount handles Indian, US and European formats', () => {
  assert.equal(parseAmount('₹1,23,456.78'), 123456.78);
  assert.equal(parseAmount('$1,200'), 1200);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('1,500'), 1500);
  assert.equal(parseAmount('(500)'), -500);
  assert.equal(parseAmount('Rs. 900'), 900);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('')));
});

test('formatMoney uses lakh grouping for INR', () => {
  assert.equal(formatMoney(toMinor(123456), 'INR'), '₹1,23,456');
  assert.equal(formatMoney(toMinor(1234.5), 'USD'), '$1,234.50');
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(0.1 + 0.2), 30);
});

test('date helpers', () => {
  assert.ok(isISODate('2026-02-28'));
  assert.ok(!isISODate('2026-02-30'));
  assert.equal(addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.equal(parseDateLoose('05/10/2026', { dayFirst: true }), '2026-10-05');
  assert.equal(parseDateLoose('05/10/2026', { dayFirst: false }), '2026-05-10');
  assert.equal(parseDateLoose('25/10/2026'), '2026-10-25');
  assert.equal(parseDateLoose('10/25/2026'), '2026-10-25');
  assert.equal(parseDateLoose('5-Oct-2026'), '2026-10-05');
  assert.equal(parseDateLoose('2026-10-05T10:00:00Z'), '2026-10-05');
  assert.equal(parseDateLoose('nonsense'), null);
  assert.equal(parseDateLoose('31/02/2026'), null);
  assert.equal(formatDate('2026-10-05'), '5 Oct 2026');
  // 2026-10-25T20:00Z is already the 26th in Kolkata but still the 25th in New York.
  const t = Date.UTC(2026, 9, 25, 20, 0, 0);
  assert.equal(todayIn('Asia/Kolkata', t), '2026-10-26');
  assert.equal(todayIn('America/New_York', t), '2026-10-25');
});

test('password hashing verifies and rejects', async () => {
  const h = await hashPassword('s3cret-passphrase');
  assert.ok(await verifyPassword('s3cret-passphrase', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});

test('rate limiter blocks after max and resets after window', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 3; i++) assert.ok(rl.hit('k', 3, 1000, 0).ok);
  assert.ok(!rl.hit('k', 3, 1000, 10).ok);
  assert.ok(rl.hit('k', 3, 1000, 1001).ok);
});

test('safeNext only allows same-site paths; isEmail validates', () => {
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('/\\evil'), '/');
  assert.equal(safeNext('/ok?x=1'), '/ok?x=1');
  assert.ok(isEmail('a@b.co'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('a b@c.com'));
});

test('router matches params and distinguishes 404 from 405', () => {
  const r = new Router();
  r.add('GET', '/leads/:id/edit', () => 1);
  const m = r.match('GET', '/leads/42/edit');
  assert.equal(m.params.id, '42');
  assert.equal(r.match('GET', '/leads/42'), null);
  assert.equal(r.match('POST', '/leads/42/edit'), null);
  assert.ok(r.hasPath('/leads/42/edit'));
  assert.equal(r.match('GET', '/leads/%E0%A4%A/edit'), null);
});

test('body parser: arrays, [] suffix and prototype safety', () => {
  const b = parseBody(Buffer.from('a=1&a=2&b[]=x&__proto__=bad&c=3'), 'application/x-www-form-urlencoded');
  assert.deepEqual(b.a, ['1', '2']);
  assert.deepEqual(b.b, ['x']);
  assert.equal(b.c, '3');
  assert.equal(Object.getPrototypeOf(b), null);
  assert.equal(b.__proto__, undefined);
});
