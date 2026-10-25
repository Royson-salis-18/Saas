import {
  CURRENCIES,
  HttpError,
  badge,
  card,
  ring,
  vbars,
  clean,
  createApp,
  csrfField,
  download,
  emptyState,
  field,
  formatDate,
  formatMoney,
  html,
  isEmail,
  isISODate,
  addDays,
  pageHeader,
  parseAmount,
  randomToken,
  raw,
  redirect,
  safeUrl,
  statGrid,
  table,
  toArray,
  toCsv,
  todayIn,
  toMinor,
} from '@saas/core';
import { TAX_MODES, computeTotals, effectiveStatus, formatQuoteNumber, needsFollowUp, parseItems, pipelineStats } from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    parent_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    customer_address TEXT NOT NULL DEFAULT '',
    customer_tax_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    tax_mode TEXT NOT NULL DEFAULT 'none',
    tax_rate REAL NOT NULL DEFAULT 0,
    discount_type TEXT NOT NULL DEFAULT 'percent',
    discount_value REAL NOT NULL DEFAULT 0,
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    tax_total INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '',
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    token TEXT NOT NULL UNIQUE,
    sent_at INTEGER,
    viewed_at INTEGER,
    responded_at INTEGER,
    response_name TEXT,
    response_comment TEXT,
    followed_up_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, number)
  );
  CREATE INDEX quotes_user_status ON quotes (user_id, status);
  CREATE INDEX quotes_user_created ON quotes (user_id, created_at);
  CREATE TABLE quote_items (
    id INTEGER PRIMARY KEY,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '',
    unit_price INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX quote_items_quote ON quote_items (quote_id, position);
  `,
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { quotes: 5, emails: 10 }, blurb: 'Send your first professional quotes.', features: ['Shareable accept/decline link', '“Made with QuoteForge” footer'] },
  starter: { label: 'Starter', price: { INR: 999, USD: 39 }, limits: { quotes: 50, emails: 100 }, blurb: 'For solo contractors and consultants.', features: ['Your branding only', 'CSV export'] },
  pro: { label: 'Pro', price: { INR: 2499, USD: 79 }, limits: { quotes: 300, emails: 600 }, featured: true, blurb: 'For busy service businesses.', features: ['Automatic follow-ups', 'Priority support'] },
  business: { label: 'Business', price: { INR: 4999, USD: 149 }, limits: { quotes: 2000, emails: 3000 }, blurb: 'For teams quoting every day.', features: ['Everything in Pro', 'Onboarding call'] },
};

const STATUS_TONE = { draft: 'neutral', sent: 'info', viewed: 'warn', accepted: 'good', declined: 'bad', expired: 'bad', revised: 'neutral' };
const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', viewed: 'Viewed', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', revised: 'Superseded' };
const MONTH = 31 * 86400000;

/** Client-side live totals for the quote editor (display only; the server recomputes everything). */
const QUOTE_JS = `(function () {
  var form = document.querySelector('[data-quote-form]');
  if (!form) return;
  var cur = form.getAttribute('data-currency');
  var locale = cur === 'INR' ? 'en-IN' : 'en-US';
  function fmt(n) { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).format(n); } catch (e) { return n.toFixed(2); } }
  function num(v) { var x = parseFloat(String(v).replace(/[^0-9.\\-]/g, '')); return isFinite(x) ? x : 0; }
  function val(name) { var el = form.querySelector('[name="' + name + '"]'); return el ? el.value : ''; }
  function set(id, n) { var el = document.getElementById(id); if (el) el.textContent = fmt(n); }
  function calc() {
    var sub = 0;
    form.querySelectorAll('[data-repeater-row]').forEach(function (row) {
      var q = num(row.querySelector('[name="qty[]"]').value || 1);
      var p = num(row.querySelector('[name="price[]"]').value);
      var line = Math.round(q * p * 100) / 100;
      sub += line;
      var t = row.querySelector('[data-line-total]');
      if (t) t.textContent = line ? fmt(line) : '';
    });
    var dv = num(val('discount_value'));
    var disc = val('discount_type') === 'percent' ? sub * Math.min(100, dv) / 100 : Math.min(dv, sub);
    disc = Math.round(disc * 100) / 100;
    var taxable = sub - disc;
    var mode = val('tax_mode');
    var tax = mode === 'none' ? 0 : Math.round(taxable * num(val('tax_rate'))) / 100;
    set('t-sub', sub); set('t-disc', -disc); set('t-tax', tax); set('t-total', taxable + tax);
  }
  form.addEventListener('input', calc);
  form.addEventListener('change', calc);
  calc();
})();`;

const hourIn = (tz, ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms));

export function createQuoteForge(options = {}) {
  const app = createApp({
    slug: 'quoteforge',
    name: 'QuoteForge',
    tagline: 'Send quotes clients can accept in one click',
    accent: '#fb923c',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/quotes', label: 'Quotes' },
      { href: '/settings', label: 'Business settings' },
    ],
    plans: PLANS,
    limitLabels: { quotes: 'new quotes / month', emails: 'quote emails / month' },
    migrations: MIGRATIONS,
    settingsDefaults: {
      business_name: '', address: '', tax_id: '', phone: '', email: '', logo_url: '',
      default_terms: '', default_notes: '', tax_mode: '', tax_rate: '', quote_prefix: 'Q-', quote_counter: 0,
      validity_days: 14, followup_days: 3, auto_followup: false,
    },
    usage: (db, user) => ({
      quotes: db.get('SELECT COUNT(*) AS n FROM quotes WHERE user_id = ? AND created_at > ?', user.id, app.now() - MONTH).n,
      emails: app.mailer.sentThisMonth(user.id),
    }),
    marketing: {
      preview: { chartTitle: 'Quotes by status', ringTitle: 'Win rate, 90 days', bars: [{ label: 'Draft', value: 6 }, { label: 'Sent', value: 14 }, { label: 'Viewed', value: 9 }, { label: 'Accepted', value: 21 }, { label: 'Declined', value: 7 }, { label: 'Expired', value: 4 }], ring: { value: 62, text: '62%', label: 'won', note: '21 won · 11 lost or expired' }, kpis: [{ label: 'Open pipeline', value: '₹9.4L', delta: '23 quotes' }, { label: 'Accepted this month', value: '₹6.1L', delta: '+18%', deltaTone: 'good' }, { label: 'Need a follow-up', value: '5', delta: 'unanswered 3d+', deltaTone: 'warn' }] },
      audience: 'For contractors, consultants and service businesses',
      headline: 'Win more jobs with quotes that look professional and close faster.',
      sub: 'Build a branded quote in minutes, send one link, and let your client accept or decline in a click. GST and sales tax handled. You see who opened it — and who needs a nudge.',
      points: [
        { title: 'Quotes that look the part', body: 'Your logo, your terms, clean line items — printable as a PDF straight from the browser.' },
        { title: 'GST / VAT / sales tax built in', body: 'CGST + SGST or IGST for India, sales tax or VAT elsewhere. Totals are exact to the paisa and the cent.' },
        { title: 'One-click acceptance', body: 'Clients accept or decline on a secure link. You get an email the moment they respond.' },
        { title: 'Never lose a quote to silence', body: 'See which quotes are unopened, viewed or stale, and send a polite follow-up in one click (or automatically).' },
      ],
      steps: [
        { title: 'Add your business details once', body: 'Logo, address, GSTIN / tax ID, default terms and tax rate.' },
        { title: 'Build and send the quote', body: 'Line items, discount, tax, validity date — then email the link.' },
        { title: 'Track and win', body: 'Viewed, accepted, declined — with revision history when the scope changes.' },
      ],
      faq: [
        { q: 'Can clients download a PDF?', a: 'Yes. The quote page has a Print / Save as PDF button that produces a clean, print-ready document.' },
        { q: 'What if the scope changes?', a: 'Create a revision. The old link clearly shows it has been superseded and points to the new version.' },
        { q: 'Is the client link secure?', a: 'Each quote has a long random link. Only people with the link can view it, and drafts are never public.' },
      ],
    },
    ...options,
  });

  const { db } = app;
  app.addStatic('quoteforge.js', QUOTE_JS);
  const SCRIPTS = ['/static/quoteforge.js'];

  // ---- helpers ------------------------------------------------------------
  const getQuote = (ctx, id) => {
    const q = db.get('SELECT * FROM quotes WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!q) throw new HttpError(404, 'Quote not found');
    return q;
  };
  const itemsOf = (id) => db.all('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position', id);
  const totalsOf = (q, items) =>
    computeTotals(items, {
      discountType: q.discount_type,
      discountValue: q.discount_type === 'percent' ? q.discount_value : toMinor(q.discount_value),
      taxMode: q.tax_mode,
      taxRate: q.tax_rate,
    });
  const ownerSettings = (owner) => {
    try {
      return { ...app.config.settingsDefaults, ...JSON.parse(owner.settings || '{}') };
    } catch {
      return { ...app.config.settingsDefaults };
    }
  };
  const quoteUrl = (q) => app.publicUrl(`/q/${q.token}`);
  const taxDefaults = (ctx) => {
    const s = ctx.settings;
    if (s.tax_mode) return { mode: s.tax_mode, rate: s.tax_rate === '' ? 0 : Number(s.tax_rate) };
    return ctx.user.currency === 'INR' ? { mode: 'gst_intra', rate: 18 } : { mode: 'none', rate: 0 };
  };

  function allocateNumber(ctx) {
    return db.tx(() => {
      const row = db.get('SELECT settings FROM users WHERE id = ?', ctx.user.id);
      const s = { ...app.config.settingsDefaults, ...JSON.parse(row.settings || '{}') };
      const n = (Number(s.quote_counter) || 0) + 1;
      s.quote_counter = n;
      db.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), ctx.user.id);
      ctx.settings = { ...ctx.settings, quote_counter: n };
      return { n, prefix: s.quote_prefix || 'Q-' };
    });
  }

  function writeItems(quoteId, items) {
    db.run('DELETE FROM quote_items WHERE quote_id = ?', quoteId);
    items.forEach((it, i) => db.run('INSERT INTO quote_items (quote_id, position, description, qty, unit, unit_price) VALUES (?, ?, ?, ?, ?, ?)', quoteId, i, it.description, it.qty, it.unit, it.unit_price));
  }

  function recompute(quoteId) {
    const q = db.get('SELECT * FROM quotes WHERE id = ?', quoteId);
    const t = totalsOf(q, itemsOf(quoteId));
    db.run('UPDATE quotes SET subtotal = ?, discount = ?, tax_total = ?, total = ?, updated_at = ? WHERE id = ?', t.subtotal, t.discount, t.taxTotal, t.total, app.now(), quoteId);
  }

  function readQuoteForm(ctx) {
    const b = ctx.body;
    const parsed = parseItems(b, toArray);
    const dtype = b.discount_type === 'amount' ? 'amount' : 'percent';
    const dval = b.discount_value === '' || b.discount_value === undefined ? 0 : parseAmount(b.discount_value);
    const taxMode = TAX_MODES.some(([k]) => k === b.tax_mode) ? b.tax_mode : 'none';
    const taxRate = b.tax_rate === '' || b.tax_rate === undefined ? 0 : parseAmount(b.tax_rate);
    const email = String(b.customer_email ?? '').trim().toLowerCase();
    const valid = String(b.valid_until ?? '').trim();
    const v = {
      customer_name: clean(b.customer_name, 120), customer_email: email, customer_phone: clean(b.customer_phone, 30),
      customer_address: clean(b.customer_address, 300), customer_tax_id: clean(b.customer_tax_id, 40), title: clean(b.title, 150),
      currency: CURRENCIES.includes(b.currency) ? b.currency : ctx.user.currency, tax_mode: taxMode, tax_rate: Number.isFinite(taxRate) ? Math.min(100, Math.max(0, taxRate)) : 0,
      discount_type: dtype, discount_value: Number.isFinite(dval) ? Math.max(0, dtype === 'percent' ? Math.min(100, dval) : dval) : 0,
      notes: clean(b.notes, 1500), terms: clean(b.terms, 3000), valid_until: valid && isISODate(valid) ? valid : null,
    };
    let error = parsed.error;
    if (!error && !v.customer_name) error = 'Customer name is required.';
    else if (!error && email && !isEmail(email)) error = 'That customer email does not look valid.';
    else if (!error && valid && !isISODate(valid)) error = 'Enter a valid “valid until” date.';
    else if (!error && !Number.isFinite(dval)) error = 'Discount must be a number.';
    return { v, items: parsed.items, error };
  }

  const itemRow = (it = {}) => html`<tr data-repeater-row>
    <td><input type="text" name="desc[]" value="${it.description ?? ''}" placeholder="Description" aria-label="Description"></td>
    <td style="width:6rem"><input type="number" step="any" min="0" name="qty[]" value="${it.qty ?? 1}" aria-label="Quantity"></td>
    <td style="width:6rem"><input type="text" name="unit[]" value="${it.unit ?? ''}" placeholder="hrs, pcs…" aria-label="Unit"></td>
    <td style="width:9rem"><input type="number" step="any" min="0" name="price[]" value="${it.unit_price != null ? it.unit_price / 100 : ''}" aria-label="Unit price"></td>
    <td class="num" style="width:8rem" data-line-total></td>
    <td style="width:2.5rem"><button type="button" class="btn btn-sm" data-repeater-remove aria-label="Remove line">✕</button></td>
  </tr>`;

  function quoteForm(ctx, q, items, error = '') {
    const editing = Boolean(q.id);
    const tax = q.id ? { mode: q.tax_mode, rate: q.tax_rate } : taxDefaults(ctx);
    const rows = items.length ? items : [{}];
    return html`${error ? html`<div class="flash flash-err">${error}</div>` : ''}
    <form method="post" action="${editing ? `/quotes/${q.id}/edit` : '/quotes'}" data-quote-form data-currency="${q.currency}">${csrfField(ctx)}
      ${card('Customer', html`
        <div class="row">
          ${field({ label: 'Customer / company', name: 'customer_name', value: q.customer_name ?? '', required: true })}
          ${field({ label: 'Email', name: 'customer_email', type: 'email', value: q.customer_email ?? '' })}
          ${field({ label: 'Phone', name: 'customer_phone', type: 'tel', value: q.customer_phone ?? '' })}
        </div>
        <div class="row">
          ${field({ label: 'Address', name: 'customer_address', type: 'textarea', rows: 2, value: q.customer_address ?? '' })}
          ${field({ label: ctx.user.currency === 'INR' ? 'Customer GSTIN (optional)' : 'Customer tax ID (optional)', name: 'customer_tax_id', value: q.customer_tax_id ?? '' })}
        </div>`)}
      ${card('Quote', html`
        <div class="row">
          ${field({ label: 'Title', name: 'title', value: q.title ?? '', placeholder: 'Kitchen renovation, website redesign…' })}
          ${field({ label: 'Currency', name: 'currency', type: 'select', options: CURRENCIES, value: q.currency })}
          ${field({ label: 'Valid until', name: 'valid_until', type: 'date', value: q.valid_until ?? '' })}
        </div>
        <div data-repeater class="line-items">
          <div class="table-wrap"><table>
            <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit price</th><th class="num">Amount</th><th></th></tr></thead>
            <tbody data-repeater-rows>${rows.map(itemRow)}</tbody>
          </table></div>
          <template data-repeater-template>${itemRow()}</template>
          <p><button type="button" class="btn btn-sm" data-repeater-add>+ Add line</button></p>
        </div>
        <div class="row">
          ${field({ label: 'Discount', name: 'discount_value', value: q.discount_value || '', attrs: { inputmode: 'decimal' } })}
          ${field({ label: 'Discount type', name: 'discount_type', type: 'select', options: [['percent', 'Percent (%)'], ['amount', `Amount (${q.currency})`]], value: q.discount_type })}
          ${field({ label: 'Tax', name: 'tax_mode', type: 'select', options: TAX_MODES, value: tax.mode })}
          ${field({ label: 'Tax rate (%)', name: 'tax_rate', value: tax.rate, attrs: { inputmode: 'decimal' }, help: 'For GST enter the full rate (e.g. 18); it is split into CGST + SGST automatically.' })}
        </div>
        <div class="totals">
          <div><span>Subtotal</span><span id="t-sub"></span></div>
          <div><span>Discount</span><span id="t-disc"></span></div>
          <div><span>Tax</span><span id="t-tax"></span></div>
          <div class="grand"><span>Total</span><span id="t-total"></span></div>
        </div>`)}
      ${card('Notes & terms', html`
        ${field({ label: 'Notes to the customer', name: 'notes', type: 'textarea', rows: 3, value: q.notes ?? '' })}
        ${field({ label: 'Terms & conditions', name: 'terms', type: 'textarea', rows: 4, value: q.terms ?? '' })}`)}
      <button class="btn btn-primary" type="submit">${editing ? 'Save quote' : 'Create quote'}</button>
    </form>`;
  }

  /** The customer-facing (and owner preview) quote document. */
  function quoteDocument(q, items, owner, { actions = '' } = {}) {
    const s = ownerSettings(owner);
    const t = totalsOf(q, items);
    const business = s.business_name || owner.name;
    const cur = (n) => formatMoney(n, q.currency);
    const logo = safeUrl(s.logo_url).startsWith('http') ? safeUrl(s.logo_url) : '';
    const taxIdLabel = owner.currency === 'INR' ? 'GSTIN' : 'Tax ID';
    const branded = app.planFor(owner) === 'free';
    return html`<div class="card" style="max-width:860px;margin:0 auto">
      <div class="page-header">
        <div>${logo ? html`<img src="${logo}" alt="" style="max-height:56px;max-width:220px;margin-bottom:.5rem">` : ''}
          <h1 style="margin:0">${business}</h1>
          <p class="muted" style="white-space:pre-line">${s.address}${s.tax_id ? `\n${taxIdLabel}: ${s.tax_id}` : ''}${s.phone ? `\n${s.phone}` : ''}${s.email ? `\n${s.email}` : ''}</p></div>
        <div style="text-align:right"><h2 style="margin:0">Quote ${q.number}</h2>
          <p class="muted">Issued ${formatDate(new Date(q.created_at).toISOString().slice(0, 10))}${q.valid_until ? html`<br>Valid until ${formatDate(q.valid_until)}` : ''}</p></div>
      </div>
      <div class="grid-2">
        <div><h3>Prepared for</h3><p style="white-space:pre-line"><strong>${q.customer_name}</strong>${q.customer_address ? `\n${q.customer_address}` : ''}${q.customer_tax_id ? `\n${q.customer_tax_id}` : ''}</p></div>
        <div>${q.title ? html`<h3>Project</h3><p>${q.title}</p>` : ''}</div>
      </div>
      ${table({
        columns: [
          { label: 'Description', render: (i) => i.description },
          { label: 'Qty', align: 'right', render: (i) => html`${i.qty}${i.unit ? ` ${i.unit}` : ''}` },
          { label: 'Unit price', align: 'right', render: (i) => cur(i.unit_price) },
          { label: 'Amount', align: 'right', render: (i) => cur(t.lines[items.indexOf(i)]) },
        ],
        rows: items,
      })}
      <div class="totals" style="margin-top:1rem">
        <div><span>Subtotal</span><span>${cur(t.subtotal)}</span></div>
        ${t.discount ? html`<div><span>Discount${q.discount_type === 'percent' ? ` (${q.discount_value}%)` : ''}</span><span>−${cur(t.discount)}</span></div>` : ''}
        ${t.taxes.map((x) => html`<div><span>${x.label} (${x.rate}%)</span><span>${cur(x.amount)}</span></div>`)}
        <div class="grand"><span>Total</span><span>${cur(t.total)}</span></div>
      </div>
      ${q.notes ? html`<h3>Notes</h3><p style="white-space:pre-line">${q.notes}</p>` : ''}
      ${q.terms ? html`<h3>Terms &amp; conditions</h3><p class="muted" style="white-space:pre-line">${q.terms}</p>` : ''}
      ${actions}
      ${branded ? html`<p class="help center no-print">Made with <a href="/">QuoteForge</a></p>` : ''}
    </div>`;
  }

  const pill = (href, label, active) => html`<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;

  // ---- dashboard ------------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const today = ctx.today();
    const quotes = db.all('SELECT * FROM quotes WHERE user_id = ? ORDER BY id DESC LIMIT 5000', ctx.user.id);
    if (!quotes.length) {
      return ctx.page('Dashboard', html`${pageHeader('Dashboard')}${emptyState('Create your first quote', 'Set your business details once, then build and send a quote in a couple of minutes.', html`<p><a class="btn btn-primary" href="/quotes/new">New quote</a> <a class="btn" href="/settings">Business settings</a></p>`)}`);
    }
    const stats = pipelineStats(quotes, today, ctx.now());
    const follow = quotes.filter((q) => needsFollowUp(q, today, ctx.now(), ctx.settings.followup_days));
    return ctx.page(
      'Dashboard',
      html`${pageHeader('Dashboard', html`<a class="btn btn-primary" href="/quotes/new">New quote</a>`)}
      ${Object.entries(stats).map(([cur, s]) => html`<h2 class="section-title">${cur}</h2>${statGrid([
        { label: 'Open pipeline', value: formatMoney(s.pipeline, cur), hint: `${s.awaiting} awaiting a response` },
        { label: 'Accepted this month', value: formatMoney(s.acceptedMonth, cur), tone: 'good', hint: `${s.acceptedMonthN} quote${s.acceptedMonthN === 1 ? '' : 's'}` },
        { label: 'Win rate (90d)', value: s.rate === null ? '—' : `${s.rate}%`, hint: `${s.won} won · ${s.lost} lost/expired` },
      ])}`)}
      ${Object.entries(stats).slice(0, 1).map(([cur, s]) => html`<div class="viz">${card('Quotes by status', vbars({ height: 170, items: ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'].map((k) => ({ label: STATUS_LABEL[k], value: quotes.filter((q) => q.currency === cur && effectiveStatus(q, today) === k).length, tone: k === 'declined' || k === 'expired' ? 'bad' : '' })) }))}${card('Win rate (90 days)', html`${ring({ value: s.rate ?? 0, max: 100, text: s.rate === null ? '—' : `${s.rate}%`, label: 'won' })}<p class="muted center">${s.won} won · ${s.lost} lost or expired</p>`, { className: 'ring-card' })}</div>`)}
      ${follow.length
        ? card('Needs a follow-up', table({
            columns: [
              { label: 'Quote', render: (q) => html`<a href="/quotes/${q.id}"><strong>${q.number}</strong></a><span class="sub">${q.customer_name}</span>` },
              { label: 'Total', align: 'right', render: (q) => formatMoney(q.total, q.currency) },
              { label: 'Sent', render: (q) => `${Math.floor((ctx.now() - q.sent_at) / 86400000)}d ago · ${q.status === 'viewed' ? 'viewed' : 'not opened'}` },
              { label: '', render: (q) => html`<form method="post" action="/quotes/${q.id}/remind" class="inline">${csrfField(ctx)}<button class="btn btn-sm" type="submit">Send reminder</button></form>` },
            ],
            rows: follow.slice(0, 10),
          }))
        : ''}
      ${card('Recent quotes', quoteTable(ctx, quotes.slice(0, 8), today))}`,
    );
  });

  function quoteTable(ctx, rows, today) {
    return table({
      columns: [
        { label: 'Quote', render: (q) => html`<a href="/quotes/${q.id}"><strong>${q.number}</strong></a>${q.title ? html`<span class="sub">${q.title}</span>` : ''}` },
        { label: 'Customer', render: (q) => q.customer_name },
        { label: 'Total', align: 'right', render: (q) => formatMoney(q.total, q.currency) },
        { label: 'Status', render: (q) => { const st = effectiveStatus(q, today); return badge(STATUS_LABEL[st], STATUS_TONE[st]); } },
        { label: 'Valid until', render: (q) => (q.valid_until ? formatDate(q.valid_until) : '—') },
      ],
      rows,
      empty: 'No quotes yet.',
    });
  }

  // ---- list / create ----------------------------------------------------------
  const FILTERS = [['all', 'All'], ['draft', 'Drafts'], ['open', 'Awaiting'], ['accepted', 'Accepted'], ['lost', 'Declined / expired']];
  app.get('/quotes', (ctx) => {
    const today = ctx.today();
    const filter = FILTERS.some(([k]) => k === ctx.query.filter) ? ctx.query.filter : 'all';
    const q = clean(ctx.query.q, 80).toLowerCase();
    const rows = db
      .all('SELECT * FROM quotes WHERE user_id = ? ORDER BY id DESC LIMIT 5000', ctx.user.id)
      .filter((x) => {
        const st = effectiveStatus(x, today);
        if (filter === 'draft' && st !== 'draft') return false;
        if (filter === 'open' && !['sent', 'viewed'].includes(st)) return false;
        if (filter === 'accepted' && st !== 'accepted') return false;
        if (filter === 'lost' && !['declined', 'expired'].includes(st)) return false;
        return !q || [x.number, x.customer_name, x.title].some((v) => v.toLowerCase().includes(q));
      });
    return ctx.page(
      'Quotes',
      html`${pageHeader('Quotes', html`<a class="btn" href="/quotes.csv">Export CSV</a><a class="btn btn-primary" href="/quotes/new">New quote</a>`)}
      <div class="pill-row">${FILTERS.map(([k, l]) => pill(`/quotes?filter=${k}`, l, k === filter))}</div>
      <form method="get" action="/quotes" class="inline-form" style="margin-bottom:1rem"><input type="hidden" name="filter" value="${filter}"><input type="text" name="q" value="${q}" placeholder="Search number, customer, title"><button class="btn" type="submit">Search</button></form>
      ${card('', quoteTable(ctx, rows.slice(0, 300), today))}
      ${rows.length > 300 ? html`<p class="muted">Showing the 300 most recent. Use search to narrow down.</p>` : ''}`,
    );
  });

  app.get('/quotes.csv', (ctx) => {
    const today = ctx.today();
    const rows = db.all('SELECT * FROM quotes WHERE user_id = ? ORDER BY id', ctx.user.id);
    return download('quotes.csv', toCsv(rows, [
      { key: 'number', label: 'number' }, { key: 'customer_name', label: 'customer' }, { key: 'title', label: 'title' },
      { label: 'status', value: (r) => effectiveStatus(r, today) }, { key: 'currency', label: 'currency' }, { label: 'subtotal', value: (r) => r.subtotal / 100 },
      { label: 'tax', value: (r) => r.tax_total / 100 }, { label: 'total', value: (r) => r.total / 100 }, { key: 'valid_until', label: 'valid_until' },
    ]));
  });

  app.get('/quotes/new', (ctx) => {
    const draft = { currency: ctx.user.currency, discount_type: 'percent', discount_value: 0, valid_until: addDays(ctx.today(), Number(ctx.settings.validity_days) || 14), notes: ctx.settings.default_notes, terms: ctx.settings.default_terms };
    return ctx.page('New quote', html`${pageHeader('New quote')}${quoteForm(ctx, draft, [])}`, { scripts: SCRIPTS });
  });

  app.post('/quotes', (ctx) => {
    const { v, items, error } = readQuoteForm(ctx);
    if (error) {
      return ctx.page('New quote', html`${pageHeader('New quote')}${quoteForm(ctx, { ...v, discount_type: v.discount_type }, items.length ? items : [], error)}`, { status: 400, scripts: SCRIPTS });
    }
    const used = db.get('SELECT COUNT(*) AS n FROM quotes WHERE user_id = ? AND created_at > ?', ctx.user.id, ctx.now() - MONTH).n;
    const limitMsg = ctx.checkLimit('quotes', used);
    if (limitMsg) return redirect('/quotes', { err: limitMsg });
    const { n, prefix } = allocateNumber(ctx);
    const id = db.tx(() => {
      const qid = db.run(
        `INSERT INTO quotes (user_id, number, customer_name, customer_email, customer_phone, customer_address, customer_tax_id, title, currency, tax_mode, tax_rate,
           discount_type, discount_value, notes, terms, valid_until, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.user.id, formatQuoteNumber(prefix, n), v.customer_name, v.customer_email, v.customer_phone, v.customer_address, v.customer_tax_id, v.title, v.currency, v.tax_mode, v.tax_rate,
        v.discount_type, v.discount_value, v.notes, v.terms, v.valid_until, randomToken(18), ctx.now(), ctx.now(),
      ).id;
      writeItems(qid, items);
      recompute(qid);
      return qid;
    });
    return redirect(`/quotes/${id}`, { ok: 'Quote created.' });
  });

  // ---- detail / actions ---------------------------------------------------------
  app.get('/quotes/:id', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    const items = itemsOf(q.id);
    const today = ctx.today();
    const st = effectiveStatus(q, today);
    const act = (path, label, cls = 'btn', extra = '') => html`<form method="post" action="/quotes/${q.id}/${path}" class="inline" ${raw(extra)}>${csrfField(ctx)}<button class="${cls}" type="submit">${label}</button></form>`;
    const shareable = q.status !== 'draft';
    const actions = [];
    if (q.status === 'draft') actions.push(isEmail(q.customer_email) ? act('send', 'Email to customer', 'btn btn-primary') : '', act('share', 'Mark as sent (I’ll share the link)', 'btn'));
    if (['sent', 'viewed'].includes(q.status)) actions.push(act('remind', 'Send reminder'), act('extend', 'Extend 14 days'), act('status', 'Mark accepted', 'btn btn-sm', ''), act('revise', 'Revise'));
    if (['accepted', 'declined'].includes(q.status) || st === 'expired') actions.push(act('revise', 'Revise as new version'));
    const parent = q.parent_id ? db.get('SELECT id, number FROM quotes WHERE id = ? AND user_id = ?', q.parent_id, ctx.user.id) : null;
    const child = db.get('SELECT id, number FROM quotes WHERE parent_id = ? AND user_id = ?', q.id, ctx.user.id);
    return ctx.page(
      `Quote ${q.number}`,
      html`${pageHeader(
        html`Quote ${q.number} ${badge(STATUS_LABEL[st], STATUS_TONE[st])}`,
        html`<a class="btn" href="/quotes/${q.id}/preview" target="_blank" rel="noopener">Preview</a>${actions}`,
        `${q.customer_name} · ${formatMoney(q.total, q.currency)}${q.valid_until ? ` · valid until ${formatDate(q.valid_until)}` : ''}`,
      )}
      ${parent ? html`<p class="muted">Revision of <a href="/quotes/${parent.id}">${parent.number}</a>.</p>` : ''}
      ${child ? html`<div class="flash flash-err">This quote was superseded by <a href="/quotes/${child.id}">${child.number}</a>.</div>` : ''}
      ${q.status === 'accepted' ? html`<div class="flash flash-ok">Accepted by ${q.response_name}${q.response_comment ? ` — “${q.response_comment}”` : ''}.</div>` : ''}
      ${q.status === 'declined' ? html`<div class="flash flash-err">Declined${q.response_name ? ` by ${q.response_name}` : ''}${q.response_comment ? ` — “${q.response_comment}”` : ''}.</div>` : ''}
      ${shareable ? card('Customer link', html`<div class="copy-box mono" id="qurl">${quoteUrl(q)}</div><p><button class="btn btn-sm" type="button" data-copy="#qurl">Copy link</button>
          ${q.customer_phone ? html` <a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/${q.customer_phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${q.customer_name}, here is your quote ${q.number}: ${quoteUrl(q)}`)}">Share on WhatsApp</a>` : ''}</p>
          <p class="help">${q.viewed_at ? `First viewed ${new Date(q.viewed_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'Not opened yet.'}</p>`) : ''}
      ${q.status === 'draft' ? quoteForm(ctx, q, items) : quoteDocument(q, items, ctx.user)}
      ${['draft', 'declined', 'expired'].includes(q.status) || st === 'expired' ? act('delete', 'Delete quote', 'btn btn-danger', 'data-confirm="Delete this quote permanently?"') : ''}
      ${act('duplicate', 'Duplicate as new quote', 'btn btn-sm')}`,
      { scripts: q.status === 'draft' ? SCRIPTS : [] },
    );
  });

  app.get('/quotes/:id/preview', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    return ctx.page(`Quote ${q.number}`, html`<p class="no-print"><button class="btn" type="button" data-print>Print / Save as PDF</button></p>${quoteDocument(q, itemsOf(q.id), ctx.user)}`);
  });

  app.post('/quotes/:id/edit', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (q.status !== 'draft') return redirect(`/quotes/${q.id}`, { err: 'Only drafts can be edited. Create a revision instead.' });
    const { v, items, error } = readQuoteForm(ctx);
    if (error) return redirect(`/quotes/${q.id}`, { err: error });
    db.tx(() => {
      db.run(
        `UPDATE quotes SET customer_name = ?, customer_email = ?, customer_phone = ?, customer_address = ?, customer_tax_id = ?, title = ?, currency = ?, tax_mode = ?, tax_rate = ?,
         discount_type = ?, discount_value = ?, notes = ?, terms = ?, valid_until = ? WHERE id = ?`,
        v.customer_name, v.customer_email, v.customer_phone, v.customer_address, v.customer_tax_id, v.title, v.currency, v.tax_mode, v.tax_rate, v.discount_type, v.discount_value, v.notes, v.terms, v.valid_until, q.id,
      );
      writeItems(q.id, items);
      recompute(q.id);
    });
    return redirect(`/quotes/${q.id}`, { ok: 'Saved.' });
  });

  async function emailQuote(ctx, q, { reminder = false } = {}) {
    if (!isEmail(q.customer_email)) return { ok: false, error: 'Add a valid customer email first.' };
    if (app.mailer.sentThisMonth(ctx.user.id) >= ctx.limit('emails')) return { ok: false, error: 'Monthly email limit reached. Upgrade on the Billing page, or copy the link and share it yourself.' };
    const business = ctx.settings.business_name || ctx.user.name;
    const subject = reminder ? `Following up on quote ${q.number}` : `Quote ${q.number} from ${business}`;
    const body = reminder
      ? `Hi ${q.customer_name},\n\nI wanted to check whether you had a chance to look at quote ${q.number} (${formatMoney(q.total, q.currency)}).${q.valid_until ? ` It is valid until ${formatDate(q.valid_until)}.` : ''}\n\nYou can review and accept it here:\n${quoteUrl(q)}\n\nHappy to adjust anything — just reply to this email.\n\n${business}`
      : `Hi ${q.customer_name},\n\nThank you for the opportunity. Your quote ${q.number}${q.title ? ` for “${q.title}”` : ''} (${formatMoney(q.total, q.currency)}) is ready.${q.valid_until ? ` It is valid until ${formatDate(q.valid_until)}.` : ''}\n\nYou can review and accept it online here:\n${quoteUrl(q)}\n\nReply to this email if you would like anything changed.\n\n${business}`;
    return app.mailer.send({
      userId: ctx.user.id, to: q.customer_email, subject, text: body,
      replyTo: isEmail(ctx.settings.email) ? ctx.settings.email : ctx.user.email, fromName: business,
    });
  }

  app.post('/quotes/:id/send', async (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (q.status !== 'draft') return redirect(`/quotes/${q.id}`, { err: 'This quote has already been sent.' });
    const r = await emailQuote(ctx, q);
    if (!r.ok) return redirect(`/quotes/${q.id}`, { err: r.error });
    db.run(`UPDATE quotes SET status = 'sent', sent_at = ? WHERE id = ?`, ctx.now(), q.id);
    return redirect(`/quotes/${q.id}`, { ok: `Quote emailed to ${q.customer_email}.` });
  });

  app.post('/quotes/:id/share', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (q.status === 'draft') db.run(`UPDATE quotes SET status = 'sent', sent_at = ? WHERE id = ?`, ctx.now(), q.id);
    return redirect(`/quotes/${q.id}`, { ok: 'Marked as sent. Copy the link below to share it.' });
  });

  app.post('/quotes/:id/remind', async (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (!['sent', 'viewed'].includes(q.status)) return redirect(`/quotes/${q.id}`, { err: 'Only open quotes can be chased.' });
    const r = await emailQuote(ctx, q, { reminder: true });
    if (!r.ok) return redirect(`/quotes/${q.id}`, { err: r.error });
    db.run('UPDATE quotes SET followed_up_at = ? WHERE id = ?', ctx.now(), q.id);
    return redirect(ctx.req.headers.referer?.includes('/dashboard') ? '/dashboard' : `/quotes/${q.id}`, { ok: `Reminder sent to ${q.customer_email}.` });
  });

  app.post('/quotes/:id/extend', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    const base = q.valid_until && q.valid_until > ctx.today() ? q.valid_until : ctx.today();
    db.run('UPDATE quotes SET valid_until = ? WHERE id = ?', addDays(base, 14), q.id);
    return redirect(`/quotes/${q.id}`, { ok: 'Validity extended by 14 days.' });
  });

  app.post('/quotes/:id/status', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    db.run(`UPDATE quotes SET status = 'accepted', responded_at = ?, response_name = COALESCE(response_name, ?) WHERE id = ? AND status IN ('sent','viewed')`, ctx.now(), '(recorded by you)', q.id);
    return redirect(`/quotes/${q.id}`, { ok: 'Marked accepted.' });
  });

  function copyQuote(ctx, q, { revision }) {
    const { n, prefix } = revision ? { n: null, prefix: null } : allocateNumber(ctx);
    return db.tx(() => {
      const rev = revision ? q.revision + 1 : 1;
      const baseNumber = revision ? q.number.replace(/-R\d+$/, '') : formatQuoteNumber(prefix, n);
      const number = revision ? `${baseNumber}-R${rev}` : baseNumber;
      const qid = db.run(
        `INSERT INTO quotes (user_id, number, revision, parent_id, customer_name, customer_email, customer_phone, customer_address, customer_tax_id, title, currency, tax_mode, tax_rate,
           discount_type, discount_value, notes, terms, valid_until, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.user.id, number, rev, revision ? q.id : null, q.customer_name, q.customer_email, q.customer_phone, q.customer_address, q.customer_tax_id, q.title, q.currency, q.tax_mode, q.tax_rate,
        q.discount_type, q.discount_value, q.notes, q.terms, addDays(ctx.today(), Number(ctx.settings.validity_days) || 14), randomToken(18), ctx.now(), ctx.now(),
      ).id;
      writeItems(qid, itemsOf(q.id).map((i) => ({ description: i.description, qty: i.qty, unit: i.unit, unit_price: i.unit_price })));
      recompute(qid);
      return qid;
    });
  }

  app.post('/quotes/:id/revise', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (q.status === 'draft') return redirect(`/quotes/${q.id}`, { err: 'Drafts can be edited directly.' });
    if (db.get('SELECT 1 AS x FROM quotes WHERE parent_id = ?', q.id)) return redirect(`/quotes/${q.id}`, { err: 'A revision already exists.' });
    const id = copyQuote(ctx, q, { revision: true });
    db.run(`UPDATE quotes SET status = 'revised' WHERE id = ? AND status IN ('sent','viewed')`, q.id);
    return redirect(`/quotes/${id}`, { ok: 'Revision created. Edit it, then send it to replace the old quote.' });
  });

  app.post('/quotes/:id/duplicate', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    const limitMsg = ctx.checkLimit('quotes', db.get('SELECT COUNT(*) AS n FROM quotes WHERE user_id = ? AND created_at > ?', ctx.user.id, ctx.now() - MONTH).n);
    if (limitMsg) return redirect(`/quotes/${q.id}`, { err: limitMsg });
    return redirect(`/quotes/${copyQuote(ctx, q, { revision: false })}`, { ok: 'Duplicated as a new draft.' });
  });

  app.post('/quotes/:id/delete', (ctx) => {
    const q = getQuote(ctx, ctx.params.id);
    if (['sent', 'viewed', 'accepted'].includes(q.status)) return redirect(`/quotes/${q.id}`, { err: 'Open and accepted quotes cannot be deleted.' });
    db.run('DELETE FROM quotes WHERE id = ?', q.id);
    return redirect('/quotes', { ok: 'Quote deleted.' });
  });

  // ---- public customer page ----------------------------------------------------
  const publicQuote = (token) => {
    const q = db.get(`SELECT * FROM quotes WHERE token = ? AND status != 'draft'`, token);
    if (!q) return null;
    return { q, owner: db.get('SELECT * FROM users WHERE id = ?', q.user_id) };
  };

  app.get('/q/:token', (ctx) => {
    const found = publicQuote(ctx.params.token);
    if (!found) throw new HttpError(404, 'This quote link is not valid.');
    const { q, owner } = found;
    if (q.status === 'sent') db.run(`UPDATE quotes SET status = 'viewed', viewed_at = COALESCE(viewed_at, ?) WHERE id = ?`, ctx.now(), q.id);
    else if (!q.viewed_at) db.run('UPDATE quotes SET viewed_at = ? WHERE id = ?', ctx.now(), q.id);
    const today = todayIn(owner.timezone, ctx.now());
    const st = effectiveStatus(q, today);
    const newer = st === 'revised' ? db.get(`SELECT token FROM quotes WHERE parent_id = ? AND status != 'draft'`, q.id) : null;
    let actions;
    if (st === 'accepted') actions = html`<div class="flash flash-ok">Accepted${q.response_name ? ` by ${q.response_name}` : ''}. Thank you!</div>`;
    else if (st === 'declined') actions = html`<div class="flash flash-err">This quote was declined.</div>`;
    else if (st === 'expired') actions = html`<div class="flash flash-err">This quote expired on ${formatDate(q.valid_until)}. Please contact ${owner.name} for an updated quote.</div>`;
    else if (st === 'revised') actions = html`<div class="flash flash-err">This quote has been replaced by a newer version.${newer ? html` <a href="/q/${newer.token}">View the latest quote</a>` : ' A revised quote is on its way.'}</div>`;
    else {
      actions = html`<div class="no-print" style="margin-top:1.5rem;border-top:1px solid var(--border);padding-top:1rem">
        <h3>Your decision</h3>
        <form method="post" action="/q/${q.token}/respond">
          ${field({ label: 'Your name', name: 'name', required: true, attrs: { autocomplete: 'name' } })}
          ${field({ label: 'Comments (optional)', name: 'comment', type: 'textarea', rows: 2 })}
          <div class="actions"><button class="btn btn-primary btn-lg" type="submit" name="decision" value="accept">Accept quote</button><button class="btn" type="submit" name="decision" value="decline">Decline</button></div>
        </form></div>`;
    }
    return ctx.page(`Quote ${q.number}`, html`<p class="no-print center"><button class="btn" type="button" data-print>Print / Save as PDF</button></p>${quoteDocument(q, itemsOf(q.id), owner, { actions })}`, { noindex: true });
  }, { public: true });

  app.post('/q/:token/respond', async (ctx) => {
    const found = publicQuote(ctx.params.token);
    if (!found) throw new HttpError(404, 'This quote link is not valid.');
    const { q, owner } = found;
    if (!app.limiter.hit(`respond:${ctx.ip}`, 30, 3600e3, ctx.now()).ok) throw new HttpError(429, 'Too many requests');
    const back = `/q/${q.token}`;
    const today = todayIn(owner.timezone, ctx.now());
    if (!['sent', 'viewed'].includes(q.status) || effectiveStatus(q, today) === 'expired') return redirect(back);
    const decision = ctx.body.decision === 'accept' ? 'accepted' : ctx.body.decision === 'decline' ? 'declined' : null;
    const name = clean(ctx.body.name, 100);
    if (!decision) return redirect(back);
    if (decision === 'accepted' && !name) return redirect(back, { err: 'Please type your name to accept.' });
    const comment = clean(ctx.body.comment, 500);
    const res = db.run(`UPDATE quotes SET status = ?, responded_at = ?, response_name = ?, response_comment = ? WHERE id = ? AND status IN ('sent','viewed')`, decision, ctx.now(), name || null, comment || null, q.id);
    if (res.changes) {
      await app.mailer.send({
        userId: owner.id, to: owner.email,
        subject: `Quote ${q.number} ${decision} by ${q.customer_name}`,
        text: `${name || q.customer_name} ${decision} quote ${q.number} (${formatMoney(q.total, q.currency)}).${comment ? `\n\nTheir comment: ${comment}` : ''}\n\nOpen it: ${app.publicUrl(`/quotes/${q.id}`)}`,
        fromName: 'QuoteForge', footer: false,
      });
    }
    return redirect(back, { ok: decision === 'accepted' ? 'Thank you — your acceptance has been recorded.' : 'Your response has been recorded.' });
  }, { public: true, csrf: false });

  // ---- automatic follow-ups ------------------------------------------------------
  async function runFollowups() {
    const t = app.now();
    let sent = 0;
    for (const user of db.all('SELECT * FROM users')) {
      const s = ownerSettings(user);
      if (!s.auto_followup) continue;
      if (hourIn(user.timezone, t) < 9 || hourIn(user.timezone, t) >= 18) continue;
      const today = todayIn(user.timezone, t);
      const plan = app.planFor(user);
      for (const q of db.all(`SELECT * FROM quotes WHERE user_id = ? AND status IN ('sent','viewed') AND followed_up_at IS NULL`, user.id)) {
        if (!needsFollowUp(q, today, t, Number(s.followup_days) || 3) || !isEmail(q.customer_email)) continue;
        if (app.mailer.sentThisMonth(user.id) >= app.limitFor(plan, 'emails')) break;
        const business = s.business_name || user.name;
        const r = await app.mailer.send({
          userId: user.id, to: q.customer_email, subject: `Following up on quote ${q.number}`, fromName: business,
          replyTo: isEmail(s.email) ? s.email : user.email,
          text: `Hi ${q.customer_name},\n\nJust checking whether you had a chance to look at quote ${q.number} (${formatMoney(q.total, q.currency)}).\n\nReview and accept it here:\n${quoteUrl(q)}\n\nHappy to adjust anything — just reply to this email.\n\n${business}`,
        });
        if (r.ok) {
          db.run('UPDATE quotes SET followed_up_at = ? WHERE id = ?', t, q.id);
          sent++;
        }
      }
    }
    return sent;
  }
  app.runFollowups = runFollowups;
  app.job('followups', 3_600_000, () => runFollowups());

  // ---- settings ------------------------------------------------------------------
  app.get('/settings', (ctx) => {
    const s = ctx.settings;
    const taxId = ctx.user.currency === 'INR' ? 'GSTIN' : 'Tax ID / EIN';
    const def = taxDefaults(ctx);
    return ctx.page(
      'Business settings',
      html`${pageHeader('Business settings', '', 'Shown on every quote you send.')}
      <form method="post" action="/settings">${csrfField(ctx)}
        ${card('Business details', html`
          <div class="row">
            ${field({ label: 'Business name', name: 'business_name', value: s.business_name, placeholder: ctx.user.name })}
            ${field({ label: taxId, name: 'tax_id', value: s.tax_id })}
            ${field({ label: 'Contact email', name: 'email', type: 'email', value: s.email, placeholder: ctx.user.email, help: 'Customer replies go here.' })}
            ${field({ label: 'Phone', name: 'phone', type: 'tel', value: s.phone })}
          </div>
          ${field({ label: 'Address', name: 'address', type: 'textarea', rows: 3, value: s.address })}
          ${field({ label: 'Logo URL (optional)', name: 'logo_url', type: 'url', value: s.logo_url, help: 'A public https:// image link.' })}`)}
        ${card('Defaults for new quotes', html`
          <div class="row">
            ${field({ label: 'Quote number prefix', name: 'quote_prefix', value: s.quote_prefix, attrs: { maxlength: 8 } })}
            ${field({ label: 'Valid for (days)', name: 'validity_days', type: 'number', value: s.validity_days, attrs: { min: 1, max: 365 } })}
            ${field({ label: 'Default tax', name: 'tax_mode', type: 'select', options: TAX_MODES, value: def.mode })}
            ${field({ label: 'Default tax rate (%)', name: 'tax_rate', value: def.rate })}
          </div>
          ${field({ label: 'Default notes', name: 'default_notes', type: 'textarea', rows: 2, value: s.default_notes })}
          ${field({ label: 'Default terms & conditions', name: 'default_terms', type: 'textarea', rows: 4, value: s.default_terms, placeholder: '50% advance, balance on completion. Prices valid for the period stated.' })}`)}
        ${card('Follow-ups', html`
          ${field({ label: 'Follow up automatically', name: 'auto_followup', type: 'checkbox', value: s.auto_followup, help: 'Send one polite reminder for quotes still unanswered after the number of days below (business hours only).' })}
          ${field({ label: 'Days before follow-up', name: 'followup_days', type: 'number', value: s.followup_days, attrs: { min: 1, max: 30 } })}`)}
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>`,
    );
  });

  app.post('/settings', (ctx) => {
    const b = ctx.body;
    const logo = String(b.logo_url ?? '').trim();
    const rate = parseAmount(b.tax_rate);
    ctx.saveSettings({
      business_name: clean(b.business_name, 100), tax_id: clean(b.tax_id, 40), email: isEmail(String(b.email ?? '').trim().toLowerCase()) ? String(b.email).trim().toLowerCase() : '',
      phone: clean(b.phone, 30), address: clean(b.address, 300), logo_url: safeUrl(logo).startsWith('http') ? logo.slice(0, 300) : '',
      quote_prefix: clean(b.quote_prefix, 8).replace(/[^A-Za-z0-9\-_/]/g, '') || 'Q-',
      validity_days: Math.min(365, Math.max(1, Math.round(Number(b.validity_days)) || 14)),
      tax_mode: TAX_MODES.some(([k]) => k === b.tax_mode) ? b.tax_mode : 'none', tax_rate: Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : 0,
      default_notes: clean(b.default_notes, 1500), default_terms: clean(b.default_terms, 3000),
      auto_followup: b.auto_followup === '1', followup_days: Math.min(30, Math.max(1, Math.round(Number(b.followup_days)) || 3)),
    });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  return app;
}
