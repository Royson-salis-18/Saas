// Subscription billing without a billing database:
//  * Stripe Checkout (subscriptions, USD/EUR/...) and Razorpay payment links (INR)
//    are created server-side with prices taken from the plan table, so the
//    client can't tamper with amounts.
//  * Webhooks (signature-verified, idempotent) flip users.plan + plan_expires_at.
//  * A user whose plan_expires_at has passed is treated as Free automatically.

import { hmacHex, safeEqual } from './security.js';

const STRIPE_PERIOD_MS = 35 * 86400000; // monthly + grace for retries
const RAZORPAY_PERIOD_MS = 31 * 86400000;
const STRIPE_TOLERANCE_S = 300;

export function effectivePlan(user, nowMs) {
  if (!user || !user.plan || user.plan === 'free') return 'free';
  if (user.plan_expires_at && user.plan_expires_at < nowMs) return 'free';
  return user.plan;
}

export const paidPlans = (plans) => Object.entries(plans).filter(([, p]) => p.price.USD > 0 || p.price.INR > 0);

export function billingConfigured(env, currency) {
  const stripe = Boolean(env.STRIPE_SECRET_KEY);
  const razorpay = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  return currency === 'INR' ? razorpay || stripe : stripe;
}

/** Create a hosted checkout and return its URL (or throw). */
export async function createCheckout({ app, user, planKey, currency, baseUrl }) {
  const { env } = app.config;
  const plan = app.config.plans[planKey];
  if (!plan || !(plan.price[currency] > 0)) throw new Error('Unknown plan');
  const amountMinor = Math.round(plan.price[currency] * 100);
  const doFetch = app.fetch;

  if (currency === 'INR' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await doFetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: amountMinor,
        currency: 'INR',
        description: `${app.config.name} ${plan.label} - 1 month`,
        reference_id: `${app.config.slug}-${user.id}-${planKey}-${app.now()}`,
        customer: { email: user.email },
        notify: { email: true },
        callback_url: `${baseUrl}/billing?paid=1`,
        callback_method: 'get',
        notes: { app: app.config.slug, user_id: String(user.id), plan: planKey },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.short_url) throw new Error(`Razorpay error: ${data?.error?.description ?? res.status}`);
    return data.short_url;
  }

  if (env.STRIPE_SECRET_KEY) {
    const p = new URLSearchParams({
      mode: 'subscription',
      success_url: `${baseUrl}/billing?paid=1`,
      cancel_url: `${baseUrl}/billing`,
      client_reference_id: String(user.id),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(amountMinor),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': `${app.config.name} ${plan.label}`,
      'metadata[app]': app.config.slug,
      'metadata[user_id]': String(user.id),
      'metadata[plan]': planKey,
    });
    if (user.stripe_customer_id) p.set('customer', user.stripe_customer_id);
    else p.set('customer_email', user.email);
    const res = await doFetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: p.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(`Stripe error: ${data?.error?.message ?? res.status}`);
    return data.url;
  }

  throw new Error('Payments are not configured');
}

export function verifyStripeSignature(rawBody, header, secret, nowMs) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((kv) => kv.split('=').map((s) => s.trim()))
      .filter((kv) => kv.length === 2),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > STRIPE_TOLERANCE_S) return false;
  const expected = hmacHex(secret, `${t}.${rawBody.toString('utf8')}`);
  return String(header)
    .split(',')
    .map((kv) => kv.trim())
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => safeEqual(kv.slice(3), expected));
}

export function verifyRazorpaySignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  return safeEqual(hmacHex(secret, rawBody.toString('utf8')), header);
}

function once(db, id, provider, type, nowMs) {
  return db.run('INSERT OR IGNORE INTO billing_events (id, provider, type, created_at) VALUES (?, ?, ?, ?)', id, provider, type, nowMs).changes === 1;
}

function activate(db, userId, planKey, until, extra = {}) {
  db.run(
    `UPDATE users SET plan = ?, plan_expires_at = ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?`,
    planKey,
    until,
    extra.stripeCustomer ?? null,
    userId,
  );
}

/** Returns { status, message }. Never throws on bad input. */
export function handleStripeWebhook(app, rawBody, signature) {
  const { env, plans, slug } = app.config;
  const nowMs = app.now();
  if (!verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET, nowMs)) {
    return { status: 400, message: 'bad signature' };
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, message: 'bad json' };
  }
  const obj = event?.data?.object ?? {};
  const db = app.db;
  if (!event.id || !once(db, event.id, 'stripe', event.type, nowMs)) return { status: 200, message: 'duplicate or ignored' };

  if (event.type === 'checkout.session.completed') {
    const meta = obj.metadata ?? {};
    if (meta.app !== slug) return { status: 200, message: 'other app' };
    const userId = Number(obj.client_reference_id ?? meta.user_id);
    if (!plans[meta.plan] || !userId || obj.payment_status === 'unpaid') return { status: 200, message: 'ignored' };
    activate(db, userId, meta.plan, nowMs + STRIPE_PERIOD_MS, { stripeCustomer: obj.customer });
  } else if (event.type === 'invoice.paid' && obj.customer) {
    db.run(`UPDATE users SET plan_expires_at = ? WHERE stripe_customer_id = ? AND plan != 'free'`, nowMs + STRIPE_PERIOD_MS, obj.customer);
  } else if (event.type === 'customer.subscription.deleted' && obj.customer) {
    db.run(`UPDATE users SET plan_expires_at = ? WHERE stripe_customer_id = ?`, nowMs, obj.customer);
  }
  return { status: 200, message: 'ok' };
}

export function handleRazorpayWebhook(app, rawBody, signature, eventId) {
  const { env, plans, slug } = app.config;
  const nowMs = app.now();
  if (!verifyRazorpaySignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    return { status: 400, message: 'bad signature' };
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, message: 'bad json' };
  }
  const db = app.db;
  const id = eventId || event?.payload?.payment?.entity?.id;
  if (!id || !once(db, `rzp_${id}`, 'razorpay', event.event, nowMs)) return { status: 200, message: 'duplicate or ignored' };

  if (event.event === 'payment_link.paid') {
    const link = event.payload?.payment_link?.entity ?? {};
    const notes = link.notes ?? {};
    const plan = plans[notes.plan];
    const userId = Number(notes.user_id);
    // Defence in depth: the paid amount must match the plan's INR price.
    if (notes.app !== slug || !plan || !userId || link.amount_paid !== Math.round(plan.price.INR * 100)) {
      return { status: 200, message: 'ignored' };
    }
    const user = db.get('SELECT plan, plan_expires_at FROM users WHERE id = ?', userId);
    if (!user) return { status: 200, message: 'ignored' };
    const base = user.plan === notes.plan && user.plan_expires_at > nowMs ? user.plan_expires_at : nowMs;
    activate(db, userId, notes.plan, base + RAZORPAY_PERIOD_MS);
  }
  return { status: 200, message: 'ok' };
}
