// Calendar-date helpers working on ISO "YYYY-MM-DD" strings (no time zones
// involved once you have the string). `todayIn` is the only tz-aware function.

const DAY = 86400000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function todayIn(tz = 'UTC', nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(nowMs);
}

const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** Whole days from a to b (positive when b is later). */
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);

export const addDays = (iso, n) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);

export function formatDate(iso) {
  if (!isISODate(iso)) return iso ?? '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1][0].toUpperCase()}${MONTHS[Number(m) - 1].slice(1)} ${y}`;
}

const pad = (n) => String(n).padStart(2, '0');

function build(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isISODate(iso) ? iso : null;
}

/**
 * Parse common spreadsheet date spellings into ISO. Understands
 * YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, MM/DD/YYYY, DD-Mon-YYYY, "5 Oct 2026".
 * For ambiguous numeric dates (both parts <= 12) `dayFirst` decides.
 */
export function parseDateLoose(input, { dayFirst = false } = {}) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (m) return build(m[1], Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-/.\s]([A-Za-z]{3,9})[-/.,\s]+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi >= 0 ? build(m[3], mi + 1, Number(m[1])) : null;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (a > 12) return build(year, b, a);
    if (b > 12) return build(year, a, b);
    return dayFirst ? build(year, b, a) : build(year, a, b);
  }
  return null;
}
