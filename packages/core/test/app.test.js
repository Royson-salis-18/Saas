import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startTestApp } from '../src/testing.js';
import { makeFixtureApp } from './helpers.js';

const boot = (options) => startTestApp(makeFixtureApp, options);

test('landing page is public, dashboard requires login', async () => {
  const t = await boot();
  try {
    const c = t.client();
    const home = await c.get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /Hello/);
    assert.match(home.text, /Simple pricing/);
    const dash = await c.get('/dashboard');
    assert.equal(dash.status, 303);
    assert.equal(dash.location, '/login?next=%2Fdashboard');
    const post = await c.request('POST', '/items', { form: { name: 'x' } });
    assert.equal(post.status, 401);
  } finally {
    await t.close();
  }
});

test('security headers are present', async () => {
  const t = await boot();
  try {
    const r = await t.client().get('/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await t.close();
  }
});

test('signup, session, logout, login round trip', async () => {
  const t = await boot();
  try {
    const c = t.client();
    const s = await c.signup('Owner@Example.com');
    assert.equal(s.status, 303);
    assert.equal(s.location, '/dashboard');
    const dash = await c.get('/dashboard');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Free/);
    // session cookie must be HttpOnly + SameSite
    const raw = await fetch(t.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=owner%40example.com&password=correct+horse+battery' });
    const setCookie = raw.headers.getSetCookie().find((x) => x.startsWith('fixture_sid='));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const out = await c.post('/logout');
    assert.equal(out.status, 303);
    assert.equal((await c.get('/dashboard')).status, 303);

    const bad = await c.post('/login', { email: 'owner@example.com', password: 'nope' }, { csrf: false });
    assert.equal(bad.status, 401);
    const good = await c.post('/login', { email: 'owner@example.com', password: 'correct horse battery', next: '/dashboard' }, { csrf: false });
    assert.equal(good.location, '/dashboard');
  } finally {
    await t.close();
  }
});

test('signup validates input and rejects duplicates', async () => {
  const t = await boot();
  try {
    const c = t.client();
    assert.equal((await c.post('/signup', { name: 'A', email: 'bad', password: 'long enough pw', currency: 'USD' }, { csrf: false })).status, 400);
    assert.equal((await c.post('/signup', { name: 'A', email: 'a@b.co', password: 'short', currency: 'USD' }, { csrf: false })).status, 400);
    assert.equal((await c.signup('dup@example.com')).status, 303);
    const again = await t.client().signup('DUP@example.com');
    assert.equal(again.status, 400);
    assert.match(again.text, /already registered/);
  } finally {
    await t.close();
  }
});

test('login redirects ignore external next URLs', async () => {
  const t = await boot();
  try {
    await t.client().signup('x@example.com');
    const c = t.client();
    const r = await c.post('/login', { email: 'x@example.com', password: 'correct horse battery', next: 'https://evil.com' }, { csrf: false });
    assert.equal(r.location, '/dashboard');
  } finally {
    await t.close();
  }
});

test('login is rate limited per email', async () => {
  const t = await boot();
  try {
    await t.client().signup('rl@example.com');
    const c = t.client();
    let last;
    for (let i = 0; i < 10; i++) last = await c.post('/login', { email: 'rl@example.com', password: 'wrong' }, { csrf: false });
    assert.equal(last.status, 429);
    // even the right password is refused while locked out
    const ok = await c.post('/login', { email: 'rl@example.com', password: 'correct horse battery' }, { csrf: false });
    assert.equal(ok.status, 429);
  } finally {
    await t.close();
  }
});

test('POST without CSRF token is rejected; with token accepted', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const noToken = await c.request('POST', '/items', { form: { name: 'sneaky' } });
    assert.equal(noToken.status, 403);
    const wrong = await c.request('POST', '/items', { form: { name: 'sneaky', _csrf: 'nope' } });
    assert.equal(wrong.status, 403);
    const ok = await c.post('/items', { name: 'legit' });
    assert.equal(ok.status, 303);
    assert.match((await c.get('/dashboard')).text, /legit/);
  } finally {
    await t.close();
  }
});

test('XSS: user content is escaped', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/items', { name: '<img src=x onerror=alert(1)>' });
    const page = await c.get('/dashboard');
    assert.ok(!page.text.includes('<img src=x'));
    assert.match(page.text, /&lt;img src=x/);
  } finally {
    await t.close();
  }
});

test('data isolation: users never see each other\'s rows', async () => {
  const t = await boot();
  try {
    const a = t.client();
    const b = t.client();
    await a.signup('a@example.com');
    await b.signup('b@example.com');
    await a.post('/items', { name: 'a-secret' });
    assert.ok(!(await b.get('/dashboard')).text.includes('a-secret'));
  } finally {
    await t.close();
  }
});

test('plan limits are enforced and upgrades lift them', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    await c.post('/items', { name: '1' });
    await c.post('/items', { name: '2' });
    const blocked = await c.post('/items', { name: '3' });
    assert.equal(blocked.status, 303);
    const dash = await c.get('/dashboard');
    assert.match(dash.text, /Your Free plan includes 2 items/);
    t.app.db.run(`UPDATE users SET plan = 'pro', plan_expires_at = ?`, t.clock.t + 86400000);
    await c.post('/items', { name: '3' });
    assert.match((await c.get('/dashboard')).text, /<li>3<\/li>/);
    // expiry returns the account to Free automatically
    t.clock.t += 2 * 86400000;
    await c.post('/items', { name: '4' });
    assert.ok(!(await c.get('/dashboard')).text.includes('<li>4</li>'));
  } finally {
    await t.close();
  }
});

test('password change logs out other sessions; delete account wipes data', async () => {
  const t = await boot();
  try {
    const a = t.client();
    const other = t.client();
    await a.signup('pw@example.com');
    await other.post('/login', { email: 'pw@example.com', password: 'correct horse battery' }, { csrf: false });
    assert.equal((await other.get('/dashboard')).status, 200);

    const bad = await a.post('/account/password', { current: 'wrong', password: 'a brand new password' });
    assert.equal(bad.status, 303);
    await a.post('/account/password', { current: 'correct horse battery', password: 'a brand new password' });
    assert.equal((await other.get('/dashboard')).status, 303, 'other session revoked');
    assert.equal((await a.get('/dashboard')).status, 200, 'current session kept');

    await a.post('/items', { name: 'mine' });
    await a.post('/account/delete', { current: 'a brand new password' });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM items').n, 0);
  } finally {
    await t.close();
  }
});

test('404 and healthz', async () => {
  const t = await boot();
  try {
    const c = t.client();
    assert.equal((await c.get('/nope')).status, 404);
    const h = await c.get('/healthz');
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.text).ok, true);
  } finally {
    await t.close();
  }
});

// ---- billing ------------------------------------------------------------

const stripeSig = (secret, body, t) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('stripe webhook activates plan, is idempotent, rejects bad signatures', async () => {
  const t = await boot({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } });
  try {
    const c = t.client();
    await c.signup();
    const userId = t.app.db.get('SELECT id FROM users').id;
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: String(userId), customer: 'cus_1', payment_status: 'paid', metadata: { app: 'fixture', plan: 'pro', user_id: String(userId) } } },
    });
    const ts = Math.floor(t.clock.t / 1000);
    const send = (sig) => fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body });

    assert.equal((await send('t=1,v1=abc')).status, 400);
    assert.equal((await send(stripeSig('wrong', body, ts))).status, 400);
    assert.equal((await send(stripeSig('whsec_test', body, ts - 3600))).status, 400, 'stale timestamp');
    assert.equal(t.app.db.get('SELECT plan FROM users').plan, 'free');

    assert.equal((await send(stripeSig('whsec_test', body, ts))).status, 200);
    const u = t.app.db.get('SELECT plan, plan_expires_at, stripe_customer_id FROM users');
    assert.equal(u.plan, 'pro');
    assert.equal(u.stripe_customer_id, 'cus_1');
    assert.ok(u.plan_expires_at > t.clock.t);

    // replay is a no-op
    t.app.db.run(`UPDATE users SET plan = 'free'`);
    await send(stripeSig('whsec_test', body, ts));
    assert.equal(t.app.db.get('SELECT plan FROM users').plan, 'free');

    // renewal then cancellation
    t.app.db.run(`UPDATE users SET plan = 'pro', plan_expires_at = ?`, t.clock.t + 1000);
    const renew = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { customer: 'cus_1' } } });
    await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig('whsec_test', renew, ts), 'content-type': 'application/json' }, body: renew });
    assert.ok(t.app.db.get('SELECT plan_expires_at AS e FROM users').e > t.clock.t + 20 * 86400000);
    const cancel = JSON.stringify({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } });
    await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig('whsec_test', cancel, ts), 'content-type': 'application/json' }, body: cancel });
    t.clock.t += 1;
    assert.equal(t.app.planFor(t.app.db.get('SELECT * FROM users')), 'free');
  } finally {
    await t.close();
  }
});

test('stripe webhook ignores other apps and unknown plans', async () => {
  const t = await boot({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } });
  try {
    await t.client().signup();
    const ts = Math.floor(t.clock.t / 1000);
    for (const [id, meta] of [['e1', { app: 'other', plan: 'pro' }], ['e2', { app: 'fixture', plan: 'enterprise-free' }]]) {
      const body = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: { client_reference_id: '1', metadata: meta, payment_status: 'paid' } } });
      await fetch(`${t.base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': stripeSig('whsec_test', body, ts) }, body });
    }
    assert.equal(t.app.db.get('SELECT plan FROM users').plan, 'free');
  } finally {
    await t.close();
  }
});

test('razorpay webhook verifies signature and amount', async () => {
  const t = await boot({ env: { RAZORPAY_WEBHOOK_SECRET: 'rzp_secret' } });
  try {
    await t.client().signup();
    const sign = (b) => createHmac('sha256', 'rzp_secret').update(b).digest('hex');
    const mk = (amount) =>
      JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { amount_paid: amount, notes: { app: 'fixture', user_id: '1', plan: 'pro' } } } } });
    const post = (body, sig, id) => fetch(`${t.base}/webhooks/razorpay`, { method: 'POST', headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': id }, body });

    const underpaid = mk(100);
    assert.equal((await post(underpaid, sign(underpaid), 'ev1')).status, 200);
    assert.equal(t.app.db.get('SELECT plan FROM users').plan, 'free', 'underpayment must not upgrade');

    const good = mk(99900);
    assert.equal((await post(good, 'bad', 'ev2')).status, 400);
    assert.equal((await post(good, sign(good), 'ev3')).status, 200);
    const first = t.app.db.get('SELECT plan, plan_expires_at AS e FROM users');
    assert.equal(first.plan, 'pro');

    // paying again before expiry extends from the current expiry
    assert.equal((await post(good, sign(good), 'ev4')).status, 200);
    assert.ok(t.app.db.get('SELECT plan_expires_at AS e FROM users').e > first.e + 30 * 86400000);
  } finally {
    await t.close();
  }
});

test('checkout creates a Stripe session server-side with plan price', async () => {
  const calls = [];
  const t = await boot({
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    config: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/abc' }), { status: 200 });
      },
    },
  });
  try {
    const c = t.client();
    await c.signup();
    const r = await c.post('/billing/checkout', { plan: 'pro' });
    assert.equal(r.status, 200);
    assert.match(r.text, /https:\/\/checkout\.stripe\.com\/c\/pay\/abc/);
    assert.equal(calls.length, 1);
    const sent = new URLSearchParams(calls[0].init.body);
    assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '2900');
    assert.equal(sent.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(sent.get('metadata[plan]'), 'pro');
    // a client-supplied price can't override the server's
    await c.post('/billing/checkout', { plan: 'pro', amount: '1' });
    assert.equal(new URLSearchParams(calls[1].init.body).get('line_items[0][price_data][unit_amount]'), '2900');
    // unknown / free plans are refused
    assert.equal((await c.post('/billing/checkout', { plan: 'free' })).status, 303);
    assert.equal(calls.length, 2);
  } finally {
    await t.close();
  }
});

test('INR checkout goes through Razorpay payment links', async () => {
  const calls = [];
  const t = await boot({
    env: { RAZORPAY_KEY_ID: 'rzp_test_id', RAZORPAY_KEY_SECRET: 'sec' },
    config: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ short_url: 'https://rzp.io/i/abc' }), { status: 200 });
      },
    },
  });
  try {
    const c = t.client();
    await c.signup('in@example.com', 'correct horse battery', { currency: 'INR' });
    const r = await c.post('/billing/checkout', { plan: 'pro' });
    assert.match(r.text, /rzp\.io\/i\/abc/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.amount, 99900);
    assert.equal(body.currency, 'INR');
    assert.equal(body.notes.plan, 'pro');
  } finally {
    await t.close();
  }
});

test('billing page explains when payments are not configured', async () => {
  const t = await boot();
  try {
    const c = t.client();
    await c.signup();
    const r = await c.get('/billing');
    assert.match(r.text, /not enabled on this deployment/);
    assert.match(r.text, /Free/);
  } finally {
    await t.close();
  }
});

// ---- mail ---------------------------------------------------------------

test('mailer records to outbox, rejects header injection, counts monthly usage', async () => {
  const t = await boot();
  try {
    await t.client().signup();
    const m = t.app.mailer;
    const ok = await m.send({ userId: 1, to: 'client@example.com', subject: 'Hi', text: 'Body', fromName: 'Acme' });
    assert.ok(ok.ok);
    assert.equal((await m.send({ userId: 1, to: 'bad', subject: 'x', text: 'y' })).ok, false);
    assert.equal((await m.send({ userId: 1, to: 'a@b.co', subject: 'x\nBcc: evil@x.com', text: 'y' })).ok, false);
    assert.equal(m.sentThisMonth(1), 1);
    const row = t.app.db.get('SELECT * FROM outbox');
    assert.match(row.body, /Sent with Fixture on behalf of Acme/);
    t.clock.t += 40 * 86400000;
    assert.equal(m.sentThisMonth(1), 0);
  } finally {
    await t.close();
  }
});

test('resend driver posts to provider and records failures', async () => {
  const seen = [];
  let status = 200;
  const t = await boot({
    env: { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'noreply@example.com' },
    config: { fetch: async (url, init) => { seen.push({ url, init }); return new Response('{"id":"1"}', { status }); } },
  });
  try {
    await t.client().signup();
    const ok = await t.app.mailer.send({ userId: 1, to: 'c@example.com', subject: 'S', text: 'T', fromName: 'Biz <script>', replyTo: 'owner@example.com' });
    assert.ok(ok.ok);
    const payload = JSON.parse(seen[0].init.body);
    assert.equal(payload.from, 'Biz script <noreply@example.com>');
    assert.equal(payload.reply_to, 'owner@example.com');
    status = 500;
    const bad = await t.app.mailer.send({ userId: 1, to: 'c@example.com', subject: 'S', text: 'T' });
    assert.equal(bad.ok, false);
    assert.equal(t.app.db.get(`SELECT status FROM outbox ORDER BY id DESC LIMIT 1`).status, 'failed');
  } finally {
    await t.close();
  }
});

test('jobs run, do not overlap, and survive errors', async () => {
  const t = await boot();
  try {
    let runs = 0;
    t.app.job('ok', 1000, async () => { runs++; });
    t.app.job('boom', 1000, async () => { throw new Error('expected'); });
    const origError = console.error;
    console.error = () => {};
    try {
      assert.equal(await t.app.runJob('ok'), true);
      assert.equal(await t.app.runJob('boom'), true);
      assert.equal(await t.app.runJob('boom'), true, 'a failed job can run again');
    } finally {
      console.error = origError;
    }
    assert.equal(runs, 1);
    assert.equal(await t.app.runJob('missing'), false);
  } finally {
    await t.close();
  }
});
