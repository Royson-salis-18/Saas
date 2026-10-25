import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb } from './db.js';
import { Router } from './router.js';
import { html } from './html.js';
import {
  HttpError,
  normalizeResponse,
  parseCookies,
  parseBody,
  readBody,
  redirect,
  serializeCookie,
} from './http.js';
import { createRateLimiter, randomToken, safeEqual, sha256 } from './security.js';
import { createMailer } from './mailer.js';
import { effectivePlan } from './billing.js';
import { todayIn } from './dates.js';
import { layout, pageHeader } from './ui.js';
import { registerCoreRoutes } from './core-routes.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const SESSION_MS = 30 * 86400000;
const DEFAULT_BODY_LIMIT = 1024 * 1024;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

/**
 * Build a SaaS application: HTTP server, SQLite, accounts, billing, mail, jobs.
 *
 * config: { slug, name, tagline, accent, plans, limitLabels, migrations, nav, home,
 *           marketing, settingsDefaults, usage(db, user), env?, dbPath?, now?, fetch? }
 */
export function createApp(userConfig) {
  const env = userConfig.env ?? process.env;
  const config = {
    home: '/dashboard',
    nav: [],
    migrations: [],
    settingsDefaults: {},
    limitLabels: {},
    marketing: {},
    accent: '#b8f23b',
    glyph: 'pulse',
    usage: () => ({}),
    ...userConfig,
    env,
  };
  config.baseUrl = (userConfig.baseUrl ?? env.BASE_URL ?? '').replace(/\/$/, '');
  config.dbPath = userConfig.dbPath ?? env.DB_PATH ?? path.join(env.DATA_DIR ?? 'data', `${config.slug}.db`);
  config.secureCookies = config.baseUrl.startsWith('https://');
  config.trustProxy = env.TRUST_PROXY === '1';

  const now = userConfig.now ?? (() => Date.now());
  const db = openDb(config.dbPath, config.migrations);
  const router = new Router();
  const statics = new Map();
  const jobs = new Map();
  const timers = [];
  const sidName = `${config.slug}_sid`;
  const flashName = `${config.slug}_flash`;

  const app = {
    config,
    db,
    now,
    port: null,
    fetch: userConfig.fetch ?? globalThis.fetch,
    limiter: createRateLimiter(),
    sidName,
  };
  app.mailer = createMailer({ db, env, fetchImpl: (...a) => app.fetch(...a), now, appName: config.name });

  // ---- routing -----------------------------------------------------------
  // Routes require a logged-in user unless { public: true }. POSTs are CSRF-checked
  // unless { csrf: false } (webhooks / token-addressed public endpoints).
  app.get = (pattern, handler, opts = {}) => router.add('GET', pattern, handler, opts);
  app.post = (pattern, handler, opts = {}) => router.add('POST', pattern, handler, opts);
  app.addStatic = (name, body, type = 'text/javascript; charset=utf-8') => statics.set(`/static/${name}`, { body, type });

  for (const file of ['app.css', 'app.js']) {
    app.addStatic(file, readFileSync(path.join(STATIC_DIR, file)), file.endsWith('css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
  }

  // ---- plans -------------------------------------------------------------
  app.planFor = (user) => effectivePlan(user, now());
  app.limitFor = (planKey, limitKey) => {
    const v = config.plans[planKey]?.limits?.[limitKey];
    return v === undefined ? Infinity : v;
  };
  app.publicUrl = (p = '/') => `${config.baseUrl || `http://localhost:${app.port}`}${p}`;

  // ---- sessions ----------------------------------------------------------
  app.createSession = (userId) => {
    const token = randomToken();
    const t = now();
    db.run(
      'INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(token),
      userId,
      randomToken(24),
      t,
      t + SESSION_MS,
    );
    return token;
  };
  app.destroySessions = (userId, exceptHash = null) =>
    db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, exceptHash ?? '');

  function loadSession(ctx) {
    const token = ctx.cookies[sidName];
    if (!token) return;
    const hash = sha256(token);
    const row = db.get(
      `SELECT s.csrf AS _csrf, s.expires_at AS _exp, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      hash,
    );
    if (!row) return;
    const t = now();
    if (row._exp <= t) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', hash);
      return;
    }
    if (row._exp - t < SESSION_MS / 2) {
      db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', t + SESSION_MS, hash);
      ctx.setCookie(sidName, token, { maxAge: SESSION_MS / 1000 });
    }
    const { _csrf, _exp, ...user } = row;
    ctx.user = user;
    ctx.sessionHash = hash;
    ctx.csrf = _csrf;
    ctx.plan = app.planFor(user);
    ctx.planInfo = config.plans[ctx.plan] ?? config.plans.free;
    let saved = {};
    try {
      saved = JSON.parse(user.settings || '{}');
    } catch {
      /* corrupted settings fall back to defaults */
    }
    ctx.settings = { ...config.settingsDefaults, ...saved };
  }

  // ---- request context ---------------------------------------------------
  function clientIp(req) {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function buildCtx(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.create(null);
    for (const [k, v] of url.searchParams) if (k !== '__proto__') query[k] = v;
    const cookies = parseCookies(req.headers.cookie);
    const out = [];
    const ctx = {
      app,
      db,
      req,
      method: req.method,
      url,
      path: url.pathname,
      query,
      cookies,
      params: {},
      body: Object.create(null),
      rawBody: Buffer.alloc(0),
      user: null,
      csrf: null,
      plan: 'free',
      planInfo: config.plans.free,
      settings: { ...config.settingsDefaults },
      ip: clientIp(req),
      outCookies: out,
      now,
      today: () => todayIn(ctx.user?.timezone ?? 'UTC', now()),
      baseUrl: config.baseUrl || `http://${req.headers.host ?? 'localhost'}`,
      flash: null,
      setCookie(name, value, opts = {}) {
        out.push(serializeCookie(name, value, { secure: config.secureCookies, ...opts }));
      },
      clearCookie(name) {
        out.push(serializeCookie(name, '', { maxAge: 0, secure: config.secureCookies }));
      },
      setSession(token) {
        ctx.setCookie(sidName, token, { maxAge: SESSION_MS / 1000 });
      },
      clearSession() {
        ctx.clearCookie(sidName);
      },
      guessCurrency() {
        const cookie = cookies[`${config.slug}_cur`];
        if (cookie === 'INR' || cookie === 'USD') return cookie;
        return /(^|,|\s)(hi|[a-z]{2}-IN)\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'INR' : 'USD';
      },
      redirect,
      page(title, body, opts = {}) {
        return layout(ctx, { title, body, ...opts });
      },
      saveSettings(patch) {
        ctx.settings = { ...ctx.settings, ...patch };
        db.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(ctx.settings), ctx.user.id);
      },
      limit: (key) => app.limitFor(ctx.plan, key),
      /** Returns an upgrade message when adding `adding` to `current` would exceed the plan limit. */
      checkLimit(key, current, adding = 1) {
        const lim = ctx.limit(key);
        if (current + adding <= lim) return null;
        const label = config.limitLabels[key] ?? key;
        return `Your ${ctx.planInfo.label} plan includes ${lim.toLocaleString('en-US')} ${label}. Upgrade on the Billing page to add more.`;
      },
    };
    const rawFlash = cookies[flashName];
    if (rawFlash) {
      try {
        const f = JSON.parse(Buffer.from(rawFlash, 'base64url').toString('utf8'));
        if (f && typeof f.msg === 'string') ctx.flash = { type: f.type === 'err' ? 'err' : 'ok', msg: f.msg.slice(0, 300) };
      } catch {
        /* ignore malformed flash */
      }
    }
    return ctx;
  }

  // ---- dispatch ----------------------------------------------------------
  function serveStatic(ctx) {
    const file = statics.get(ctx.path);
    if (!file) return null;
    return { status: 200, headers: { 'content-type': file.type, 'cache-control': 'public, max-age=300' }, body: file.body };
  }

  async function dispatch(ctx) {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const method = ctx.method === 'HEAD' ? 'GET' : ctx.method;
    if (method === 'GET') {
      const s = serveStatic(ctx);
      if (s) return s;
    }
    const match = router.match(method, ctx.path);
    if (!match) throw new HttpError(router.hasPath(ctx.path) ? 405 : 404, 'Page not found');
    ctx.params = match.params;
    const opts = match.opts;
    loadSession(ctx);

    if (!opts.public && !ctx.user) {
      if (method === 'GET') return redirect(`/login?next=${encodeURIComponent(ctx.path + ctx.url.search)}`);
      throw new HttpError(401, 'Please log in');
    }

    if (method === 'POST') {
      ctx.rawBody = await readBody(ctx.req, opts.maxBody ?? DEFAULT_BODY_LIMIT);
      ctx.body = parseBody(ctx.rawBody, ctx.req.headers['content-type']);
      if (opts.csrf !== false) {
        const sent = ctx.body._csrf ?? ctx.req.headers['x-csrf-token'];
        if (!ctx.csrf || !safeEqual(sent, ctx.csrf)) throw new HttpError(403, 'Security token missing or expired. Reload the page and try again.');
      }
    }
    return match.handler(ctx);
  }

  function errorPage(ctx, err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[${config.slug}] ${ctx.method} ${ctx.path}`, err);
    const message = status === 500 ? 'Something went wrong on our side. Please try again.' : err.message;
    if (ctx.req.headers.accept?.includes('application/json') && !ctx.req.headers.accept.includes('text/html')) {
      return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: message }) };
    }
    const body = html`${pageHeader(status === 404 ? 'Not found' : `Error ${status}`)}<div class="card"><p>${message}</p><p><a class="btn" href="/">Back to start</a></p></div>`;
    return layout(ctx, { title: `Error ${status}`, body, status });
  }

  async function handle(req, res) {
    const ctx = buildCtx(req, res);
    let result;
    try {
      result = await dispatch(ctx);
    } catch (err) {
      if (!ctx.user && ctx.cookies[sidName]) loadSession(ctx);
      result = errorPage(ctx, err);
    }
    const r = normalizeResponse(result);
    const isRedirect = r.status >= 300 && r.status < 400;
    if (r.flash) ctx.setCookie(flashName, Buffer.from(JSON.stringify(r.flash)).toString('base64url'), { maxAge: 60 });
    else if (ctx.flash && !isRedirect) ctx.clearCookie(flashName);
    const headers = { ...SECURITY_HEADERS, ...r.headers };
    if (config.secureCookies) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
    if (!headers['cache-control']) headers['cache-control'] = 'no-store';
    if (ctx.outCookies.length) headers['set-cookie'] = ctx.outCookies;
    const body = r.body ?? '';
    headers['content-length'] = Buffer.byteLength(body);
    res.writeHead(r.status, headers);
    res.end(ctx.method === 'HEAD' ? undefined : body);
  }

  app.handle = (req, res) =>
    handle(req, res).catch((err) => {
      console.error(`[${config.slug}] fatal`, err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });

  app.listen = (port = Number(env.PORT) || 3000, host = env.HOST ?? '0.0.0.0') =>
    new Promise((resolve) => {
      const server = http.createServer(app.handle);
      server.requestTimeout = 30000;
      server.headersTimeout = 15000;
      server.listen(port, host, () => {
        app.port = server.address().port;
        resolve(server);
      });
    });

  // ---- background jobs ---------------------------------------------------
  app.job = (name, everyMs, fn) => jobs.set(name, { everyMs, fn, running: false });
  app.runJob = async (name) => {
    const job = jobs.get(name);
    if (!job || job.running) return false;
    job.running = true;
    try {
      await job.fn(app);
    } catch (err) {
      console.error(`[${config.slug}] job ${name} failed`, err);
    } finally {
      job.running = false;
    }
    return true;
  };
  app.startJobs = () => {
    for (const [name, job] of jobs) {
      const t = setInterval(() => app.runJob(name), job.everyMs);
      t.unref();
      timers.push(t);
    }
  };
  app.stopJobs = () => {
    while (timers.length) clearInterval(timers.pop());
  };
  app.close = () => {
    app.stopJobs();
    db.close();
  };

  registerCoreRoutes(app);
  return app;
}
