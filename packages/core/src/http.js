import { Raw } from './html.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 303 redirect. Optional one-shot flash message: { ok: '...' } or { err: '...' }. */
export const redirect = (location, flash = {}) => ({
  status: 303,
  headers: { location },
  flash: flash.ok ? { type: 'ok', msg: flash.ok } : flash.err ? { type: 'err', msg: flash.err } : null,
  body: '',
});

export const json = (data, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(data),
});

export const text = (body, status = 200) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: String(body),
});

export function download(filename, body, type = 'text/csv; charset=utf-8') {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]+/g, '_');
  return {
    status: 200,
    headers: {
      'content-type': type,
      'content-disposition': `attachment; filename="${safe}"`,
      'cache-control': 'no-store',
    },
    body,
  };
}

/** Turn whatever a handler returned into { status, headers, body }. */
export function normalizeResponse(result) {
  if (result === undefined || result === null) return { status: 204, headers: {}, body: '' };
  if (result instanceof Raw) {
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: result.value };
  }
  if (typeof result === 'string') return text(result);
  const r = { status: 200, headers: {}, ...result };
  r.headers = { ...r.headers };
  if (r.body instanceof Raw) {
    r.body = r.body.value;
    r.headers['content-type'] ??= 'text/html; charset=utf-8';
  }
  return r;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Payload too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Parse urlencoded / JSON bodies. Repeated keys and `name[]` keys become arrays. */
export function parseBody(raw, contentType = '') {
  const body = Object.create(null);
  if (!raw.length) return body;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) body[k] = v;
    }
    return body;
  }
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw.toString('utf8'));
    for (const [key, value] of params) {
      const isArray = key.endsWith('[]');
      const k = isArray ? key.slice(0, -2) : key;
      if (k === '__proto__') continue;
      if (isArray || k in body) {
        body[k] = [].concat(body[k] ?? [], value);
      } else {
        body[k] = value;
      }
    }
    return body;
  }
  return body;
}

export const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
