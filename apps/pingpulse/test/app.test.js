import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createPingPulse } from '../src/app.js';
import { makeCert, startHookReceiver, startTarget, startTlsTarget } from './helpers.js';

const ENV = { ALLOW_PRIVATE_TARGETS: '1' };
const boot = (config = {}, options = {}) => startTestApp((o) => createPingPulse({ ...o, ...config }), { env: ENV, ...options });
const outbox = (t) => t.app.db.all('SELECT * FROM outbox ORDER BY id');
const subjects = (t) => outbox(t).map((m) => m.subject);

async function setup(t, plan = 'pro') {
  const c = t.client();
  await c.signup();
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  return c;
}
const addHttp = (c, url, extra = {}) => c.post('/monitors', { type: 'http', name: 'Site', url, interval_s: '60', timeout_s: '5', expected_status: '200-399', method: 'GET', follow_redirects: '1', ...extra });
const monitor = (t, id = 1) => t.app.db.get('SELECT * FROM monitors WHERE id = ?', id);
const tick = async (t, ms = 61_000) => {
  t.clock.t += ms;
  return t.app.runDueChecks();
};

test('landing page and plan pricing', async () => {
  const t = await boot();
  try {
    const home = (await t.client().get('/')).text;
    assert.match(home, /Uptime, SSL expiry and cron-job monitoring/);
    assert.match(home, /₹2,499/);
    assert.match(home, /\$59/);
  } finally {
    await t.close();
  }
});

test('outage lifecycle: debounce → one DOWN alert → one UP alert with incident record', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    assert.equal((await addHttp(c, target.url)).status, 303);
    assert.equal(await t.app.runDueChecks(), 1);
    assert.equal(monitor(t).state, 'up');
    assert.equal(outbox(t).length, 0);

    target.state.status = 500;
    await tick(t);
    assert.equal(monitor(t).state, 'up', 'one failure is not an outage yet');
    assert.equal(outbox(t).length, 0);
    await tick(t);
    assert.equal(monitor(t).state, 'down');
    assert.deepEqual(subjects(t), ['[DOWN] Site']);
    assert.match(outbox(t)[0].body, /Unexpected status 500/);
    assert.equal(outbox(t)[0].to_email, 'owner@example.com');

    await tick(t);
    await tick(t);
    assert.equal(outbox(t).length, 1, 'no alert storm while still down');
    const open = t.app.db.all('SELECT * FROM incidents');
    assert.equal(open.length, 1);
    assert.equal(open[0].resolved_at, null);

    target.state.status = 200;
    await tick(t);
    assert.equal(monitor(t).state, 'up');
    assert.deepEqual(subjects(t), ['[DOWN] Site', '[UP] Site recovered']);
    assert.match(outbox(t)[1].body, /back up after \d+m/);
    assert.ok(t.app.db.get('SELECT resolved_at FROM incidents').resolved_at);

    const page = (await c.get('/monitors/1')).text;
    assert.match(page, /Incidents/);
    assert.match(page, /Unexpected status 500/);
    assert.match(page, /Uptime 24h/);
  } finally {
    await t.close();
    await target.close();
  }
});

test('checks run only when due and respect pause/resume', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url, { interval_s: '300' });
    assert.equal(await t.app.runDueChecks(), 1);
    assert.equal(await t.app.runDueChecks(), 0, 'not due again yet');
    t.clock.t += 200_000;
    assert.equal(await t.app.runDueChecks(), 0);
    t.clock.t += 101_000;
    assert.equal(await t.app.runDueChecks(), 1);

    await c.post('/monitors/1/pause');
    t.clock.t += 400_000;
    target.state.status = 500;
    assert.equal(await t.app.runDueChecks(), 0, 'paused monitors are skipped');
    await c.post('/monitors/1/resume');
    assert.equal(await t.app.runDueChecks(), 1);
  } finally {
    await t.close();
    await target.close();
  }
});

test('manual check works and is rate limited', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url);
    const before = target.state.hits.length;
    await c.post('/monitors/1/check');
    assert.equal(target.state.hits.length, before + 1);
    await c.post('/monitors/1/check');
    assert.equal(target.state.hits.length, before + 1, 'second click within 10s is refused');
    t.clock.t += 11_000;
    await c.post('/monitors/1/check');
    assert.equal(target.state.hits.length, before + 2);
  } finally {
    await t.close();
    await target.close();
  }
});

test('heartbeat: ping keeps it up, missing ping alerts once, next ping recovers', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await c.post('/monitors', { type: 'heartbeat', name: 'Nightly backup', interval_s: '3600', grace_s: '300' });
    const m = monitor(t);
    assert.ok(m.token && m.token.length >= 20);

    const anon = t.client();
    assert.equal((await anon.get(`/ping/${m.token}`)).text, 'OK');
    assert.equal(monitor(t).state, 'up');
    assert.equal((await anon.request('POST', `/ping/${m.token}`)).status, 200, 'POST pings work too');
    assert.equal((await anon.get('/ping/not-a-token')).status, 404);

    t.clock.t += 3_800_000; // inside period + grace
    await t.app.runDueChecks();
    assert.equal(monitor(t).state, 'up');

    t.clock.t += 200_000; // deadline passed
    await t.app.runDueChecks();
    assert.equal(monitor(t).state, 'down');
    assert.deepEqual(subjects(t), ['[DOWN] Nightly backup']);
    assert.match(outbox(t)[0].body, /No ping received for/);

    t.clock.t += 600_000;
    await t.app.runDueChecks();
    assert.equal(outbox(t).length, 1, 'still just one alert');

    await anon.get(`/ping/${m.token}`);
    assert.equal(monitor(t).state, 'up');
    assert.deepEqual(subjects(t), ['[DOWN] Nightly backup', '[UP] Nightly backup recovered']);
  } finally {
    await t.close();
  }
});

test('heartbeat: explicit /fail alerts immediately; never-pinged jobs alert after the first deadline', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await c.post('/monitors', { type: 'heartbeat', name: 'Job A', interval_s: '60', grace_s: '60' });
    await c.post('/monitors', { type: 'heartbeat', name: 'Job B', interval_s: '60', grace_s: '60' });
    const [a, b] = [monitor(t, 1), monitor(t, 2)];
    await t.client().get(`/ping/${a.token}`);
    await t.client().get(`/ping/${a.token}/fail`);
    assert.equal(monitor(t, 1).state, 'down');
    assert.match(outbox(t)[0].body, /Job reported a failure/);

    t.clock.t += 130_000;
    await t.app.runDueChecks();
    assert.equal(monitor(t, 2).state, 'down');
    assert.match(outbox(t).at(-1).body, /No ping has ever been received/);
  } finally {
    await t.close();
  }
});

test('pings are rate limited and paused heartbeats ignore them', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await c.post('/monitors', { type: 'heartbeat', name: 'Job', interval_s: '60', grace_s: '60' });
    const { token } = monitor(t);
    const anon = t.client();
    let last;
    for (let i = 0; i < 125; i++) last = await anon.get(`/ping/${token}`);
    assert.equal(last.status, 429);
    t.clock.t += 61_000;
    await c.post('/monitors/1/pause');
    assert.equal((await anon.get(`/ping/${token}`)).text, 'paused');
  } finally {
    await t.close();
  }
});

test('creation guards: SSRF targets, plan monitor limit, plan minimum interval, validation', async () => {
  const t = await startTestApp((o) => createPingPulse(o), { env: {} }); // strict: no private targets
  try {
    const c = t.client();
    await c.signup();
    for (const url of ['http://127.0.0.1:8080', 'http://localhost', 'http://169.254.169.254/latest', 'http://10.0.0.1', 'ftp://example.com', 'javascript:alert(1)']) {
      const r = await addHttp(c, url);
      assert.equal(r.status, 400, url);
    }
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM monitors').n, 0);

    assert.equal((await addHttp(c, 'https://example.com/a', { interval_s: '60' })).status, 303);
    assert.equal(monitor(t).interval_s, 600, 'free plan floor is 10 minutes');
    assert.equal((await addHttp(c, 'https://example.com/b', { name: 'B' })).status, 303);
    assert.equal((await addHttp(c, 'https://example.com/c', { name: 'C' })).status, 303);
    const fourth = await addHttp(c, 'https://example.com/d', { name: 'D' });
    assert.equal(fourth.status, 303);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM monitors').n, 3, 'free plan = 3 monitors');
    assert.equal((await addHttp(c, 'https://example.com/e', { name: '' })).status, 400);
    assert.equal((await addHttp(c, 'https://example.com/e', { expected_status: 'abc' })).status, 400);
  } finally {
    await t.close();
  }
});

test('webhook alerts are delivered in Slack/Discord-compatible shape', async () => {
  const target = await startTarget();
  const hook = await startHookReceiver();
  const t = await boot();
  try {
    const c = await setup(t);
    await c.post('/settings', { alert_email: 'ops@agency.test', webhook_url: hook.url, fail_threshold: '1', status_slug: '', status_title: '' });
    await addHttp(c, target.url);
    await t.app.runDueChecks();
    target.state.status = 502;
    await tick(t);
    assert.equal(hook.received.length, 1);
    const p = hook.received[0].body;
    assert.match(p.text, /\[DOWN\] Site/);
    assert.equal(p.content, p.text);
    assert.equal(p.event, 'down');
    assert.equal(outbox(t)[0].to_email, 'ops@agency.test', 'custom alert email honoured; fail_threshold 1 alerts on first failure');
  } finally {
    await t.close();
    await target.close();
    await hook.close();
  }
});

test('settings reject internal webhook URLs when private targets are disallowed', async () => {
  const t = await startTestApp((o) => createPingPulse(o), { env: {} });
  try {
    const c = t.client();
    await c.signup();
    await c.post('/settings', { webhook_url: 'http://169.254.169.254/x', fail_threshold: '2' });
    assert.equal(t.app.db.get('SELECT settings FROM users').settings, '{}');
    await c.post('/settings', { webhook_url: 'https://hooks.slack.com/services/T/B/x', fail_threshold: '2' });
    assert.match(t.app.db.get('SELECT settings FROM users').settings, /hooks\.slack\.com/);
  } finally {
    await t.close();
  }
});

const creds = makeCert(10);
const longCreds = makeCert(60);
test('SSL expiry: one alert per threshold; renewal re-arms the alert', { skip: !creds && 'openssl unavailable' }, async () => {
  const soon = await startTlsTarget(creds); // expires in ~10 days
  const later = await startTlsTarget(longCreds); // "renewed": ~60 days
  const t = await boot({ tls: { ca: [creds.cert, longCreds.cert] } }, { start: Date.now() });
  const sslAlerts = () => subjects(t).filter((s) => s.startsWith('[SSL]'));
  try {
    const c = await setup(t);
    await addHttp(c, soon.url, { name: 'Secure site' });
    await t.app.runDueChecks();
    const m = monitor(t);
    assert.equal(m.state, 'up');
    assert.ok(m.ssl_expires_on);
    assert.equal(m.ssl_alerted_days, 14);
    assert.equal(sslAlerts().length, 1);
    assert.match(sslAlerts()[0], /certificate expires in (9|10|11) days/);

    await tick(t);
    await tick(t);
    assert.equal(sslAlerts().length, 1, 'only one alert per threshold');
    assert.match((await c.get('/dashboard')).text, /(9|10|11)d/);

    // renewal: the site now serves a 60-day certificate
    t.app.db.run('UPDATE monitors SET url = ?', later.url);
    await tick(t);
    assert.equal(monitor(t).ssl_alerted_days, null, 'alert state resets once the certificate is renewed');
    assert.equal(sslAlerts().length, 1);

    // ... and if it regresses to a short-lived cert, we alert again
    t.app.db.run('UPDATE monitors SET url = ?', soon.url);
    await tick(t);
    assert.equal(sslAlerts().length, 2);
  } finally {
    await t.close();
    await soon.close();
    await later.close();
  }
});

test('public status page shows only public monitors, no URLs, with overall state', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url, { name: 'Public API', public: '1' });
    await addHttp(c, target.url, { name: 'Internal admin' });
    await c.post('/settings', { status_slug: 'acme-status', status_title: 'Acme <Inc>', fail_threshold: '1', alert_email: '', webhook_url: '' });
    await t.app.runDueChecks();

    const anon = t.client();
    let page = await anon.get('/status/acme-status');
    assert.equal(page.status, 200);
    assert.match(page.text, /All systems operational/);
    assert.match(page.text, /Public API/);
    assert.ok(!page.text.includes('Internal admin'));
    assert.ok(!page.text.includes(target.url), 'monitor URLs are never exposed');
    assert.match(page.text, /Acme &lt;Inc&gt; status/);
    assert.match(page.headers.get('cache-control'), /public/);
    assert.ok(!/csrf-token/.test(page.text));

    target.state.status = 500;
    await tick(t);
    page = await anon.get('/status/acme-status');
    assert.match(page.text, /Partial outage|Major outage/);
    assert.match(page.text, /Past incidents/);

    assert.equal((await anon.get('/status/nope-nope')).status, 404);
  } finally {
    await t.close();
    await target.close();
  }
});

test('status page slugs are validated, unique across accounts, and releasable', async () => {
  const t = await boot();
  try {
    const a = t.client();
    const b = t.client();
    await a.signup('a@example.com');
    await b.signup('b@example.com');
    const save = (c, slug) => c.post('/settings', { status_slug: slug, fail_threshold: '2' });
    await save(a, 'Bad Slug!');
    await save(a, 'admin');
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM status_pages').n, 0);
    await save(a, 'taken-slug');
    await save(b, 'taken-slug');
    assert.equal(t.app.db.get('SELECT user_id FROM status_pages WHERE slug = ?', 'taken-slug').user_id, 1);
    await save(a, '');
    await save(b, 'taken-slug');
    assert.equal(t.app.db.get('SELECT user_id FROM status_pages WHERE slug = ?', 'taken-slug').user_id, 2);
  } finally {
    await t.close();
  }
});

test('tenant isolation: monitors, checks and actions are per account', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const a = await setup(t);
    await addHttp(a, target.url, { name: 'Secret client site' });
    const b = t.client();
    await b.signup('b@example.com');
    assert.equal((await b.get('/monitors/1')).status, 404);
    for (const p of ['pause', 'resume', 'delete', 'check', 'edit']) assert.equal((await b.post(`/monitors/1/${p}`, {})).status, 404, p);
    assert.ok(!(await b.get('/dashboard')).text.includes('Secret client site'));
    assert.equal(monitor(t).paused, 0);
  } finally {
    await t.close();
    await target.close();
  }
});

test('monitor names are escaped; detail and dashboard pages render for every type', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url, { name: '<script>alert(1)</script>' });
    await c.post('/monitors', { type: 'heartbeat', name: '"><img src=x onerror=alert(1)>', interval_s: '3600', grace_s: '300' });
    await t.app.runDueChecks();
    for (const path of ['/dashboard', '/monitors/1', '/monitors/2', '/settings', '/monitors/new', '/monitors/new?type=heartbeat']) {
      const r = await c.get(path);
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes('<script>alert(1)</script>'), path);
      assert.ok(!r.text.includes('<img src=x'), path);
    }
    assert.match((await c.get('/monitors/2')).text, /\/ping\//);
  } finally {
    await t.close();
    await target.close();
  }
});

test('pruning removes old raw checks but keeps daily stats for uptime', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url);
    await t.app.runDueChecks();
    t.clock.t += 3 * 86400000;
    t.app.prune();
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM checks').n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM daily_stats').n, 1);
  } finally {
    await t.close();
    await target.close();
  }
});

test('maintenance window: no checks, incidents or alerts while it lasts; monitoring resumes after', async () => {
  const target = await startTarget();
  const t = await boot();
  try {
    const c = await setup(t);
    await addHttp(c, target.url);
    await t.app.runDueChecks();
    assert.equal(monitor(t).state, 'up');
    await c.post('/monitors/1/maintenance', { hours: '2' });
    assert.match((await c.get('/dashboard')).text, /Maintenance/);
    target.state.status = 503;
    const checksBefore = t.app.db.get('SELECT COUNT(*) AS n FROM checks').n;
    for (let i = 0; i < 4; i++) await tick(t, 61_000);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM checks').n, checksBefore, 'nothing is checked during maintenance');
    assert.equal(outbox(t).length, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM incidents').n, 0);
    assert.equal(monitor(t).state, 'up');
    t.clock.t += 2 * 3600e3;
    await t.app.runDueChecks();
    await tick(t);
    assert.equal(monitor(t).state, 'down', 'real outages are caught again once the window is over');
    assert.deepEqual(subjects(t), ['[DOWN] Site']);
  } finally {
    await t.close();
    await target.close();
  }
});

test('maintenance on a heartbeat restarts its clock, and ending early resumes monitoring', async () => {
  const t = await boot();
  try {
    const c = await setup(t);
    await c.post('/monitors', { type: 'heartbeat', name: 'Backup', interval_s: '3600', grace_s: '300' });
    const { token } = monitor(t);
    await t.client().get(`/ping/${token}`);
    await c.post('/monitors/1/maintenance', { hours: '4' });
    t.clock.t += 3 * 3600e3 + 3600e3 * 0.9; // past the original deadline but inside maintenance
    await t.app.runDueChecks();
    assert.equal(outbox(t).length, 0);
    assert.equal(monitor(t).state, 'up');
    assert.match((await t.client().get(`/ping/${token}/fail`)).text, /in maintenance/);
    assert.equal(monitor(t).state, 'up', 'failure pings are ignored during maintenance');
    t.clock.t += 0.2 * 3600e3; // maintenance over; the clock restarted at its end, so still on time
    await t.app.runDueChecks();
    assert.equal(monitor(t).state, 'up');
    t.clock.t += 3900e3 + 1000; // a full period + grace after the window with no ping
    await t.app.runDueChecks();
    assert.equal(monitor(t).state, 'down');
    await c.post('/monitors/1/maintenance-end');
    assert.equal(monitor(t).maintenance_until, null);
    const other = t.client();
    await other.signup('o@example.com');
    assert.equal((await other.post('/monitors/1/maintenance', { hours: '1' })).status, 404);
  } finally {
    await t.close();
  }
});
