// Routes every product shares: landing, auth, account, billing, webhooks, legal.

import { html } from './html.js';
import { json, redirect } from './http.js';
import { badge, card, csrfField, field, pageHeader, table, safeUrl } from './ui.js';
import { landingPage, legalPage, pricingCards } from './marketing.js';
import { isValidTimezone } from './dates.js';
import {
  DUMMY_HASH,
  clean,
  hashPassword,
  isEmail,
  normEmail,
  safeNext,
  verifyPassword,
} from './security.js';
import { billingConfigured, createCheckout, handleRazorpayWebhook, handleStripeWebhook, paidPlans } from './billing.js';
import { formatMajor } from './money.js';
import { faviconSvg } from './brand.js';

const TZ_BY_CURRENCY = { INR: 'Asia/Kolkata', USD: 'America/New_York' };
const CURRENCY_OPTIONS = [
  ['INR', 'INR — Indian rupee (India)'],
  ['USD', 'USD — US dollar (United States / international)'],
];

export function registerCoreRoutes(app) {
  const { db, config } = app;
  const { env } = config;

  app.get('/healthz', () => json({ ok: true, app: config.slug }), { public: true });

  app.get(
    '/',
    (ctx) => (ctx.user ? redirect(config.home) : landingPage(ctx)),
    { public: true },
  );
  app.get('/favicon.svg', () => ({ status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }, body: faviconSvg(config.glyph) }), { public: true });
  app.get('/privacy', (ctx) => legalPage(ctx, 'privacy'), { public: true });
  app.get('/terms', (ctx) => legalPage(ctx, 'terms'), { public: true });

  // ---- signup / login / logout ------------------------------------------
  const signupForm = (ctx, { error = '', values = {} } = {}) =>
    ctx.page(
      'Create your account',
      html`<div class="auth-card card">
        <h1>Start free</h1>
        <p class="muted">No credit card. Upgrade only when it pays for itself.</p>
        ${error ? html`<div class="flash flash-err">${error}</div>` : ''}
        <form method="post" action="/signup">
          <input type="hidden" name="plan" value="${values.plan ?? ctx.query.plan ?? ''}">
          ${field({ label: 'Your name', name: 'name', value: values.name ?? '', required: true, attrs: { autocomplete: 'name' } })}
          ${field({ label: 'Work email', name: 'email', type: 'email', value: values.email ?? '', required: true, attrs: { autocomplete: 'email' } })}
          ${field({ label: 'Password', name: 'password', type: 'password', required: true, help: 'At least 10 characters.', attrs: { autocomplete: 'new-password', minlength: 10 } })}
          ${field({ label: 'Currency', name: 'currency', type: 'select', options: CURRENCY_OPTIONS, value: values.currency ?? ctx.guessCurrency() })}
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>
        <p class="muted center">Already have an account? <a href="/login">Log in</a></p>
      </div>`,
      { status: error ? 400 : 200 },
    );

  app.get('/signup', (ctx) => (ctx.user ? redirect(config.home) : signupForm(ctx)), { public: true });

  app.post(
    '/signup',
    async (ctx) => {
      const b = ctx.body;
      const values = { name: clean(b.name, 100), email: normEmail(b.email), currency: b.currency === 'INR' ? 'INR' : 'USD', plan: clean(b.plan, 30) };
      if (env.SIGNUPS_OPEN === '0') return signupForm(ctx, { error: 'Signups are currently closed.', values });
      if (!app.limiter.hit(`signup:${ctx.ip}`, 10, 3600e3, ctx.now()).ok) return signupForm(ctx, { error: 'Too many signups from this network. Try again later.', values });
      if (!values.name) return signupForm(ctx, { error: 'Please enter your name.', values });
      if (!isEmail(values.email)) return signupForm(ctx, { error: 'Please enter a valid email address.', values });
      const password = String(b.password ?? '');
      if (password.length < 10 || password.length > 200) return signupForm(ctx, { error: 'Password must be 10–200 characters.', values });
      if (db.get('SELECT 1 AS x FROM users WHERE email = ?', values.email)) {
        return signupForm(ctx, { error: 'That email is already registered. Try logging in.', values });
      }
      const hash = await hashPassword(password);
      let userId;
      try {
        userId = db.run(
          'INSERT INTO users (email, password_hash, name, currency, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          values.email,
          hash,
          values.name,
          values.currency,
          TZ_BY_CURRENCY[values.currency],
          ctx.now(),
        ).id;
      } catch {
        return signupForm(ctx, { error: 'That email is already registered. Try logging in.', values });
      }
      ctx.setSession(app.createSession(userId));
      const paid = config.plans[values.plan] && values.plan !== 'free';
      return redirect(paid ? `/billing?plan=${encodeURIComponent(values.plan)}` : config.home, { ok: `Welcome to ${config.name}!` });
    },
    { public: true, csrf: false },
  );

  const loginForm = (ctx, { error = '', email = '', next = '' } = {}) =>
    ctx.page(
      'Log in',
      html`<div class="auth-card card">
        <h1>Log in</h1>
        ${error ? html`<div class="flash flash-err">${error}</div>` : ''}
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${next}">
          ${field({ label: 'Email', name: 'email', type: 'email', value: email, required: true, attrs: { autocomplete: 'email' } })}
          ${field({ label: 'Password', name: 'password', type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}
          <button class="btn btn-primary btn-block" type="submit">Log in</button>
        </form>
        <p class="muted center">New here? <a href="/signup">Create an account</a></p>
      </div>`,
      { status: error ? 401 : 200 },
    );

  app.get('/login', (ctx) => (ctx.user ? redirect(config.home) : loginForm(ctx, { next: ctx.query.next ?? '' })), { public: true });

  app.post(
    '/login',
    async (ctx) => {
      const email = normEmail(ctx.body.email);
      const next = safeNext(ctx.body.next, config.home);
      const t = ctx.now();
      const ipHit = app.limiter.hit(`login-ip:${ctx.ip}`, 30, 900e3, t);
      const emailHit = app.limiter.hit(`login-email:${email}`, 8, 900e3, t);
      if (!ipHit.ok || !emailHit.ok) return { ...loginForm(ctx, { error: 'Too many attempts. Please wait a few minutes.', email, next }), status: 429 };
      const user = db.get('SELECT id, password_hash FROM users WHERE email = ?', email);
      const ok = await verifyPassword(String(ctx.body.password ?? ''), user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) return loginForm(ctx, { error: 'Incorrect email or password.', email, next });
      app.limiter.reset(`login-email:${email}`);
      ctx.setSession(app.createSession(user.id));
      return redirect(next);
    },
    { public: true, csrf: false },
  );

  app.post('/logout', (ctx) => {
    db.run('DELETE FROM sessions WHERE token_hash = ?', ctx.sessionHash);
    ctx.clearSession();
    return redirect('/');
  });

  // ---- account -----------------------------------------------------------
  app.get('/account', (ctx) => {
    const u = ctx.user;
    return ctx.page(
      'Account',
      html`${pageHeader('Account')}
      ${card(
        'Profile',
        html`<form method="post" action="/account">${csrfField(ctx)}
          ${field({ label: 'Name', name: 'name', value: u.name, required: true })}
          ${field({ label: 'Email', name: 'email_ro', value: u.email, attrs: { disabled: true } })}
          ${field({ label: 'Billing currency', name: 'currency', type: 'select', options: CURRENCY_OPTIONS, value: u.currency })}
          ${field({ label: 'Time zone', name: 'timezone', value: u.timezone, help: 'IANA name, e.g. Asia/Kolkata or America/Chicago. Used for “today” in reminders and reports.', required: true })}
          <button class="btn btn-primary" type="submit">Save</button>
        </form>`,
      )}
      ${card(
        'Change password',
        html`<form method="post" action="/account/password">${csrfField(ctx)}
          ${field({ label: 'Current password', name: 'current', type: 'password', required: true, attrs: { autocomplete: 'current-password' } })}
          ${field({ label: 'New password', name: 'password', type: 'password', required: true, help: 'At least 10 characters. Other devices will be logged out.', attrs: { autocomplete: 'new-password', minlength: 10 } })}
          <button class="btn" type="submit">Update password</button>
        </form>`,
      )}
      ${card(
        'Delete account',
        html`<p class="muted">Permanently deletes your account and every record you created in ${config.name}. This cannot be undone.</p>
        <form method="post" action="/account/delete" data-confirm="Delete your account and all data permanently?">${csrfField(ctx)}
          ${field({ label: 'Confirm password', name: 'current', type: 'password', required: true })}
          <button class="btn btn-danger" type="submit">Delete my account</button>
        </form>`,
        { className: 'danger-zone' },
      )}`,
    );
  });

  app.post('/account', (ctx) => {
    const name = clean(ctx.body.name, 100);
    const currency = ctx.body.currency === 'INR' ? 'INR' : 'USD';
    const timezone = clean(ctx.body.timezone, 60);
    if (!name || !isValidTimezone(timezone)) return redirect('/account', { err: 'Enter your name and a valid time zone (e.g. Asia/Kolkata).' });
    db.run('UPDATE users SET name = ?, currency = ?, timezone = ? WHERE id = ?', name, currency, timezone, ctx.user.id);
    return redirect('/account', { ok: 'Profile saved.' });
  });

  app.post('/account/password', async (ctx) => {
    const password = String(ctx.body.password ?? '');
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(String(ctx.body.current ?? ''), row.password_hash))) return redirect('/account', { err: 'Current password is incorrect.' });
    if (password.length < 10 || password.length > 200) return redirect('/account', { err: 'New password must be 10–200 characters.' });
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), ctx.user.id);
    app.destroySessions(ctx.user.id, ctx.sessionHash);
    return redirect('/account', { ok: 'Password updated.' });
  });

  app.post('/account/delete', async (ctx) => {
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(String(ctx.body.current ?? ''), row.password_hash))) return redirect('/account', { err: 'Password is incorrect.' });
    db.run('DELETE FROM users WHERE id = ?', ctx.user.id);
    ctx.clearSession();
    return redirect('/', { ok: 'Your account and data have been deleted.' });
  });

  // ---- billing -----------------------------------------------------------
  app.get('/billing', (ctx) => {
    const u = ctx.user;
    const usage = config.usage(db, u, ctx);
    const rows = Object.entries(ctx.planInfo.limits ?? {}).map(([key, limit]) => ({
      label: config.limitLabels[key] ?? key,
      used: usage[key] ?? 0,
      limit,
    }));
    const configured = billingConfigured(env, u.currency);
    const wanted = ctx.query.plan;
    const expires = u.plan !== 'free' && u.plan_expires_at ? new Date(u.plan_expires_at).toISOString().slice(0, 10) : null;
    return ctx.page(
      'Billing',
      html`${pageHeader('Billing', '', `You are on the ${ctx.planInfo.label} plan${ctx.plan !== 'free' && expires ? ` · renews or ends around ${expires}` : ''}.`)}
      ${ctx.query.paid ? html`<div class="flash flash-ok">Thanks! Your plan updates as soon as the payment is confirmed (usually seconds).</div>` : ''}
      ${card(
        'Usage this period',
        table({
          columns: [
            { label: 'Resource', render: (r) => r.label },
            { label: 'Used', align: 'right', render: (r) => r.used.toLocaleString('en-US') },
            { label: 'Included', align: 'right', render: (r) => (Number.isFinite(r.limit) ? r.limit.toLocaleString('en-US') : 'Unlimited') },
            {
              label: '',
              render: (r) =>
                Number.isFinite(r.limit)
                  ? html`<progress max="${r.limit}" value="${Math.min(r.used, r.limit)}"></progress>`
                  : '',
            },
          ],
          rows,
        }),
      )}
      <h2 class="section-title">Choose a plan <span class="muted">(${u.currency})</span></h2>
      <div class="pricing">${Object.entries(config.plans).map(([key, plan]) => {
        const price = plan.price[u.currency];
        const current = key === ctx.plan;
        return html`<div class="price-card ${plan.featured ? 'featured' : ''} ${wanted === key ? 'wanted' : ''}">
          <h3>${plan.label} ${current ? badge('Current', 'good') : ''}</h3>
          <div class="price">${price ? formatMajor(price, u.currency) : 'Free'}${price ? html`<small>/month</small>` : ''}</div>
          <p class="muted">${plan.blurb ?? ''}</p>
          ${price && !current
            ? configured
              ? html`<form method="post" action="/billing/checkout">${csrfField(ctx)}<input type="hidden" name="plan" value="${key}"><button class="btn ${plan.featured ? 'btn-primary' : ''}" type="submit">Upgrade to ${plan.label}</button></form>`
              : html`<p class="help">Online payments are not enabled on this deployment yet${env.SUPPORT_EMAIL ? html` — email <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a> to upgrade` : ''}.</p>`
            : ''}
        </div>`;
      })}</div>`,
    );
  });

  app.post('/billing/checkout', async (ctx) => {
    const planKey = String(ctx.body.plan ?? '');
    if (!paidPlans(config.plans).some(([k]) => k === planKey)) return redirect('/billing', { err: 'Unknown plan.' });
    try {
      const url = safeUrl(await createCheckout({ app, user: ctx.user, planKey, currency: ctx.user.currency, baseUrl: ctx.baseUrl }));
      if (!url) throw new Error('No checkout URL');
      return ctx.page(
        'Checkout',
        html`${pageHeader('Continue to secure payment')}
        <div class="card"><p>Your checkout is ready. You will be taken to our payment partner to complete the purchase.</p>
        <p><a class="btn btn-primary btn-lg" href="${url}" data-autoclick rel="noopener">Continue to checkout</a></p></div>`,
      );
    } catch (err) {
      console.error(`[${config.slug}] checkout failed`, err.message);
      return redirect('/billing', { err: 'Could not start checkout. Please try again or contact support.' });
    }
  });

  app.post(
    '/webhooks/stripe',
    (ctx) => {
      const r = handleStripeWebhook(app, ctx.rawBody, ctx.req.headers['stripe-signature']);
      return json({ message: r.message }, r.status);
    },
    { public: true, csrf: false },
  );

  app.post(
    '/webhooks/razorpay',
    (ctx) => {
      const r = handleRazorpayWebhook(app, ctx.rawBody, ctx.req.headers['x-razorpay-signature'], ctx.req.headers['x-razorpay-event-id']);
      return json({ message: r.message }, r.status);
    },
    { public: true, csrf: false },
  );

  // Public pricing page for linking from ads / emails.
  app.get(
    '/pricing',
    (ctx) => ctx.page('Pricing', html`${pageHeader('Pricing')}${pricingCards(app)}`, { noindex: false }),
    { public: true },
  );
}
