import {
  HttpError,
  badge,
  card,
  ring,
  vbars,
  clean,
  createApp,
  csrfField,
  emptyState,
  field,
  formatDate,
  html,
  isEmail,
  pageHeader,
  randomToken,
  redirect,
  statGrid,
  table,
  text,
  todayIn,
} from '@saas/core';
import { httpCheck, parseTargetUrl, postJson, validStatusSpec } from './netcheck.js';
import {
  GRACE_PERIODS,
  HEARTBEAT_PERIODS,
  INTERVALS,
  RESERVED_SLUGS,
  fmtDuration,
  heartbeatStatus,
  nextState,
  pct,
  slugOk,
  sslAlert,
  sslDaysLeft,
  timeline,
} from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT 'GET',
    expected_status TEXT NOT NULL DEFAULT '200-399',
    keyword TEXT NOT NULL DEFAULT '',
    follow_redirects INTEGER NOT NULL DEFAULT 1,
    interval_s INTEGER NOT NULL DEFAULT 300,
    timeout_s INTEGER NOT NULL DEFAULT 10,
    grace_s INTEGER NOT NULL DEFAULT 300,
    paused INTEGER NOT NULL DEFAULT 0,
    public INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_check_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    last_change_at INTEGER,
    last_latency_ms INTEGER,
    last_error TEXT,
    ssl_expires_on TEXT,
    ssl_alerted_days INTEGER,
    token TEXT UNIQUE,
    last_ping_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX monitors_user ON monitors (user_id);
  CREATE INDEX monitors_due ON monitors (paused, type, next_check_at);
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER,
    error TEXT
  );
  CREATE INDEX checks_monitor_time ON checks (monitor_id, at);
  CREATE TABLE daily_stats (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (monitor_id, day)
  ) WITHOUT ROWID;
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    cause TEXT
  );
  CREATE INDEX incidents_monitor ON incidents (monitor_id, started_at);
  CREATE TABLE status_pages (
    slug TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
  );
  `,
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { monitors: 3 }, minInterval: 600, blurb: 'Watch your own sites.', features: ['Checks every 10 minutes', 'Email alerts', 'Public status page'] },
  starter: { label: 'Starter', price: { INR: 999, USD: 29 }, limits: { monitors: 25 }, minInterval: 300, blurb: 'For freelancers and small agencies.', features: ['Checks every 5 minutes', 'SSL expiry alerts', 'Webhook alerts'] },
  pro: { label: 'Pro', price: { INR: 2499, USD: 59 }, limits: { monitors: 100 }, minInterval: 60, featured: true, blurb: 'For agencies maintaining client sites.', features: ['Checks every minute', 'Cron-job heartbeats', 'Priority support'] },
  agency: { label: 'Agency', price: { INR: 4999, USD: 99 }, limits: { monitors: 500 }, minInterval: 60, blurb: 'For hosting providers and large portfolios.', features: ['Everything in Pro', 'Onboarding call'] },
};

const STATE_TONE = { up: 'good', down: 'bad', pending: 'neutral' };
const STATE_LABEL = { up: 'Up', down: 'Down', pending: 'Pending' };
const DAY = 86400000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createPingPulse(options = {}) {
  const app = createApp({
    slug: 'pingpulse',
    name: 'PingPulse',
    tagline: 'Know when a client site breaks — before the client does',
    accent: '#38bdf8',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Monitors' },
      { href: '/monitors/new', label: 'Add monitor' },
      { href: '/settings', label: 'Alerts & status page' },
    ],
    plans: PLANS,
    limitLabels: { monitors: 'monitors' },
    migrations: MIGRATIONS,
    settingsDefaults: { alert_email: '', webhook_url: '', fail_threshold: 2, status_title: '' },
    usage: (db, user) => ({ monitors: db.get('SELECT COUNT(*) AS n FROM monitors WHERE user_id = ?', user.id).n }),
    marketing: {
      preview: { chartTitle: 'Response time (ms), last 12 checks', ringTitle: 'Uptime, 30 days', bars: [{ label: '', value: 182 }, { label: '', value: 176 }, { label: '', value: 190 }, { label: '', value: 410 }, { label: '', value: 205 }, { label: '', value: 188 }, { label: '', value: 179 }, { label: '', value: 184 }, { label: '', value: 177 }, { label: '', value: 193 }, { label: '', value: 181 }, { label: '', value: 175 }], ring: { value: 99.96, text: '99.96%', label: 'uptime', note: '1 incident, resolved in 4m' }, kpis: [{ label: 'Monitors up', value: '24 / 25', delta: '1 down', deltaTone: 'bad' }, { label: 'Avg response', value: '186 ms', delta: '−8 ms', deltaTone: 'good' }, { label: 'SSL expiring ≤14d', value: '2', delta: 'renew soon', deltaTone: 'warn' }] },
      audience: 'For web agencies, freelancers and SaaS teams',
      headline: 'Uptime, SSL expiry and cron-job monitoring in one calm dashboard.',
      sub: 'PingPulse checks your clients’ sites and background jobs around the clock, alerts you the moment something breaks, and gives each client a clean public status page.',
      points: [
        { title: 'Websites & APIs', body: 'HTTP checks with status, keyword and response-time tracking. Two-strike alerting means no more 3am false alarms.' },
        { title: 'SSL expiry, never a surprise', body: 'Certificates are tracked on every check, with alerts at 14, 7, 3 and 1 days — and the moment one is invalid.' },
        { title: 'Cron-job heartbeats', body: 'Add one curl to the end of a backup or billing job. If it ever stops running, you hear about it.' },
        { title: 'Client status pages', body: 'Share a public page with live status and 30-day uptime. Fewer “is the site down?” emails.' },
      ],
      steps: [
        { title: 'Add your URLs', body: 'Paste a URL or create a heartbeat for a scheduled job.' },
        { title: 'Choose where alerts go', body: 'Email, plus any Slack/Discord/Teams-style webhook.' },
        { title: 'Share a status page', body: 'Pick the monitors to show and send the link to your client.' },
      ],
      faq: [
        { q: 'Where do checks run from?', a: 'From our servers. Private and local addresses are blocked so only public sites can be monitored.' },
        { q: 'How are false alarms avoided?', a: 'A monitor is declared down after consecutive failed checks (2 by default), and recovery is reported on the first success.' },
        { q: 'What does a heartbeat check do?', a: 'Your job calls a unique URL when it finishes. If no ping arrives within the expected period plus a grace window, you are alerted.' },
      ],
    },
    ...options,
  });

  const { db, config } = app;
  const allowPrivate = config.env.ALLOW_PRIVATE_TARGETS === '1';
  const tlsOptions = options.tls ?? {};

  // ---- alerts ---------------------------------------------------------------
  async function notify(user, monitor, kind, detail = {}) {
    let s = {};
    try {
      s = JSON.parse(user.settings || '{}');
    } catch { /* defaults */ }
    const to = isEmail(s.alert_email) ? s.alert_email : user.email;
    const link = app.publicUrl(`/monitors/${monitor.id}`);
    const at = new Date(app.now()).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    let subject;
    let body;
    if (kind === 'down') {
      subject = `[DOWN] ${monitor.name}`;
      body = `${monitor.name}${monitor.url ? ` (${monitor.url})` : ''} is down.\nReason: ${detail.error ?? 'unknown'}\nDetected: ${at}\n\nDetails: ${link}`;
    } else if (kind === 'up') {
      subject = `[UP] ${monitor.name} recovered`;
      body = `${monitor.name} is back up after ${fmtDuration(detail.downMs ?? 0)}.\nRecovered: ${at}\n\nDetails: ${link}`;
    } else {
      subject = detail.daysLeft <= 0 ? `[SSL] ${monitor.name}: certificate has expired` : `[SSL] ${monitor.name}: certificate expires in ${detail.daysLeft} day${detail.daysLeft === 1 ? '' : 's'}`;
      body = `The TLS certificate for ${monitor.url} expires on ${detail.expiresOn}.\nRenew it before then to avoid browser warnings.\n\nDetails: ${link}`;
    }
    await app.mailer.send({ userId: user.id, to, subject, text: body, fromName: 'PingPulse', footer: false });
    if (s.webhook_url) {
      await postJson(
        s.webhook_url,
        { text: `${subject}\n${body}`, content: `${subject}\n${body}`, event: kind, monitor: { id: monitor.id, name: monitor.name, type: monitor.type }, at: new Date(app.now()).toISOString(), ...detail },
        { allowPrivate },
      );
    }
  }

  // ---- recording results ---------------------------------------------------
  /** Persist a check, run the state machine, open/close incidents, fire alerts. */
  async function applyResult(monitor, result, { threshold } = {}) {
    const t = app.now();
    const user = db.get('SELECT * FROM users WHERE id = ?', monitor.user_id);
    if (!user) return;
    let s = {};
    try {
      s = JSON.parse(user.settings || '{}');
    } catch { /* defaults */ }
    const th = threshold ?? Math.min(5, Math.max(1, Number(s.fail_threshold) || 2));
    const fresh = db.get('SELECT * FROM monitors WHERE id = ?', monitor.id) ?? monitor;
    const ns = nextState({ state: fresh.state, failCount: fresh.fail_count }, result.ok, th);
    const day = utcDay(t);
    let incident = null;

    db.tx(() => {
      db.run('INSERT INTO checks (monitor_id, at, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)', fresh.id, t, result.ok ? 1 : 0, result.statusCode ?? null, result.latencyMs ?? null, result.error ?? null);
      db.run(
        `INSERT INTO daily_stats (monitor_id, day, total, ok, latency_sum, latency_n) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (monitor_id, day) DO UPDATE SET total = total + 1, ok = ok + excluded.ok, latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n`,
        fresh.id, day, result.ok ? 1 : 0, result.latencyMs ?? 0, result.latencyMs != null ? 1 : 0,
      );
      db.run(
        `UPDATE monitors SET state = ?, fail_count = ?, last_check_at = ?, next_check_at = ?, last_latency_ms = ?, last_error = ?,
           last_change_at = CASE WHEN ? != state OR last_change_at IS NULL THEN ? ELSE last_change_at END WHERE id = ?`,
        ns.state, ns.failCount, t, fresh.type === 'http' ? t + fresh.interval_s * 1000 : fresh.next_check_at, result.latencyMs ?? null, result.error ?? null, ns.state, t, fresh.id,
      );
      if (ns.transition === 'down') {
        db.run('INSERT INTO incidents (monitor_id, user_id, started_at, cause) VALUES (?, ?, ?, ?)', fresh.id, fresh.user_id, t, (result.error ?? 'Check failed').slice(0, 300));
      } else if (ns.transition === 'up') {
        incident = db.get('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', fresh.id);
        db.run('UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL', t, fresh.id);
      }
    });

    if (ns.transition === 'down') await notify(user, fresh, 'down', { error: result.error });
    if (ns.transition === 'up') await notify(user, fresh, 'up', { downMs: incident ? t - incident.started_at : 0 });

    if (result.sslExpiresOn) {
      const left = sslDaysLeft(result.sslExpiresOn, todayIn('UTC', t));
      db.run('UPDATE monitors SET ssl_expires_on = ? WHERE id = ?', result.sslExpiresOn, fresh.id);
      const alertAt = sslAlert(left, fresh.ssl_alerted_days);
      if (alertAt !== null) {
        db.run('UPDATE monitors SET ssl_alerted_days = ? WHERE id = ?', alertAt, fresh.id);
        await notify(user, fresh, 'ssl', { daysLeft: left, expiresOn: result.sslExpiresOn });
      } else if (left > 14 && fresh.ssl_alerted_days !== null) {
        db.run('UPDATE monitors SET ssl_alerted_days = NULL WHERE id = ?', fresh.id); // renewed
      }
    } else if (!result.ok && /certificate has expired/i.test(result.error ?? '')) {
      db.run('UPDATE monitors SET ssl_expires_on = ? WHERE id = ?', todayIn('UTC', t), fresh.id);
      if (fresh.ssl_alerted_days !== 0) {
        db.run('UPDATE monitors SET ssl_alerted_days = 0 WHERE id = ?', fresh.id);
        await notify(user, fresh, 'ssl', { daysLeft: 0, expiresOn: todayIn('UTC', t) });
      }
    }
  }

  async function checkMonitor(id) {
    const m = db.get(`SELECT * FROM monitors WHERE id = ? AND type = 'http'`, id);
    if (!m) return null;
    const result = await httpCheck({
      url: m.url,
      method: m.method,
      timeoutMs: m.timeout_s * 1000,
      keyword: m.keyword,
      expected: m.expected_status,
      followRedirects: Boolean(m.follow_redirects),
      allowPrivate,
      tls: tlsOptions,
    });
    await applyResult(m, result);
    return result;
  }

  async function checkHeartbeats() {
    const t = app.now();
    for (const m of db.all(`SELECT * FROM monitors WHERE paused = 0 AND type = 'heartbeat' AND state != 'down'`)) {
      const hb = heartbeatStatus(m, t);
      if (hb.late) {
        const never = m.last_ping_at === null;
        await applyResult(m, { ok: false, error: never ? 'No ping has ever been received' : `No ping received for ${fmtDuration(t - m.last_ping_at)} (expected ${fmtDuration(m.interval_s * 1000)})` }, { threshold: 1 });
      }
    }
  }

  /** Run every check that is due. Returns the number of HTTP checks executed. */
  async function runDueChecks({ limit = 60, concurrency = 10 } = {}) {
    const due = db.all(`SELECT id FROM monitors WHERE paused = 0 AND type = 'http' AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`, app.now(), limit);
    for (let i = 0; i < due.length; i += concurrency) {
      await Promise.all(due.slice(i, i + concurrency).map((d) => checkMonitor(d.id).catch((err) => console.error('[pingpulse] check failed', err))));
    }
    await checkHeartbeats();
    return due.length;
  }

  function prune() {
    const t = app.now();
    db.run('DELETE FROM checks WHERE at < ?', t - 2 * DAY);
    db.run('DELETE FROM daily_stats WHERE day < ?', utcDay(t - 400 * DAY));
    db.run('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?', t - 400 * DAY);
  }

  app.runDueChecks = runDueChecks;
  app.checkMonitor = checkMonitor;
  app.prune = prune;
  app.job('checks', 15_000, () => runDueChecks());
  app.job('prune', 3_600_000, () => prune());

  // ---- helpers -----------------------------------------------------------------
  const getMonitor = (ctx, id) => {
    const m = db.get('SELECT * FROM monitors WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!m) throw new HttpError(404, 'Monitor not found');
    return m;
  };

  /** Per-monitor 24h uptime + 48-bucket timeline, aggregated in SQL. */
  function dayView(userId) {
    const now = app.now();
    const start = now - DAY;
    const size = DAY / 48;
    const rows = db.all(
      `SELECT c.monitor_id AS mid, CAST((c.at - ?1) / ?2 AS INTEGER) AS b, SUM(c.ok) AS ok, COUNT(*) AS n
       FROM checks c JOIN monitors m ON m.id = c.monitor_id WHERE m.user_id = ?3 AND c.at > ?1 GROUP BY c.monitor_id, b`,
      start, size, userId,
    );
    const out = new Map();
    for (const r of rows) {
      const e = out.get(r.mid) ?? { cells: Array(48).fill('none'), ok: 0, n: 0 };
      const i = Math.min(47, Math.max(0, r.b));
      e.cells[i] = r.n - r.ok > 0 ? 'down' : 'up';
      e.ok += r.ok;
      e.n += r.n;
      out.set(r.mid, e);
    }
    return out;
  }

  const bars = (cells, cls = '') => html`<div class="bars ${cls}">${cells.map((c) => html`<i class="${c === 'up' ? '' : c}"></i>`)}</div>`;
  const targetOf = (m) => (m.type === 'heartbeat' ? 'Cron heartbeat' : m.url.replace(/^https?:\/\//, '').slice(0, 60));

  // ---- dashboard -----------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const monitors = db.all('SELECT * FROM monitors WHERE user_id = ? ORDER BY CASE state WHEN \'down\' THEN 0 ELSE 1 END, name COLLATE NOCASE', ctx.user.id);
    if (!monitors.length) {
      return ctx.page('Monitors', html`${pageHeader('Monitors')}${emptyState('Add your first monitor', 'Watch a website or API, or create a heartbeat for a cron job.', html`<p><a class="btn btn-primary" href="/monitors/new">Add website monitor</a> <a class="btn" href="/monitors/new?type=heartbeat">Add cron heartbeat</a></p>`)}`);
    }
    const view = dayView(ctx.user.id);
    const today = todayIn('UTC', ctx.now());
    const down = monitors.filter((m) => m.state === 'down').length;
    const expiring = monitors.filter((m) => m.ssl_expires_on && sslDaysLeft(m.ssl_expires_on, today) <= 14).length;
    return ctx.page(
      'Monitors',
      html`${pageHeader('Monitors', html`<a class="btn btn-primary" href="/monitors/new">Add monitor</a>`)}
      ${statGrid([
        { label: 'Monitors', value: monitors.length },
        { label: 'Down now', value: down, tone: down ? 'bad' : 'good' },
        { label: 'SSL expiring ≤14d', value: expiring, tone: expiring ? 'warn' : '' },
        { label: 'Paused', value: monitors.filter((m) => m.paused).length },
      ])}
      <div class="viz">${card('Response time by monitor (ms)', vbars({ height: 170, items: monitors.filter((m) => m.last_latency_ms != null).slice(0, 10).map((m) => ({ label: m.name.slice(0, 10), value: m.last_latency_ms, tone: m.state === 'down' ? 'bad' : '' })) }))}${card('Uptime, last 24h', html`${(() => { const t = [...view.values()].reduce((a, v) => ({ ok: a.ok + v.ok, n: a.n + v.n }), { ok: 0, n: 0 }); const u = t.n ? pct(t.ok, t.n) : null; return ring({ value: u ?? 0, max: 100, text: u === null ? '—' : `${u}%`, label: 'all monitors' }); })()}<p class="muted center">${down ? `${down} monitor${down === 1 ? '' : 's'} down now` : 'Everything is up'}</p>`, { className: 'ring-card' })}</div>
      ${card('', table({
        columns: [
          { label: 'Status', render: (m) => (m.paused ? badge('Paused', 'neutral') : badge(STATE_LABEL[m.state], STATE_TONE[m.state])) },
          { label: 'Monitor', render: (m) => html`<a href="/monitors/${m.id}"><strong>${m.name}</strong></a><span class="sub">${targetOf(m)}</span>` },
          { label: 'Last 24h', render: (m) => bars(view.get(m.id)?.cells ?? Array(48).fill('none')) },
          { label: 'Uptime', align: 'right', render: (m) => { const v = view.get(m.id); return v ? `${pct(v.ok, v.n)}%` : '—'; } },
          { label: 'Response', align: 'right', render: (m) => (m.last_latency_ms != null ? `${m.last_latency_ms} ms` : '—') },
          {
            label: 'SSL',
            render: (m) => {
              if (!m.ssl_expires_on) return '';
              const d = sslDaysLeft(m.ssl_expires_on, today);
              return badge(d <= 0 ? 'expired' : `${d}d`, d <= 7 ? 'bad' : d <= 14 ? 'warn' : 'neutral');
            },
          },
        ],
        rows: monitors,
      }))}`,
    );
  });

  // ---- create / edit ------------------------------------------------------------
  const minInterval = (ctx) => ctx.planInfo.minInterval ?? 300;
  const intervalOptions = (ctx) => INTERVALS.filter(([s]) => s >= minInterval(ctx));

  const monitorForm = (ctx, m = {}, error = '') => {
    const type = m.type ?? (ctx.query.type === 'heartbeat' ? 'heartbeat' : 'http');
    return html`${error ? html`<div class="flash flash-err">${error}</div>` : ''}
      <form method="post" action="${m.id ? `/monitors/${m.id}/edit` : '/monitors'}">${csrfField(ctx)}
        <input type="hidden" name="type" value="${type}">
        ${field({ label: 'Name', name: 'name', value: m.name ?? '', required: true, placeholder: type === 'http' ? 'Acme marketing site' : 'Nightly database backup' })}
        ${type === 'http'
          ? html`
            ${field({ label: 'URL', name: 'url', type: 'url', value: m.url ?? '', required: true, placeholder: 'https://example.com/health' })}
            <div class="row">
              ${field({ label: 'Check every', name: 'interval_s', type: 'select', options: intervalOptions(ctx), value: m.interval_s ?? intervalOptions(ctx)[0][0] })}
              ${field({ label: 'Method', name: 'method', type: 'select', options: ['GET', 'HEAD'], value: m.method ?? 'GET' })}
              ${field({ label: 'Timeout (seconds)', name: 'timeout_s', type: 'number', value: m.timeout_s ?? 10, attrs: { min: 3, max: 30 } })}
            </div>
            <div class="row">
              ${field({ label: 'Expected status codes', name: 'expected_status', value: m.expected_status ?? '200-399', help: 'e.g. 200-399 or 200,204' })}
              ${field({ label: 'Must contain text (optional)', name: 'keyword', value: m.keyword ?? '', help: 'Page counts as down if this text is missing.' })}
            </div>
            ${field({ label: 'Follow redirects', name: 'follow_redirects', type: 'checkbox', value: m.id ? m.follow_redirects : 1 })}`
          : html`
            <div class="row">
              ${field({ label: 'Job runs', name: 'interval_s', type: 'select', options: HEARTBEAT_PERIODS, value: m.interval_s ?? 86400 })}
              ${field({ label: 'Grace period', name: 'grace_s', type: 'select', options: GRACE_PERIODS, value: m.grace_s ?? 300, help: 'How late a ping may be before you are alerted.' })}
            </div>`}
        ${field({ label: 'Show on my public status page', name: 'public', type: 'checkbox', value: m.public ?? 0 })}
        <button class="btn btn-primary" type="submit">${m.id ? 'Save changes' : 'Add monitor'}</button>
      </form>`;
  };

  function readMonitorForm(ctx, existing = null) {
    const b = ctx.body;
    const type = existing?.type ?? (b.type === 'heartbeat' ? 'heartbeat' : 'http');
    const v = { type, name: clean(b.name, 80), public: b.public === '1' ? 1 : 0 };
    if (!v.name) return { v, error: 'Give the monitor a name.' };
    if (type === 'http') {
      const parsed = parseTargetUrl(b.url, { allowPrivate });
      if (parsed.error) return { v, error: parsed.error };
      const interval = Math.max(Number(b.interval_s) || 300, minInterval(ctx));
      const timeout = Math.min(30, Math.max(3, Math.round(Number(b.timeout_s)) || 10));
      if (!validStatusSpec(b.expected_status || '200-399')) return { v, error: 'Expected status codes should look like 200-399 or 200,204.' };
      Object.assign(v, {
        url: parsed.url.href,
        method: b.method === 'HEAD' ? 'HEAD' : 'GET',
        interval_s: interval,
        timeout_s: Math.min(timeout, interval),
        expected_status: clean(b.expected_status || '200-399', 40),
        keyword: clean(b.keyword, 100),
        follow_redirects: b.follow_redirects === '1' ? 1 : 0,
      });
    } else {
      const valid = (list, x, d) => (list.some(([s]) => s === Number(x)) ? Number(x) : d);
      Object.assign(v, { interval_s: valid(HEARTBEAT_PERIODS, b.interval_s, 86400), grace_s: valid(GRACE_PERIODS, b.grace_s, 300) });
    }
    return { v, error: '' };
  }

  app.get('/monitors/new', (ctx) => ctx.page('Add monitor', html`${pageHeader('Add monitor')}
    <div class="pill-row"><a href="/monitors/new" class="${ctx.query.type === 'heartbeat' ? '' : 'active'}">Website / API</a><a href="/monitors/new?type=heartbeat" class="${ctx.query.type === 'heartbeat' ? 'active' : ''}">Cron heartbeat</a></div>
    ${card('', monitorForm(ctx))}`));

  app.post('/monitors', (ctx) => {
    const { v, error } = readMonitorForm(ctx);
    const again = (msg) => ctx.page('Add monitor', html`${pageHeader('Add monitor')}${card('', monitorForm({ ...ctx, query: { type: v.type } }, v, msg))}`, { status: 400 });
    if (error) return again(error);
    const limitMsg = ctx.checkLimit('monitors', db.get('SELECT COUNT(*) AS n FROM monitors WHERE user_id = ?', ctx.user.id).n);
    if (limitMsg) return redirect('/dashboard', { err: limitMsg });
    const t = ctx.now();
    const id = db.run(
      `INSERT INTO monitors (user_id, name, type, url, method, expected_status, keyword, follow_redirects, interval_s, timeout_s, grace_s, public, token, next_check_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.user.id, v.name, v.type, v.url ?? '', v.method ?? 'GET', v.expected_status ?? '200-399', v.keyword ?? '', v.follow_redirects ?? 1,
      v.interval_s, v.timeout_s ?? 10, v.grace_s ?? 300, v.public, v.type === 'heartbeat' ? randomToken(18) : null, t, t,
    ).id;
    if (v.type === 'http' && config.env.NODE_ENV !== 'test') setImmediate(() => checkMonitor(id).catch((e) => console.error('[pingpulse] first check failed', e)));
    return redirect(`/monitors/${id}`, { ok: v.type === 'http' ? 'Monitor added. The first check runs within a few seconds.' : 'Heartbeat created. Add the ping URL to the end of your job.' });
  });

  app.get('/monitors/:id', (ctx) => {
    const m = getMonitor(ctx, ctx.params.id);
    const now = ctx.now();
    const today = todayIn('UTC', now);
    const recent = db.all('SELECT * FROM checks WHERE monitor_id = ? AND at > ? ORDER BY at', m.id, now - DAY);
    const last = [...recent].reverse().slice(0, 20);
    const incidents = db.all('SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 10', m.id);
    const stat = (days) => {
      const r = db.get('SELECT COALESCE(SUM(total),0) AS n, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(latency_sum),0) AS ls, COALESCE(SUM(latency_n),0) AS ln FROM daily_stats WHERE monitor_id = ? AND day >= ?', m.id, utcDay(now - (days - 1) * DAY));
      return { up: pct(r.ok, r.n), avg: r.ln ? Math.round(r.ls / r.ln) : null };
    };
    const d1 = stat(1);
    const d7 = stat(7);
    const d30 = stat(30);
    const maxLat = Math.max(1, ...last.map((c) => c.latency_ms ?? 0));
    const sslLeft = m.ssl_expires_on ? sslDaysLeft(m.ssl_expires_on, today) : null;
    const act = (path, label, cls = 'btn') => html`<form method="post" action="/monitors/${m.id}/${path}" class="inline">${csrfField(ctx)}<button class="${cls}" type="submit">${label}</button></form>`;
    const pingUrl = m.token ? app.publicUrl(`/ping/${m.token}`) : '';
    return ctx.page(
      m.name,
      html`${pageHeader(
        html`${m.name} ${m.paused ? badge('Paused', 'neutral') : badge(STATE_LABEL[m.state], STATE_TONE[m.state])}`,
        html`${m.type === 'http' ? act('check', 'Check now') : ''}${m.paused ? act('resume', 'Resume') : act('pause', 'Pause')}`,
        m.type === 'http' ? m.url : 'Cron-job heartbeat',
      )}
      ${m.last_error && m.state === 'down' ? html`<div class="flash flash-err">${m.last_error}</div>` : ''}
      ${statGrid([
        { label: 'Uptime 24h', value: d1.up === null ? '—' : `${d1.up}%` },
        { label: 'Uptime 7d', value: d7.up === null ? '—' : `${d7.up}%` },
        { label: 'Uptime 30d', value: d30.up === null ? '—' : `${d30.up}%` },
        ...(m.type === 'http' ? [{ label: 'Avg response 24h', value: d1.avg === null ? '—' : `${d1.avg} ms` }] : []),
        ...(sslLeft !== null ? [{ label: 'SSL expires', value: sslLeft <= 0 ? 'Expired' : `${sslLeft} days`, tone: sslLeft <= 7 ? 'bad' : sslLeft <= 14 ? 'warn' : '', hint: formatDate(m.ssl_expires_on) }] : []),
      ])}
      ${m.type === 'heartbeat'
        ? card('Ping URL', html`<p class="muted">Call this URL every time your job succeeds. It expects a ping ${HEARTBEAT_PERIODS.find(([s]) => s === m.interval_s)?.[1] ?? `every ${fmtDuration(m.interval_s * 1000)}`}, plus a ${fmtDuration(m.grace_s * 1000)} grace period.</p>
            <div class="copy-box mono" id="ping">${pingUrl}</div>
            <p><button class="btn btn-sm" type="button" data-copy="#ping">Copy URL</button></p>
            <p class="help">Example (cron): <span class="mono">0 2 * * * /usr/local/bin/backup.sh &amp;&amp; curl -fsS -m 10 --retry 3 ${pingUrl}</span><br>Report a failure explicitly with <span class="mono">${pingUrl}/fail</span>.</p>`)
        : ''}
      <div class="grid-2">
        ${card('Last 24 hours', html`${bars(timeline(recent, now, DAY, 48))}<p class="help">Each bar is 30 minutes. Red = at least one failed check.</p>
          ${m.type === 'http' && last.length ? html`<div class="bars lat" style="height:60px;margin-top:.8rem">${[...last].reverse().map((c) => html`<i class="${c.ok ? '' : 'down'}" style="height:${Math.max(6, Math.round(((c.latency_ms ?? maxLat) / maxLat) * 100))}%" title="${c.latency_ms ?? '—'} ms"></i>`)}</div><p class="help">Response time, last ${last.length} checks (max ${maxLat} ms).</p>` : ''}`)}
        ${card('Incidents', table({
          columns: [
            { label: 'Started', render: (i) => new Date(i.started_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' },
            { label: 'Duration', render: (i) => (i.resolved_at ? fmtDuration(i.resolved_at - i.started_at) : badge('ongoing', 'bad')) },
            { label: 'Cause', render: (i) => i.cause },
          ],
          rows: incidents,
          empty: 'No incidents. 🎉',
        }))}
      </div>
      ${m.type === 'http'
        ? card('Recent checks', table({
            columns: [
              { label: 'Time', render: (c) => new Date(c.at).toISOString().replace('T', ' ').slice(0, 19) },
              { label: 'Result', render: (c) => (c.ok ? badge('OK', 'good') : badge('Failed', 'bad')) },
              { label: 'Status', render: (c) => c.status_code ?? '—' },
              { label: 'Response', align: 'right', render: (c) => (c.latency_ms != null ? `${c.latency_ms} ms` : '—') },
              { label: 'Error', render: (c) => c.error ?? '' },
            ],
            rows: last,
            empty: 'Waiting for the first check…',
          }))
        : ''}
      ${card('Settings', monitorForm(ctx, m))}
      ${act('delete', 'Delete monitor', 'btn btn-danger')}`,
    );
  });

  app.post('/monitors/:id/edit', (ctx) => {
    const m = getMonitor(ctx, ctx.params.id);
    const { v, error } = readMonitorForm(ctx, m);
    if (error) return redirect(`/monitors/${m.id}`, { err: error });
    if (m.type === 'http') {
      db.run(
        `UPDATE monitors SET name = ?, url = ?, method = ?, expected_status = ?, keyword = ?, follow_redirects = ?, interval_s = ?, timeout_s = ?, public = ?,
         next_check_at = MIN(next_check_at, ?) WHERE id = ?`,
        v.name, v.url, v.method, v.expected_status, v.keyword, v.follow_redirects, v.interval_s, v.timeout_s, v.public, ctx.now() + v.interval_s * 1000, m.id,
      );
    } else {
      db.run('UPDATE monitors SET name = ?, interval_s = ?, grace_s = ?, public = ? WHERE id = ?', v.name, v.interval_s, v.grace_s, v.public, m.id);
    }
    return redirect(`/monitors/${m.id}`, { ok: 'Saved.' });
  });

  app.post('/monitors/:id/pause', (ctx) => {
    db.run('UPDATE monitors SET paused = 1 WHERE id = ?', getMonitor(ctx, ctx.params.id).id);
    return redirect(`/monitors/${ctx.params.id}`, { ok: 'Paused. No checks or alerts until you resume.' });
  });
  app.post('/monitors/:id/resume', (ctx) => {
    const m = getMonitor(ctx, ctx.params.id);
    // restart the heartbeat clock so a long pause doesn't trigger an instant alert
    db.run('UPDATE monitors SET paused = 0, next_check_at = ?, last_ping_at = CASE WHEN type = \'heartbeat\' THEN ? ELSE last_ping_at END WHERE id = ?', ctx.now(), ctx.now(), m.id);
    return redirect(`/monitors/${m.id}`, { ok: 'Resumed.' });
  });
  app.post('/monitors/:id/delete', (ctx) => {
    db.run('DELETE FROM monitors WHERE id = ?', getMonitor(ctx, ctx.params.id).id);
    return redirect('/dashboard', { ok: 'Monitor deleted.' });
  });
  app.post('/monitors/:id/check', async (ctx) => {
    const m = getMonitor(ctx, ctx.params.id);
    if (!app.limiter.hit(`checknow:${m.id}`, 1, 10_000, ctx.now()).ok) return redirect(`/monitors/${m.id}`, { err: 'Please wait a few seconds between manual checks.' });
    const r = await checkMonitor(m.id);
    return redirect(`/monitors/${m.id}`, r?.ok ? { ok: `Check passed in ${r.latencyMs} ms.` } : { err: `Check failed: ${r?.error ?? 'unknown error'}` });
  });

  // ---- heartbeat pings (public, token-addressed) ----------------------------
  const ping = (failure) => async (ctx) => {
    if (!app.limiter.hit(`ping:${ctx.params.token}`, 120, 60_000, ctx.now()).ok) return text('rate limited', 429);
    const m = db.get(`SELECT * FROM monitors WHERE token = ? AND type = 'heartbeat'`, ctx.params.token);
    if (!m) return text('unknown ping token', 404);
    if (m.paused) return text('paused');
    const t = ctx.now();
    if (failure) {
      await applyResult(m, { ok: false, error: 'Job reported a failure' }, { threshold: 1 });
    } else {
      db.run('UPDATE monitors SET last_ping_at = ? WHERE id = ?', t, m.id);
      await applyResult({ ...m, last_ping_at: t }, { ok: true });
    }
    return text('OK');
  };
  app.get('/ping/:token', ping(false), { public: true });
  app.post('/ping/:token', ping(false), { public: true, csrf: false });
  app.get('/ping/:token/fail', ping(true), { public: true });
  app.post('/ping/:token/fail', ping(true), { public: true, csrf: false });

  // ---- settings & status page ---------------------------------------------------
  app.get('/settings', (ctx) => {
    const s = ctx.settings;
    const slug = db.get('SELECT slug FROM status_pages WHERE user_id = ?', ctx.user.id)?.slug ?? '';
    return ctx.page(
      'Alerts & status page',
      html`${pageHeader('Alerts & status page')}
      <form method="post" action="/settings">${csrfField(ctx)}
        ${card('Where alerts go', html`
          ${field({ label: 'Alert email', name: 'alert_email', type: 'email', value: s.alert_email, placeholder: ctx.user.email, help: 'Defaults to your login email.' })}
          ${field({ label: 'Webhook URL (optional)', name: 'webhook_url', type: 'url', value: s.webhook_url, help: 'We POST JSON with “text” and “content” fields, which Slack, Discord and Microsoft Teams incoming webhooks accept.' })}
          ${field({ label: 'Failed checks before alerting', name: 'fail_threshold', type: 'number', value: s.fail_threshold, attrs: { min: 1, max: 5 }, help: '2 avoids false alarms from a single network blip. Recovery is reported on the first success.' })}
        `)}
        ${card('Public status page', html`
          ${field({ label: 'Page address', name: 'status_slug', value: slug, placeholder: 'acme-status', help: slug ? html`Live at <a href="/status/${slug}" target="_blank" rel="noopener">${app.publicUrl(`/status/${slug}`)}</a>` : 'Letters, numbers and dashes. Leave empty to disable.' })}
          ${field({ label: 'Page title', name: 'status_title', value: s.status_title, placeholder: ctx.user.name })}
          <p class="help">Only monitors you mark “Show on my public status page” appear there. URLs are never shown.</p>
        `)}
        <button class="btn btn-primary" type="submit">Save</button>
      </form>`,
    );
  });

  app.post('/settings', (ctx) => {
    const b = ctx.body;
    const slug = String(b.status_slug ?? '').trim().toLowerCase();
    if (slug && (!slugOk(slug) || RESERVED_SLUGS.has(slug))) return redirect('/settings', { err: 'Page address must be 3–40 letters, numbers or single dashes.' });
    const hook = String(b.webhook_url ?? '').trim();
    if (hook && parseTargetUrl(hook, { allowPrivate }).error) return redirect('/settings', { err: 'That webhook URL is not allowed. Use a public https:// address.' });
    if (slug) {
      const taken = db.get('SELECT user_id FROM status_pages WHERE slug = ?', slug);
      if (taken && taken.user_id !== ctx.user.id) return redirect('/settings', { err: 'That page address is already taken.' });
    }
    db.tx(() => {
      db.run('DELETE FROM status_pages WHERE user_id = ?', ctx.user.id);
      if (slug) db.run('INSERT INTO status_pages (slug, user_id) VALUES (?, ?)', slug, ctx.user.id);
    });
    ctx.saveSettings({
      alert_email: isEmail(String(b.alert_email ?? '').trim().toLowerCase()) ? String(b.alert_email).trim().toLowerCase() : '',
      webhook_url: hook.slice(0, 500),
      fail_threshold: Math.min(5, Math.max(1, Math.round(Number(b.fail_threshold)) || 2)),
      status_title: clean(b.status_title, 80),
    });
    return redirect('/settings', { ok: 'Saved.' });
  });

  app.get('/status/:slug', (ctx) => {
    const page = db.get('SELECT s.user_id, u.name, u.settings FROM status_pages s JOIN users u ON u.id = s.user_id WHERE s.slug = ?', String(ctx.params.slug).toLowerCase());
    if (!page) throw new HttpError(404, 'Status page not found');
    let s = {};
    try { s = JSON.parse(page.settings || '{}'); } catch { /* defaults */ }
    const monitors = db.all('SELECT id, name, state, paused FROM monitors WHERE user_id = ? AND public = 1 ORDER BY name COLLATE NOCASE', page.user_id);
    const now = ctx.now();
    const days = Array.from({ length: 30 }, (_, i) => utcDay(now - (29 - i) * DAY));
    const stats = db.all(
      `SELECT d.monitor_id AS mid, d.day, d.total, d.ok FROM daily_stats d JOIN monitors m ON m.id = d.monitor_id WHERE m.user_id = ? AND m.public = 1 AND d.day >= ?`,
      page.user_id, days[0],
    );
    const byMonitor = new Map();
    for (const r of stats) (byMonitor.get(r.mid) ?? byMonitor.set(r.mid, new Map()).get(r.mid)).set(r.day, r);
    const active = monitors.filter((m) => !m.paused);
    const downCount = active.filter((m) => m.state === 'down').length;
    const headline = !active.length ? 'No monitors yet' : downCount === 0 ? 'All systems operational' : downCount === active.length ? 'Major outage' : 'Partial outage';
    const tone = downCount === 0 ? 'good' : downCount === active.length ? 'bad' : 'warn';
    const incidents = db.all(
      `SELECT i.*, m.name FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE m.user_id = ? AND m.public = 1 AND i.started_at > ? ORDER BY i.started_at DESC LIMIT 10`,
      page.user_id, now - 14 * DAY,
    );
    const title = s.status_title || page.name;
    const res = ctx.page(
      `${title} status`,
      html`<div class="prose" style="max-width:820px;margin:0 auto">
        <h1>${title} status</h1>
        <div class="flash flash-${tone === 'good' ? 'ok' : 'err'}">${headline}</div>
        ${monitors.map((m) => {
          const rows = byMonitor.get(m.id) ?? new Map();
          const cells = days.map((d) => { const r = rows.get(d); if (!r || !r.total) return 'none'; const p = r.ok / r.total; return p >= 0.999 ? 'up' : p >= 0.95 ? 'warn' : 'down'; });
          const tot = [...rows.values()].reduce((a, r) => ({ n: a.n + r.total, ok: a.ok + r.ok }), { n: 0, ok: 0 });
          return card('', html`<div class="page-header" style="margin-bottom:.4rem"><div><strong>${m.name}</strong></div><div>${m.paused ? badge('Paused', 'neutral') : badge(m.state === 'down' ? 'Down' : m.state === 'up' ? 'Operational' : 'Pending', STATE_TONE[m.state])} <span class="muted">${tot.n ? `${pct(tot.ok, tot.n)}% (30 days)` : ''}</span></div></div>${bars(cells)}`);
        })}
        <h2 class="section-title">Past incidents (14 days)</h2>
        ${incidents.length
          ? table({
              columns: [
                { label: 'Service', render: (i) => i.name },
                { label: 'Started', render: (i) => new Date(i.started_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' },
                { label: 'Duration', render: (i) => (i.resolved_at ? fmtDuration(i.resolved_at - i.started_at) : 'ongoing') },
              ],
              rows: incidents,
            })
          : html`<p class="muted">No incidents reported.</p>`}
      </div>`,
      { noindex: false },
    );
    res.headers = { 'cache-control': 'public, max-age=30' };
    return res;
  }, { public: true });

  return app;
}
