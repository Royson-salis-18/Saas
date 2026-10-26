// Pure reconciliation logic. Runs in the browser (and in Node for tests). No network, no storage.

export function parseCsv(input, { maxRows = 200000 } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`File has more than ${maxRows.toLocaleString('en-US')} rows`);
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** "₹1,23,456.78", "$1,200", "1.234,56", "(500)", "-45" -> number (major units) or NaN. */
export function parseAmount(input) {
  let s = String(input ?? '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-/.test(s) || /-$/.test(s)) neg = true;
  const t = s.match(/[.,]?\d[\d.,]*/);
  if (!t) return NaN;
  s = t[0].replace(/[.,]+$/, '');
  const d = s.lastIndexOf('.'); const c = s.lastIndexOf(',');
  if (d >= 0 && c >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

export const toMinor = (n) => Math.round(n * 100);

const KEY_HINT = /(order|invoice|ref|reference|txn|transaction|utr|id|number|no\b)/i;
const AMT_HINT = /(amount|total|value|payout|settle|net|price|credit|paid|received)/i;

/** Suggest key and amount columns from a header row. */
export function guessColumns(header) {
  const key = header.findIndex((h) => KEY_HINT.test(h));
  const amount = header.findIndex((h, i) => i !== key && AMT_HINT.test(h));
  return { key: key >= 0 ? key : 0, amount: amount >= 0 ? amount : Math.min(1, header.length - 1) };
}

const normKey = (k, strip) => {
  const t = String(k ?? '').trim().toLowerCase();
  return strip ? t.replace(/[^a-z0-9]/g, '') : t;
};

function aggregate(rows, keyCol, amtCol, strip) {
  const map = new Map(); const skipped = [];
  rows.forEach((r, i) => {
    const raw = String(r[keyCol] ?? '').trim();
    const key = normKey(raw, strip);
    const amt = parseAmount(r[amtCol]);
    if (!key) { skipped.push({ line: i + 2, reason: 'Empty reference' }); return; }
    if (!Number.isFinite(amt)) { skipped.push({ line: i + 2, reason: `Amount "${r[amtCol] ?? ''}" is not a number`, ref: raw }); return; }
    const e = map.get(key) ?? { ref: raw, total: 0, count: 0 };
    e.total += toMinor(amt); e.count++;
    map.set(key, e);
  });
  return { map, skipped };
}

/**
 * Compare expected (A) against received (B), grouped by reference. Amounts are summed per reference
 * (so refunds/negative lines net off). Tolerance = max(absolute, percent of the expected amount).
 * All amounts in the result are integer minor units (paise / cents).
 */
export function reconcile(rowsA, rowsB, { keyA = 0, amtA = 1, keyB = 0, amtB = 1, tolAbs = 0, tolPct = 0, stripKeys = true } = {}) {
  const A = aggregate(rowsA, keyA, amtA, stripKeys);
  const B = aggregate(rowsB, keyB, amtB, stripKeys);
  const out = { matched: [], mismatched: [], missing: [], extra: [], skippedA: A.skipped, skippedB: B.skipped, summary: {} };
  let expected = 0; let received = 0;
  for (const [k, a] of A.map) {
    expected += a.total;
    const b = B.map.get(k);
    if (!b) { out.missing.push({ ref: a.ref, expected: a.total, received: 0, diff: -a.total, linesA: a.count, linesB: 0 }); continue; }
    const diff = b.total - a.total;
    const tol = Math.max(Math.round(tolAbs * 100), Math.round((Math.abs(a.total) * tolPct) / 100));
    const item = { ref: a.ref, expected: a.total, received: b.total, diff, linesA: a.count, linesB: b.count };
    (Math.abs(diff) <= tol ? out.matched : out.mismatched).push(item);
  }
  for (const [k, b] of B.map) {
    received += b.total;
    if (!A.map.has(k)) out.extra.push({ ref: b.ref, expected: 0, received: b.total, diff: b.total, linesA: 0, linesB: b.count });
  }
  const byAbs = (x, y) => Math.abs(y.diff) - Math.abs(x.diff);
  out.mismatched.sort(byAbs); out.missing.sort(byAbs); out.extra.sort(byAbs);
  const sum = (l, f) => l.reduce((n, x) => n + f(x), 0);
  out.summary = {
    expected, received, difference: received - expected,
    refsA: A.map.size, refsB: B.map.size,
    matched: out.matched.length, mismatched: out.mismatched.length, missing: out.missing.length, extra: out.extra.length,
    missingValue: sum(out.missing, (x) => x.expected),
    mismatchNet: sum(out.mismatched, (x) => x.diff),
    underpaid: sum(out.mismatched.filter((x) => x.diff < 0), (x) => x.diff),
    overpaid: sum(out.mismatched.filter((x) => x.diff > 0), (x) => x.diff),
    extraValue: sum(out.extra, (x) => x.received),
  };
  return out;
}

const FORMULA = /^[=+\-@\t\r]/;
const cell = (v) => { let s = String(v ?? ''); if (typeof v === 'string' && FORMULA.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Exceptions as CSV (formula-injection safe). Amounts in major units. */
export function exceptionsCsv(result) {
  const lines = [['type', 'reference', 'expected', 'received', 'difference'].join(',')];
  const add = (type, list) => list.forEach((x) => lines.push([type, x.ref, x.expected / 100, x.received / 100, x.diff / 100].map(cell).join(',')));
  add('missing_in_received', result.missing); add('amount_mismatch', result.mismatched); add('not_in_expected', result.extra);
  return lines.join('\r\n') + '\r\n';
}
