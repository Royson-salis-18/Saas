// Outbound HTTP(S) checks against customer-supplied URLs.
//
// SSRF defence: every connection resolves the hostname through `safeLookup`, which
// rejects private / loopback / link-local / reserved addresses at connect time
// (so DNS rebinding can't swap the answer after validation). IP-literal hosts,
// which skip DNS, are checked up front, and every redirect hop goes through the
// same path. Set allowPrivate (ALLOW_PRIVATE_TARGETS=1) only for local development.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['2001::', 32], ['2002::', 16], ['64:ff9b::', 96],
]) blocked.addSubnet(addr, prefix, 'ipv6');
// NOTE: do not add ::ffff:0:0/96 here. BlockList treats every IPv4 address as an
// IPv4-mapped IPv6 address when matching IPv6 rules, so that entry would block the
// whole IPv4 internet. Mapped literals (::ffff:127.0.0.1) are already caught by the
// IPv4 rules above.

export function isPrivateIp(ip) {
  const addr = String(ip).replace(/%.*$/, '');
  if (net.isIPv4(addr)) return blocked.check(addr, 'ipv4');
  if (net.isIPv6(addr)) return blocked.check(addr, 'ipv6');
  return true; // not an IP we understand: refuse
}

export class BlockedTargetError extends Error {
  constructor() {
    super('Target resolves to a private or reserved address');
    this.code = 'EBLOCKED';
  }
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const allowed = addrs.filter((a) => !isPrivateIp(a.address));
    if (!allowed.length) return cb(new BlockedTargetError());
    if (options.all) return cb(null, allowed);
    return cb(null, allowed[0].address, allowed[0].family);
  });
}

/** Validate a user-entered monitor URL. Returns { url } or { error }. */
export function parseTargetUrl(input, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return { error: 'Enter a full URL such as https://example.com/health' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: 'Only http:// and https:// URLs can be monitored.' };
  if (url.username || url.password) return { error: 'Remove the username/password from the URL (use a header-free health endpoint).' };
  if (url.href.length > 500) return { error: 'That URL is too long.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (net.isIP(host) && isPrivateIp(host)))) {
    return { error: 'Private and local addresses cannot be monitored.' };
  }
  return { url };
}

const DEFAULT_UA = 'PingPulse/1.0 (uptime monitor)';

/** One HTTP(S) request, no redirects. Resolves { statusCode, headers, body, sslExpiresOn, ms }. */
function requestOnce(url, { method = 'GET', headers = {}, body = null, timeoutMs, allowPrivate = false, readBody = 0, tls = {} }) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(new BlockedTargetError());
    const secure = url.protocol === 'https:';
    const started = performance.now();
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = (secure ? https : http).request(
      {
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        lookup: allowPrivate ? undefined : safeLookup,
        headers: { 'user-agent': DEFAULT_UA, accept: '*/*', connection: 'close', ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
        ...tls,
      },
      (res) => {
        const ms = Math.round(performance.now() - started);
        let sslExpiresOn = null;
        if (secure) {
          const cert = res.socket?.getPeerCertificate?.();
          const t = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
          if (Number.isFinite(t)) sslExpiresOn = new Date(t).toISOString().slice(0, 10);
        }
        const result = { statusCode: res.statusCode, headers: res.headers, body: '', sslExpiresOn, ms };
        if (!readBody || method === 'HEAD') {
          res.resume();
          return finish(resolve, result);
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= readBody) chunks.push(c);
          else res.destroy();
        });
        res.on('close', () => finish(resolve, { ...result, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => finish(reject, e));
      },
    );
    const timer = setTimeout(() => {
      const e = new Error('timeout');
      e.code = 'ETIMEDOUT';
      req.destroy(e);
      finish(reject, e);
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e));
    if (body) req.write(body);
    req.end();
  });
}

export function describeError(err, timeoutMs) {
  const code = err?.code;
  if (code === 'EBLOCKED') return 'Blocked: target resolves to a private address';
  if (code === 'ETIMEDOUT' || err?.message === 'timeout') return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET') return 'Connection reset by server';
  if (code === 'CERT_HAS_EXPIRED') return 'TLS certificate has expired';
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return 'TLS certificate is not trusted';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'TLS certificate does not match the hostname';
  return String(err?.message ?? err).slice(0, 160);
}

/** "200-399, 404" -> predicate */
export function statusMatcher(spec = '200-399') {
  const ranges = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d{3})(?:\s*-\s*(\d{3}))?$/);
      return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
    })
    .filter(Boolean);
  if (!ranges.length) ranges.push([200, 399]);
  return (code) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

export const validStatusSpec = (spec) => /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/.test(String(spec));

/**
 * Run one uptime check. Never throws: returns
 * { ok, statusCode, latencyMs, error, sslExpiresOn, finalUrl }.
 */
export async function httpCheck({ url, method = 'GET', timeoutMs = 10000, keyword = '', expected = '200-399', allowPrivate = false, followRedirects = true, maxRedirects = 5, tls = {}, headers = {} }) {
  const deadline = performance.now() + timeoutMs;
  const match = statusMatcher(expected);
  let current;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, statusCode: null, latencyMs: null, error: 'Invalid URL', sslExpiresOn: null, finalUrl: url };
  }
  const t0 = performance.now();
  let sslExpiresOn = null;
  try {
    for (let hop = 0; ; hop++) {
      const remaining = Math.max(250, deadline - performance.now());
      const res = await requestOnce(current, {
        method: keyword ? 'GET' : method,
        headers,
        timeoutMs: remaining,
        allowPrivate,
        readBody: keyword ? 512 * 1024 : 0,
        tls,
      });
      sslExpiresOn = res.sslExpiresOn ?? sslExpiresOn;
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location;
      if (isRedirect && followRedirects) {
        if (hop >= maxRedirects) {
          return { ok: false, statusCode: res.statusCode, latencyMs: Math.round(performance.now() - t0), error: 'Too many redirects', sslExpiresOn, finalUrl: current.href };
        }
        const next = new URL(res.headers.location, current);
        if (!['http:', 'https:'].includes(next.protocol)) {
          return { ok: false, statusCode: res.statusCode, latencyMs: Math.round(performance.now() - t0), error: 'Redirected to an unsupported protocol', sslExpiresOn, finalUrl: current.href };
        }
        current = next; // re-validated by requestOnce on the next hop
        continue;
      }
      const latencyMs = Math.round(performance.now() - t0);
      if (!match(res.statusCode)) {
        return { ok: false, statusCode: res.statusCode, latencyMs, error: `Unexpected status ${res.statusCode}`, sslExpiresOn, finalUrl: current.href };
      }
      if (keyword && !res.body.includes(keyword)) {
        return { ok: false, statusCode: res.statusCode, latencyMs, error: `Keyword "${keyword.slice(0, 40)}" not found in response`, sslExpiresOn, finalUrl: current.href };
      }
      return { ok: true, statusCode: res.statusCode, latencyMs, error: null, sslExpiresOn, finalUrl: current.href };
    }
  } catch (err) {
    return { ok: false, statusCode: null, latencyMs: null, error: describeError(err, timeoutMs), sslExpiresOn, finalUrl: current.href };
  }
}

/** POST JSON to a user-supplied webhook with the same SSRF protections. */
export async function postJson(url, payload, { timeoutMs = 5000, allowPrivate = false } = {}) {
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return { ok: false, error: 'Unsupported protocol' };
    const res = await requestOnce(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs,
      allowPrivate,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode };
  } catch (err) {
    return { ok: false, error: describeError(err, timeoutMs) };
  }
}
