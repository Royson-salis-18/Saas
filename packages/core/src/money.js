// Money helpers. Amounts are stored as integer minor units (paise / cents)
// to avoid floating point drift; formatMoney expects minor units.

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'AUD', 'CAD', 'SGD'];

export const toMinor = (major) => Math.round(Number(major) * 100);
export const fromMinor = (minor) => Number(minor) / 100;

export function formatMoney(minor, currency = 'USD') {
  const cur = CURRENCIES.includes(currency) ? currency : 'USD';
  const locale = cur === 'INR' ? 'en-IN' : 'en-US';
  const major = fromMinor(minor);
  const whole = Number.isInteger(major);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: cur,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

/** Format a plain (major-unit) number, e.g. prices on pricing cards. */
export const formatMajor = (major, currency) => formatMoney(toMinor(major), currency);

/**
 * Parse "₹1,23,456.78", "$1,200", "1.234,56", "(500)", "Rs. 900" into a number
 * (major units). Returns NaN when nothing numeric is found.
 */
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  let s = String(input ?? '').trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/^-/.test(s) || /-$/.test(s)) negative = true;
  // First numeric token only, so "Rs. 900" / "USD 1,200." / "₹5" don't leak punctuation.
  const token = s.match(/[.,]?\d[\d.,]*/);
  if (!token) return NaN;
  s = token[0].replace(/[.,]+$/, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the later separator is the decimal mark
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "12,5" / "12,50" => decimal comma; "1,500" / "1,23,456" => thousands
    s = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}
