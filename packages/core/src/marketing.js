import { html } from './html.js';
import { layout } from './ui.js';
import { formatMajor } from './money.js';

function limitList(app, plan) {
  const labels = app.config.limitLabels;
  return Object.entries(plan.limits ?? {}).map(([k, v]) => {
    const label = labels[k] ?? k;
    return `${Number.isFinite(v) ? v.toLocaleString('en-US') : 'Unlimited'} ${label}`;
  });
}

export function pricingCards(app, { cta = '/signup' } = {}) {
  const { plans } = app.config;
  return html`<div class="pricing">${Object.entries(plans).map(
    ([key, plan]) => html`<div class="price-card ${plan.featured ? 'featured' : ''}">
      ${plan.featured ? html`<span class="ribbon">Most popular</span>` : ''}
      <h3>${plan.label}</h3>
      <div class="price">
        <span data-show="INR">${plan.price.INR ? formatMajor(plan.price.INR, 'INR') : 'Free'}</span>
        <span data-show="USD">${plan.price.USD ? formatMajor(plan.price.USD, 'USD') : 'Free'}</span>
        ${plan.price.USD ? html`<small>/month</small>` : ''}
      </div>
      <p class="muted">${plan.blurb ?? ''}</p>
      <ul>${[...limitList(app, plan), ...(plan.features ?? [])].map((f) => html`<li>${f}</li>`)}</ul>
      <a class="btn ${plan.featured ? 'btn-primary' : ''}" href="${cta}?plan=${key}">${plan.price.USD ? `Start with ${plan.label}` : 'Start free'}</a>
    </div>`,
  )}</div>`;
}

export function landingPage(ctx) {
  const { config } = ctx.app;
  const m = config.marketing;
  const body = html`
  <section class="hero">
    <p class="eyebrow">${m.audience ?? ''}</p>
    <h1>${m.headline ?? config.tagline}</h1>
    <p class="lead">${m.sub ?? ''}</p>
    <div class="hero-cta">
      <a class="btn btn-primary btn-lg" href="/signup">Start free — no card needed</a>
      <a class="btn btn-lg" href="#pricing">See pricing</a>
    </div>
  </section>
  <section class="features">${(m.points ?? []).map(
    (p) => html`<div class="feature"><h3>${p.title}</h3><p class="muted">${p.body}</p></div>`,
  )}</section>
  ${m.steps?.length
    ? html`<section class="how"><h2>How it works</h2><ol class="steps">${m.steps.map(
        (s) => html`<li><strong>${s.title}</strong><span class="muted">${s.body}</span></li>`,
      )}</ol></section>`
    : ''}
  <section id="pricing" class="pricing-section">
    <div class="pricing-head">
      <h2>Simple pricing</h2>
      <div class="cur-toggle" role="group" aria-label="Currency">
        <button type="button" data-cur-btn="INR">₹ INR</button><button type="button" data-cur-btn="USD">$ USD</button>
      </div>
    </div>
    ${pricingCards(ctx.app)}
  </section>
  ${m.faq?.length
    ? html`<section class="faq"><h2>Questions</h2>${m.faq.map(
        (f) => html`<details><summary>${f.q}</summary><p class="muted">${f.a}</p></details>`,
      )}</section>`
    : ''}`;
  return layout(ctx, { title: config.name, body, description: m.sub, noindex: false });
}

export function legalPage(ctx, kind) {
  const { config } = ctx.app;
  const entity = config.env.LEGAL_ENTITY || config.name;
  const contact = config.env.SUPPORT_EMAIL || 'the support address on this site';
  const body =
    kind === 'privacy'
      ? html`<article class="prose"><h1>Privacy</h1>
        <p class="muted">Plain-language summary. Replace with a reviewed policy before launch.</p>
        <p>${entity} stores the account details and business records you enter into ${config.name} so the product can work for you. We do not sell your data.</p>
        <p>Records about your own customers (leads, invoices, quotes, contacts) belong to you; you are responsible for having a lawful basis to contact them. Emails sent through the product go to the recipients you choose.</p>
        <p>You can delete your account and all associated data at any time from the Account page. For questions or data requests contact ${contact}.</p></article>`
      : html`<article class="prose"><h1>Terms</h1>
        <p class="muted">Plain-language summary. Replace with reviewed terms before launch.</p>
        <p>${config.name} is provided by ${entity} as-is. You are responsible for the accuracy of the data you enter and for how you use messages the product sends on your behalf (no spam, no unlawful use).</p>
        <p>Paid plans renew monthly until cancelled. Contact ${contact} for billing questions.</p></article>`;
  return layout(ctx, { title: kind === 'privacy' ? 'Privacy' : 'Terms', body, noindex: false });
}
