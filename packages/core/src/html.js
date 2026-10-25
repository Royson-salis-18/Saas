// Tagged-template HTML with escaping by default. Interpolated values are
// escaped unless they are the result of another html`` call (or raw()).

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as already-safe HTML. Never pass user input here. */
export const raw = (value) => new Raw(String(value ?? ''));

function renderValue(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escape(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Allow only http(s)/mailto/relative URLs in user-supplied hrefs. */
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return '';
}
