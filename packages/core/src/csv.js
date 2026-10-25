// Small RFC 4180 CSV reader/writer. Handles BOM, CRLF, quoted fields,
// embedded newlines and comma / semicolon / tab delimiters.

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input, { maxRows = 50000 } = {}) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`CSV has more than ${maxRows} rows`);
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export const normalizeHeader = (h) =>
  String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Parse a CSV into objects. `aliases` maps a canonical column name to the
 * alternative header names that should be accepted for it.
 * Returns { rows, columns, missing } where `missing` lists canonical columns not found.
 */
export function parseCsvObjects(input, { aliases = {}, required = [], maxRows } = {}) {
  const table = parseCsv(input, { maxRows });
  if (table.length === 0) return { rows: [], columns: [], missing: [...required] };
  const lookup = new Map();
  for (const [canon, alts] of Object.entries(aliases)) {
    lookup.set(canon, canon);
    for (const a of alts) lookup.set(normalizeHeader(a), canon);
  }
  const headers = table[0].map((h) => {
    const n = normalizeHeader(h);
    return lookup.get(n) ?? n;
  });
  const rows = table.slice(1).map((cells) => {
    const o = {};
    headers.forEach((h, i) => {
      if (h && !(h in o)) o[h] = (cells[i] ?? '').trim();
    });
    return o;
  });
  const missing = required.filter((r) => !headers.includes(r));
  return { rows, columns: headers, missing };
}

// Cells starting with these characters are interpreted as formulas by spreadsheets.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label ?? c.key)).join(',');
  const lines = rows.map((r) =>
    columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}
