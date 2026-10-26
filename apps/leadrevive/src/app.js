import {
  HttpError,
  addDays,
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
  pageHeader,
  parseAmount,
  redirect,
  safeUrl,
  statGrid,
  table,
  toCsv,
  toMinor, THEMES } from '@saas/core';
import { aiDraft, DEFAULT_MODEL, getClient } from './ai.js';
import {
  OPEN_STATUSES,
  STAGES,
  STATUSES,
  STATUS_LABEL,
  daysSinceContact,
  isStale,
  leadScore,
  parseLeadCsv,
  pickStage,
  templateDraft,
  waDigits,
} from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    value INTEGER NOT NULL DEFAULT 0,
    last_contact_on TEXT,
    notes TEXT NOT NULL DEFAULT '',
    do_not_contact INTEGER NOT NULL DEFAULT 0,
    won_on TEXT,
    recovered INTEGER NOT NULL DEFAULT 0,
    created_on TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX leads_user_status ON leads (user_id, status);
  CREATE INDEX leads_user_email ON leads (user_id, email);
  CREATE TABLE followups (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    ai INTEGER NOT NULL DEFAULT 0,
    manual INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX followups_lead ON followups (lead_id, status);
  CREATE INDEX followups_user_time ON followups (user_id, created_at);
  `,,
  `ALTER TABLE leads ADD COLUMN snoozed_until TEXT;`
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { leads: 25, emails: 15, ai_drafts: 10 }, blurb: 'See what is hiding in your pipeline.', features: ['Template + AI drafts', 'WhatsApp click-to-send'] },
  starter: { label: 'Starter', price: { INR: 1499, USD: 39 }, limits: { leads: 500, emails: 400, ai_drafts: 150 }, blurb: 'For solo brokers and small agencies.', features: ['CSV import & export', 'Recovered-revenue report'] },
  pro: { label: 'Pro', price: { INR: 3999, USD: 99 }, limits: { leads: 5000, emails: 2000, ai_drafts: 1000 }, featured: true, blurb: 'For teams working a real pipeline.', features: ['Everything in Starter', 'Priority support'] },
  agency: { label: 'Agency', price: { INR: 5999, USD: 149 }, limits: { leads: 25000, emails: 10000, ai_drafts: 4000 }, blurb: 'For agencies running many lead lists.', features: ['Everything in Pro', 'Onboarding call'] },
};

const STATUS_TONE = { new: 'info', contacted: 'neutral', replied: 'warn', won: 'good', lost: 'bad' };
const monthAgo = (ms) => ms - 31 * 86400000;

export function createLeadRevive(options = {}) {
  const { anthropic, ...appOptions } = options;
  const app = createApp({
    slug: 'leadrevive',
    name: 'LeadRevive',
    tagline: 'Win back the leads you already paid for',
    accent: THEMES.leadrevive.accent,
    theme: THEMES.leadrevive,
    glyph: 'revive',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/leads', label: 'Leads' },
      { href: '/drafts', label: 'Drafts' },
      { href: '/import', label: 'Import' },
      { href: '/settings', label: 'Settings' },
    ],
    plans: PLANS,
    limitLabels: { leads: 'leads', emails: 'follow-up emails / month', ai_drafts: 'AI drafts / month' },
    migrations: MIGRATIONS,
    settingsDefaults: { business_name: '', sender_name: '', offer: '', booking_link: '', tone: 'friendly', stale_days: 7, reply_to: '', use_ai: true },
    usage: (db, user) => ({
      leads: db.get('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?', user.id).n,
      emails: app.mailer.sentThisMonth(user.id),
      ai_drafts: aiUsed(user.id),
    }),
    marketing: {
      preview: { chartTitle: 'Cold leads by days quiet', ringTitle: 'Leads revived', bars: [{ label: '7–14d', value: 34 }, { label: '15–30d', value: 51 }, { label: '31–60d', value: 38 }, { label: '61–90d', value: 22 }, { label: '90d+', value: 15 }], ring: { value: 28, text: '28%', label: 'revived', note: 'replied or won after a follow-up' }, kpis: [{ label: 'Revenue at risk', value: '₹18.6L', delta: '160 cold leads', deltaTone: 'bad' }, { label: 'Recovered this month', value: '₹3.2L', delta: '+22%', deltaTone: 'good' }, { label: 'Follow-ups sent', value: '212', delta: '31 days' }] },
      audience: 'For agencies, brokers and service businesses',
      headline: 'Your cold leads are unpaid revenue. Go get it back.',
      sub: 'LeadRevive finds the enquiries that went quiet, ranks them by value, writes a personal follow-up for each, and shows how much revenue it recovered.',
      points: [
        { title: 'See revenue at risk', body: 'Import your pipeline and instantly see how much money is sitting in leads nobody has touched in weeks.' },
        { title: 'Follow-ups that sound like you', body: 'AI drafts a short, human message per lead (or use proven templates). You approve every message before it goes out.' },
        { title: 'Email or WhatsApp', body: 'Send by email in one click, or open WhatsApp with the message pre-filled — the channel your customers actually reply on.' },
        { title: 'Proof it pays for itself', body: 'Won deals that followed one of your follow-ups are counted as recovered revenue, month by month.' },
      ],
      steps: [
        { title: 'Import leads', body: 'Paste a CSV from your CRM, Google Sheet or enquiry form. Columns are recognised automatically.' },
        { title: 'Review drafts', body: 'One click drafts follow-ups for your most valuable cold leads. Edit anything, then send.' },
        { title: 'Track the wins', body: 'Mark replies and wins. Recovered revenue is calculated for you.' },
      ],
      faq: [
        { q: 'Does it send anything without my approval?', a: 'No. Every follow-up is a draft until you press send.' },
        { q: 'What if I don’t want AI?', a: 'Switch it off in Settings and LeadRevive uses its built-in templates instead.' },
        { q: 'Will my leads be spammed?', a: 'Each lead gets at most one open draft, three escalating messages over time, and a do-not-contact switch that is always respected.' },
      ],
    },
    ...appOptions,
  });

  const { db } = app;
  const model = app.config.env.LEADREVIVE_MODEL || DEFAULT_MODEL;
  let clientPromise;
  const aiClient = () => (clientPromise ??= getClient(app.config.env, anthropic));
  const aiUsed = (userId) => db.get('SELECT COUNT(*) AS n FROM followups WHERE user_id = ? AND ai = 1 AND created_at > ?', userId, monthAgo(app.now())).n;

  // ---- helpers ------------------------------------------------------------
  const getLead = (ctx, id) => {
    const lead = db.get('SELECT * FROM leads WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    return lead;
  };
  const getDraft = (ctx, id) => {
    const d = db.get(`SELECT * FROM followups WHERE id = ? AND user_id = ? AND status = 'draft'`, Number(id), ctx.user.id);
    if (!d) throw new HttpError(404, 'Draft not found');
    return d;
  };
  const sentCount = (leadId) => db.get(`SELECT COUNT(*) AS n FROM followups WHERE lead_id = ? AND status = 'sent'`, leadId).n;

  /** Create (or find) the draft for a lead. Returns { ok, reason?, draft?, ai? }. */
  async function createDraft(user, settings, lead, today) {
    if (lead.do_not_contact || !OPEN_STATUSES.includes(lead.status)) return { ok: false, reason: 'ineligible' };
    const existing = db.get(`SELECT * FROM followups WHERE lead_id = ? AND status = 'draft'`, lead.id);
    if (existing) return { ok: false, reason: 'exists', draft: existing };
    const stage = pickStage(sentCount(lead.id));
    const daysStale = daysSinceContact(lead, today);
    const plan = app.planFor(user);
    let content = null;
    let usedAi = false;
    if (settings.use_ai && aiUsed(user.id) < app.limitFor(plan, 'ai_drafts')) {
      content = await aiDraft({ client: await aiClient(), model, lead, stage, settings, user, daysStale });
      usedAi = Boolean(content);
    }
    content ??= templateDraft({ lead, stage, settings, user });
    const id = db.run(
      'INSERT INTO followups (lead_id, user_id, stage, subject, body, ai, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      lead.id, user.id, stage, content.subject.slice(0, 200), content.body, usedAi ? 1 : 0, app.now(),
    ).id;
    return { ok: true, draft: db.get('SELECT * FROM followups WHERE id = ?', id), ai: usedAi };
  }

  /** Send (or record as manually sent) a draft; edits to subject/body are saved. */
  async function sendDraft(user, settings, draft, { subject, body, manual = false, today }) {
    const lead = db.get('SELECT * FROM leads WHERE id = ?', draft.lead_id);
    if (lead.do_not_contact) return { ok: false, error: 'This lead is marked do-not-contact.' };
    subject = clean(subject || draft.subject, 200);
    body = String(body || draft.body).slice(0, 5000);
    if (!subject || !body.trim()) return { ok: false, error: 'Subject and message cannot be empty.' };
    if (!manual) {
      if (!isEmail(lead.email)) return { ok: false, error: `${lead.name} has no valid email — send via WhatsApp and use “Mark as sent”.` };
      if (app.mailer.sentThisMonth(user.id) >= app.limitFor(app.planFor(user), 'emails')) {
        return { ok: false, error: 'Monthly follow-up email limit reached. Upgrade on the Billing page.' };
      }
      const r = await app.mailer.send({
        userId: user.id,
        to: lead.email,
        subject,
        text: body,
        replyTo: isEmail(settings.reply_to) ? settings.reply_to : user.email,
        fromName: settings.business_name || user.name,
      });
      if (!r.ok) return { ok: false, error: `Could not send: ${r.error}` };
    }
    db.tx(() => {
      db.run(`UPDATE followups SET subject = ?, body = ?, status = 'sent', manual = ?, sent_at = ? WHERE id = ?`, subject, body, manual ? 1 : 0, app.now(), draft.id);
      db.run(`UPDATE leads SET last_contact_on = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ?`, today, lead.id);
    });
    return { ok: true };
  }

  const pill = (href, label, active) => html`<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
  const cur = (ctx) => (minor) => (minor ? formatMoney(minor, ctx.user.currency) : '—');

  // ---- dashboard ----------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const today = ctx.today();
    const leads = db.all('SELECT * FROM leads WHERE user_id = ?', ctx.user.id);
    if (!leads.length) {
      return ctx.page('Dashboard', html`${pageHeader('Dashboard')}${emptyState('Import your leads to find hidden revenue', 'Paste a CSV from your CRM, spreadsheet or enquiry form. It takes a minute.', html`<p><a class="btn btn-primary" href="/import">Import leads</a> <a class="btn" href="/leads/new">Add one lead</a></p>`)}`);
    }
    const stale = leads
      .filter((l) => isStale(l, today, ctx.settings.stale_days))
      .map((l) => ({ ...l, days: daysSinceContact(l, today), score: leadScore(l, today) }))
      .sort((a, b) => b.score - a.score || b.value - a.value);
    const atRisk = stale.reduce((s, l) => s + l.value, 0);
    const month = today.slice(0, 7);
    const won = leads.filter((l) => l.status === 'won' && l.recovered);
    const recoveredAll = won.reduce((s, l) => s + l.value, 0);
    const recoveredMonth = won.filter((l) => l.won_on?.startsWith(month)).reduce((s, l) => s + l.value, 0);
    const contactedIds = new Set(db.all(`SELECT DISTINCT lead_id FROM followups WHERE user_id = ? AND status = 'sent'`, ctx.user.id).map((r) => r.lead_id));
    const revived = leads.filter((l) => contactedIds.has(l.id) && ['replied', 'won'].includes(l.status)).length;
    const draftsOpen = db.get(`SELECT COUNT(*) AS n FROM followups WHERE user_id = ? AND status = 'draft'`, ctx.user.id).n;
    const sentMonth = db.get(`SELECT COUNT(*) AS n FROM followups WHERE user_id = ? AND status = 'sent' AND sent_at > ?`, ctx.user.id, app.now() - 31 * 86400000).n;
    const m = cur(ctx);
    const top = stale.slice(0, 12);
    return ctx.page(
      'Dashboard',
      html`${pageHeader('Dashboard', draftsOpen ? html`<a class="btn btn-primary" href="/drafts">Review ${draftsOpen} draft${draftsOpen === 1 ? '' : 's'}</a>` : '', `A lead counts as cold after ${ctx.settings.stale_days} days without contact.`)}
      ${statGrid([
        { label: 'Revenue at risk', value: m(atRisk) || '—', tone: atRisk ? 'bad' : '', hint: `${stale.length} cold lead${stale.length === 1 ? '' : 's'}` },
        { label: 'Recovered this month', value: m(recoveredMonth), tone: 'good' },
        { label: 'Recovered all time', value: m(recoveredAll), tone: 'good', hint: 'won after a follow-up' },
        { label: 'Follow-ups sent (31d)', value: sentMonth },
        { label: 'Leads revived', value: revived, hint: `${contactedIds.size ? Math.round((revived / contactedIds.size) * 100) : 0}% of leads followed up` },
      ])}
      ${stale.length ? html`<div class="viz">${card('Cold leads by days quiet', vbars({ height: 170, items: [['7–14d', 7, 14], ['15–30d', 15, 30], ['31–60d', 31, 60], ['61–90d', 61, 90], ['90d+', 91, 1e9]].map(([label, lo, hi]) => ({ label, value: stale.filter((l) => l.days >= lo && l.days <= hi).length })) }))}${card('Leads revived', html`${ring({ value: revived, max: contactedIds.size || 1, text: `${contactedIds.size ? Math.round((revived / contactedIds.size) * 100) : 0}%`, label: 'revived' })}<p class="muted center">replied or won after a follow-up</p>`, { className: 'ring-card' })}</div>` : ''}
      ${stale.length
        ? card(
            'Follow up first',
            html`<form method="post" action="/drafts/generate" class="inline-form" style="margin-bottom:1rem">${csrfField(ctx)}
              <label for="limit">Draft follow-ups for the top</label>
              <input id="limit" type="number" name="limit" value="10" min="1" max="50" style="width:5rem">
              <button class="btn btn-primary" type="submit">Draft follow-ups</button>
              <span class="muted">${ctx.settings.use_ai ? 'AI-written where your plan allows, templates otherwise.' : 'Using templates.'}</span>
            </form>
            ${table({
              columns: [
                { label: 'Lead', render: (l) => html`<a href="/leads/${l.id}"><strong>${l.name}</strong></a>${l.company ? html`<span class="sub">${l.company}</span>` : ''}` },
                { label: 'Value', align: 'right', render: (l) => m(l.value) },
                { label: 'Quiet for', align: 'right', render: (l) => `${l.days}d` },
                { label: 'Status', render: (l) => badge(STATUS_LABEL[l.status], STATUS_TONE[l.status]) },
                { label: 'Priority', align: 'right', render: (l) => l.score },
                {
                  label: '',
                  render: (l) => html`<form method="post" action="/leads/${l.id}/draft" class="inline">${csrfField(ctx)}<button class="btn btn-sm" type="submit">Draft</button></form>`,
                },
              ],
              rows: top,
            })}
            ${stale.length > top.length ? html`<p class="muted">+ ${stale.length - top.length} more on the <a href="/leads?filter=stale">Leads</a> page.</p>` : ''}`,
          )
        : card('', html`<p>No cold leads right now. Everyone has been contacted in the last ${ctx.settings.stale_days} days.</p>`)}`,
    );
  });

  // ---- leads --------------------------------------------------------------
  const FILTERS = [['stale', 'Needs follow-up'], ['open', 'All open'], ['won', 'Won'], ['lost', 'Lost'], ['all', 'Everything']];

  app.get('/leads', (ctx) => {
    const today = ctx.today();
    const filter = FILTERS.some(([k]) => k === ctx.query.filter) ? ctx.query.filter : 'stale';
    const q = clean(ctx.query.q, 80).toLowerCase();
    let rows = db.all('SELECT * FROM leads WHERE user_id = ? LIMIT 30000', ctx.user.id);
    rows = rows
      .filter((l) => {
        if (filter === 'stale' && !isStale(l, today, ctx.settings.stale_days)) return false;
        if (filter === 'open' && !OPEN_STATUSES.includes(l.status)) return false;
        if (filter === 'won' && l.status !== 'won') return false;
        if (filter === 'lost' && l.status !== 'lost') return false;
        return !q || [l.name, l.company, l.email, l.phone].some((v) => v.toLowerCase().includes(q));
      })
      .map((l) => ({ ...l, days: daysSinceContact(l, today), score: leadScore(l, today) }))
      .sort((a, b) => (filter === 'won' || filter === 'lost' ? b.id - a.id : b.score - a.score || b.value - a.value));
    const shown = rows.slice(0, 300);
    const m = cur(ctx);
    return ctx.page(
      'Leads',
      html`${pageHeader('Leads', html`<a class="btn" href="/leads.csv">Export CSV</a><a class="btn btn-primary" href="/leads/new">Add lead</a>`)}
      <div class="pill-row">${FILTERS.map(([k, l]) => pill(`/leads?filter=${k}`, l, k === filter))}</div>
      <form method="get" action="/leads" class="inline-form" style="margin-bottom:1rem"><input type="hidden" name="filter" value="${filter}"><input type="text" name="q" value="${q}" placeholder="Search name, company, email, phone"><button class="btn" type="submit">Search</button></form>
      ${card('', table({
        columns: [
          { label: 'Lead', render: (l) => html`<a href="/leads/${l.id}"><strong>${l.name}</strong></a>${l.company ? html`<span class="sub">${l.company}</span>` : ''}` },
          { label: 'Contact', render: (l) => html`${l.email || '—'}${l.phone ? html`<span class="sub">${l.phone}</span>` : ''}` },
          { label: 'Value', align: 'right', render: (l) => m(l.value) },
          { label: 'Last contact', render: (l) => html`${l.last_contact_on ? formatDate(l.last_contact_on) : 'never'}<span class="sub">${l.days}d ago</span>` },
          { label: 'Status', render: (l) => html`${badge(STATUS_LABEL[l.status], STATUS_TONE[l.status])}${l.do_not_contact ? html` ${badge('DNC', 'bad')}` : ''}` },
        ],
        rows: shown,
        empty: q ? 'No leads match your search.' : 'No leads in this view.',
      }))}
      ${rows.length > shown.length ? html`<p class="muted">Showing ${shown.length} of ${rows.length}. Use search to narrow down.</p>` : ''}`,
    );
  });

  app.get('/leads.csv', (ctx) => {
    const rows = db.all('SELECT * FROM leads WHERE user_id = ? ORDER BY id', ctx.user.id);
    return download('leads.csv', toCsv(rows, [
      { key: 'name', label: 'name' }, { key: 'email', label: 'email' }, { key: 'phone', label: 'phone' }, { key: 'company', label: 'company' },
      { key: 'source', label: 'source' }, { key: 'status', label: 'status' }, { label: 'value', value: (r) => r.value / 100 },
      { key: 'last_contact_on', label: 'last_contact' }, { key: 'notes', label: 'notes' },
    ]));
  });

  const leadForm = (ctx, lead = {}, error = '') =>
    html`${error ? html`<div class="flash flash-err">${error}</div>` : ''}
    <form method="post" action="${lead.id ? `/leads/${lead.id}/edit` : '/leads'}">${csrfField(ctx)}
      <div class="row">
        ${field({ label: 'Name', name: 'name', value: lead.name ?? '', required: true })}
        ${field({ label: 'Company', name: 'company', value: lead.company ?? '' })}
        ${field({ label: 'Source', name: 'source', value: lead.source ?? '', placeholder: 'Website, referral, Instagram…' })}
      </div>
      <div class="row">
        ${field({ label: 'Email', name: 'email', type: 'email', value: lead.email ?? '' })}
        ${field({ label: 'Phone / WhatsApp', name: 'phone', type: 'tel', value: lead.phone ?? '' })}
        ${field({ label: `Deal value (${ctx.user.currency})`, name: 'value', value: lead.value ? lead.value / 100 : '', attrs: { inputmode: 'decimal' } })}
      </div>
      ${field({ label: 'Notes (what they asked for, objections…)', name: 'notes', type: 'textarea', value: lead.notes ?? '' })}
      <button class="btn btn-primary" type="submit">${lead.id ? 'Save changes' : 'Add lead'}</button>
    </form>`;

  function readLeadForm(ctx) {
    const b = ctx.body;
    const email = String(b.email ?? '').trim().toLowerCase();
    const value = b.value ? parseAmount(b.value) : 0;
    const v = {
      name: clean(b.name, 120), company: clean(b.company, 120), source: clean(b.source, 60), email,
      phone: String(b.phone ?? '').replace(/[^\d+()\-\s]/g, '').slice(0, 30),
      value: Number.isFinite(value) && value > 0 ? toMinor(value) : 0, notes: clean(b.notes, 1000),
    };
    let error = '';
    if (!v.name) error = 'Name is required.';
    else if (email && !isEmail(email)) error = 'That email does not look valid.';
    return { v, error };
  }

  app.get('/leads/new', (ctx) => ctx.page('Add lead', html`${pageHeader('Add lead')}${card('', leadForm(ctx))}`));

  app.post('/leads', (ctx) => {
    const { v, error } = readLeadForm(ctx);
    if (error) return ctx.page('Add lead', html`${pageHeader('Add lead')}${card('', leadForm(ctx, v, error))}`, { status: 400 });
    const limitMsg = ctx.checkLimit('leads', db.get('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?', ctx.user.id).n);
    if (limitMsg) return redirect('/leads', { err: limitMsg });
    const id = db.run(
      'INSERT INTO leads (user_id, name, email, phone, company, source, value, notes, created_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.user.id, v.name, v.email, v.phone, v.company, v.source, v.value, v.notes, ctx.today(), ctx.now(),
    ).id;
    return redirect(`/leads/${id}`, { ok: 'Lead added.' });
  });

  app.get('/leads/:id', (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    const today = ctx.today();
    const history = db.all('SELECT * FROM followups WHERE lead_id = ? ORDER BY id DESC', lead.id);
    const open = history.find((h) => h.status === 'draft');
    const m = cur(ctx);
    const action = (path, label, cls = 'btn', extra = {}) =>
      html`<form method="post" action="/leads/${lead.id}/${path}" class="inline">${csrfField(ctx)}${Object.entries(extra).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
    const wa = waDigits(lead.phone, ctx.user.currency);
    return ctx.page(
      lead.name,
      html`${pageHeader(
        html`${lead.name} ${badge(STATUS_LABEL[lead.status], STATUS_TONE[lead.status])}${lead.do_not_contact ? html` ${badge('Do not contact', 'bad')}` : ''}`,
        html`${open ? html`<a class="btn btn-primary" href="/drafts">Review draft</a>` : lead.do_not_contact ? '' : action('draft', 'Draft follow-up', 'btn btn-primary')}`,
        `${lead.company ? `${lead.company} · ` : ''}${m(lead.value)} · quiet for ${daysSinceContact(lead, today)} days`,
      )}
      <div class="grid-2">
        ${card('Update status', html`<div class="actions">
          ${STATUSES.filter((s) => s !== lead.status).map((s) => action('status', `Mark ${STATUS_LABEL[s].toLowerCase()}`, 'btn btn-sm', { status: s }))}
          ${action('dnc', lead.do_not_contact ? 'Allow contact' : 'Do not contact', 'btn btn-sm')}
        </div>
        ${OPEN_STATUSES.includes(lead.status) ? html`<form method="post" action="/leads/${lead.id}/snooze" class="inline-form" style="margin-top:.9rem">${csrfField(ctx)}
          <label for="sn">Snooze for</label><select id="sn" name="days">${[[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month'], [90, '3 months']].map(([d, l]) => html`<option value="${d}">${l}</option>`)}</select>
          <button class="btn btn-sm" type="submit">Snooze</button>${lead.snoozed_until && lead.snoozed_until > today ? html` ${badge(`Snoozed until ${formatDate(lead.snoozed_until)}`, 'info')}` : ''}</form>
          ${lead.snoozed_until && lead.snoozed_until > today ? action('unsnooze', 'Wake now', 'btn btn-sm') : ''}` : ''}${wa ? html`<p class="help">WhatsApp: <a href="https://wa.me/${wa}" target="_blank" rel="noopener">open chat</a></p>` : ''}`)}
        ${card('Follow-up history', table({
          columns: [
            { label: 'When', render: (h) => (h.sent_at ? new Date(h.sent_at).toISOString().slice(0, 10) : 'draft') },
            { label: 'Message', render: (h) => html`<strong>${STAGES[h.stage].label}</strong><span class="sub">${h.subject}</span>` },
            { label: '', render: (h) => html`${h.ai ? badge('AI', 'info') : ''} ${h.manual ? badge('manual', 'neutral') : ''}` },
          ],
          rows: history,
          empty: 'No follow-ups yet.',
        }))}
      </div>
      ${card('Details', leadForm(ctx, lead))}
      ${action('delete', 'Delete lead', 'btn btn-danger')}`,
    );
  });

  app.post('/leads/:id/edit', (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    const { v, error } = readLeadForm(ctx);
    if (error) return redirect(`/leads/${lead.id}`, { err: error });
    db.run('UPDATE leads SET name = ?, email = ?, phone = ?, company = ?, source = ?, value = ?, notes = ? WHERE id = ?', v.name, v.email, v.phone, v.company, v.source, v.value, v.notes, lead.id);
    return redirect(`/leads/${lead.id}`, { ok: 'Saved.' });
  });

  app.post('/leads/:id/status', (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    const status = String(ctx.body.status);
    if (!STATUSES.includes(status)) return redirect(`/leads/${lead.id}`, { err: 'Unknown status.' });
    if (status === 'won') {
      // "Recovered" = won after at least one follow-up we sent.
      db.run(`UPDATE leads SET status = 'won', won_on = ?, recovered = ? WHERE id = ?`, ctx.today(), sentCount(lead.id) > 0 ? 1 : 0, lead.id);
    } else {
      db.run('UPDATE leads SET status = ?, won_on = NULL, recovered = 0, last_contact_on = CASE WHEN ? = \'replied\' THEN ? ELSE last_contact_on END WHERE id = ?', status, status, ctx.today(), lead.id);
    }
    if (!OPEN_STATUSES.includes(status)) db.run(`UPDATE followups SET status = 'discarded' WHERE lead_id = ? AND status = 'draft'`, lead.id);
    return redirect(`/leads/${lead.id}`, { ok: `Marked ${STATUS_LABEL[status].toLowerCase()}.` });
  });

  app.post('/leads/:id/snooze', (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    const days = [3, 7, 14, 30, 90].includes(Number(ctx.body.days)) ? Number(ctx.body.days) : 7;
    const until = addDays(ctx.today(), days);
    db.run(`UPDATE leads SET snoozed_until = ? WHERE id = ?`, until, lead.id);
    db.run(`UPDATE followups SET status = 'discarded' WHERE lead_id = ? AND status = 'draft'`, lead.id);
    return redirect(`/leads/${lead.id}`, { ok: `Snoozed until ${formatDate(until)}. It will reappear in your cold list then.` });
  });
  app.post('/leads/:id/unsnooze', (ctx) => {
    db.run('UPDATE leads SET snoozed_until = NULL WHERE id = ? AND user_id = ?', getLead(ctx, ctx.params.id).id, ctx.user.id);
    return redirect(`/leads/${ctx.params.id}`, { ok: 'Lead is active again.' });
  });
  app.post('/leads/:id/dnc', (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    db.run('UPDATE leads SET do_not_contact = ? WHERE id = ?', lead.do_not_contact ? 0 : 1, lead.id);
    if (!lead.do_not_contact) db.run(`UPDATE followups SET status = 'discarded' WHERE lead_id = ? AND status = 'draft'`, lead.id);
    return redirect(`/leads/${lead.id}`, { ok: lead.do_not_contact ? 'Contact allowed again.' : 'Marked do-not-contact. No messages will be drafted or sent.' });
  });

  app.post('/leads/:id/delete', (ctx) => {
    db.run('DELETE FROM leads WHERE id = ? AND user_id = ?', getLead(ctx, ctx.params.id).id, ctx.user.id);
    return redirect('/leads', { ok: 'Lead deleted.' });
  });

  app.post('/leads/:id/draft', async (ctx) => {
    const lead = getLead(ctx, ctx.params.id);
    const r = await createDraft(ctx.user, ctx.settings, lead, ctx.today());
    if (r.reason === 'ineligible') return redirect(`/leads/${lead.id}`, { err: 'This lead is closed or marked do-not-contact.' });
    return redirect('/drafts', { ok: r.ok ? `Draft ready for ${lead.name}${r.ai ? ' (AI-written)' : ''}.` : `${lead.name} already has a draft waiting.` });
  });

  // ---- drafts -------------------------------------------------------------
  app.get('/drafts', (ctx) => {
    const drafts = db.all(
      `SELECT f.*, l.name AS lead_name, l.company, l.email, l.phone, l.value FROM followups f JOIN leads l ON l.id = f.lead_id
       WHERE f.user_id = ? AND f.status = 'draft' ORDER BY f.id DESC LIMIT 100`,
      ctx.user.id,
    );
    const m = cur(ctx);
    if (!drafts.length) {
      return ctx.page('Drafts', html`${pageHeader('Drafts')}${emptyState('No drafts waiting', 'Draft follow-ups from the dashboard or any lead.', html`<p><a class="btn btn-primary" href="/dashboard">Go to dashboard</a></p>`)}`);
    }
    return ctx.page(
      'Drafts',
      html`${pageHeader('Drafts', html`<form method="post" action="/drafts/send-all" data-confirm="Send every draft that has an email address?">${csrfField(ctx)}<button class="btn btn-primary" type="submit">Send all with email</button></form>`, 'Nothing is sent until you press send. Edit freely.')}
      ${drafts.map((d) => {
        const wa = waDigits(d.phone, ctx.user.currency);
        return card('', html`
          <p><strong>${d.lead_name}</strong>${d.company ? ` · ${d.company}` : ''} · ${m(d.value)} ${badge(STAGES[d.stage].label, 'neutral')} ${d.ai ? badge('AI-written', 'info') : ''}</p>
          <form method="post" action="/drafts/${d.id}/send">${csrfField(ctx)}
            ${field({ label: 'Subject', name: 'subject', value: d.subject, id: `s_${d.id}` })}
            ${field({ label: `Message${d.email ? ` to ${d.email}` : ' (no email on file)'}`, name: 'body', type: 'textarea', value: d.body, rows: 8, id: `b_${d.id}` })}
            <div class="actions">
              ${d.email ? html`<button class="btn btn-primary" type="submit">Send email</button>` : ''}
              <button class="btn" type="submit" formaction="/drafts/${d.id}/manual">Mark as sent (I sent it myself)</button>
              <button class="btn" type="button" data-copy="#b_${d.id}">Copy message</button>
              ${wa ? html`<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(d.body)}">WhatsApp</a>` : ''}
              <button class="btn" type="submit" formaction="/drafts/${d.id}/discard">Discard</button>
            </div>
          </form>`);
      })}`,
    );
  });

  app.post('/drafts/generate', async (ctx) => {
    const today = ctx.today();
    const want = Math.min(50, Math.max(1, Math.round(Number(ctx.body.limit)) || 10));
    const stale = db
      .all(`SELECT * FROM leads WHERE user_id = ? AND do_not_contact = 0 AND status IN ('new','contacted','replied')`, ctx.user.id)
      .filter((l) => isStale(l, today, ctx.settings.stale_days))
      .sort((a, b) => leadScore(b, today) - leadScore(a, today) || b.value - a.value);
    let created = 0;
    let withAi = 0;
    for (const lead of stale) {
      if (created >= want) break;
      const r = await createDraft(ctx.user, ctx.settings, lead, today);
      if (r.ok) {
        created++;
        if (r.ai) withAi++;
      }
    }
    if (!created) return redirect('/dashboard', { err: stale.length ? 'Every cold lead already has a draft waiting.' : 'No cold leads to draft for.' });
    return redirect('/drafts', { ok: `${created} draft${created === 1 ? '' : 's'} ready (${withAi} AI-written, ${created - withAi} from templates). Review and send.` });
  });

  app.post('/drafts/send-all', async (ctx) => {
    const drafts = db.all(`SELECT f.* FROM followups f JOIN leads l ON l.id = f.lead_id WHERE f.user_id = ? AND f.status = 'draft' AND l.email != '' ORDER BY f.id`, ctx.user.id);
    let sent = 0;
    let stopped = '';
    for (const d of drafts) {
      const r = await sendDraft(ctx.user, ctx.settings, d, { today: ctx.today() });
      if (r.ok) sent++;
      else if (/limit/i.test(r.error)) {
        stopped = r.error;
        break;
      }
    }
    return redirect('/drafts', stopped ? { err: `Sent ${sent}. ${stopped}` } : { ok: `Sent ${sent} follow-up${sent === 1 ? '' : 's'}.` });
  });

  const sendOne = (manual) => async (ctx) => {
    const d = getDraft(ctx, ctx.params.id);
    const r = await sendDraft(ctx.user, ctx.settings, d, { subject: ctx.body.subject, body: ctx.body.body, manual, today: ctx.today() });
    return redirect('/drafts', r.ok ? { ok: manual ? 'Recorded as sent.' : 'Sent.' } : { err: r.error });
  };
  app.post('/drafts/:id/send', sendOne(false));
  app.post('/drafts/:id/manual', sendOne(true));
  app.post('/drafts/:id/discard', (ctx) => {
    db.run(`UPDATE followups SET status = 'discarded' WHERE id = ?`, getDraft(ctx, ctx.params.id).id);
    return redirect('/drafts', { ok: 'Draft discarded.' });
  });

  // ---- import -------------------------------------------------------------
  const importForm = (ctx, extra = '', text = '') =>
    ctx.page(
      'Import leads',
      html`${pageHeader('Import leads', '', 'Paste a CSV or choose a file. Leads with the same email are updated, not duplicated.')}${extra}
      ${card('', html`<form method="post" action="/import">${csrfField(ctx)}
        <p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#csv"></p>
        ${field({ label: 'CSV data', name: 'csv', type: 'textarea', value: text, rows: 12, id: 'csv', required: true, placeholder: 'name,email,phone,company,value,status,last_contact\nAsha Rao,asha@example.com,9876543210,Rao Realty,250000,contacted,2026-09-01' })}
        <p class="help">Recognised columns: name, email, phone / whatsapp, company, source, status / stage, value / budget, last_contact, notes, created. Statuses from other CRMs (“Closed Won”, “Quoted”, “Dead”…) are mapped automatically.</p>
        <button class="btn btn-primary" type="submit">Import</button>
      </form>`)}`,
    );
  app.get('/import', (ctx) => importForm(ctx));

  app.post('/import', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    const today = ctx.today();
    let parsed;
    try {
      parsed = parseLeadCsv(text, { dayFirst: ctx.user.currency === 'INR', today });
    } catch (err) {
      return importForm(ctx, html`<div class="flash flash-err">${err.message}</div>`, text);
    }
    if (parsed.missing.length) return importForm(ctx, html`<div class="flash flash-err">Couldn't find a name or email column. Add a header row such as <span class="mono">name,email,phone,value</span>.</div>`, text);
    let created = 0;
    let updated = 0;
    let overLimit = 0;
    db.tx(() => {
      let total = db.get('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?', ctx.user.id).n;
      const limit = ctx.limit('leads');
      for (const r of parsed.rows) {
        const existing = r.email
          ? db.get('SELECT * FROM leads WHERE user_id = ? AND email = ?', ctx.user.id, r.email)
          : db.get('SELECT * FROM leads WHERE user_id = ? AND email = \'\' AND lower(name) = lower(?) AND lower(company) = lower(?)', ctx.user.id, r.name, r.company);
        if (existing) {
          db.run(
            `UPDATE leads SET name = ?, phone = CASE WHEN ? != '' THEN ? ELSE phone END, company = CASE WHEN ? != '' THEN ? ELSE company END,
             value = CASE WHEN ? > 0 THEN ? ELSE value END, notes = CASE WHEN ? != '' THEN ? ELSE notes END,
             status = CASE WHEN ? != 'new' THEN ? ELSE status END, last_contact_on = COALESCE(MAX(?, last_contact_on), ?, last_contact_on) WHERE id = ?`,
            r.name, r.phone, r.phone, r.company, r.company, r.value, r.value, r.notes, r.notes, r.status, r.status, r.last_contact_on, r.last_contact_on, existing.id,
          );
          updated++;
          continue;
        }
        if (total + 1 > limit) {
          overLimit++;
          continue;
        }
        db.run(
          `INSERT INTO leads (user_id, name, email, phone, company, source, status, value, last_contact_on, notes, created_on, created_at, won_on)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.user.id, r.name, r.email, r.phone, r.company, r.source, r.status, r.value, r.last_contact_on, r.notes, r.created_on ?? today, ctx.now(), r.status === 'won' ? today : null,
        );
        total++;
        created++;
      }
    });
    const msg = `Imported ${created} new, updated ${updated}${overLimit ? `; ${overLimit} skipped because your ${ctx.planInfo.label} plan allows ${ctx.limit('leads').toLocaleString('en-US')} leads — upgrade on the Billing page` : ''}.`;
    if (parsed.errors.length) {
      return importForm(ctx, html`<div class="flash flash-ok">${msg}</div>${card(`${parsed.errors.length} note${parsed.errors.length === 1 ? '' : 's'}`, table({ columns: [{ label: 'Line', render: (e) => e.line }, { label: 'Note', render: (e) => e.message }], rows: parsed.errors.slice(0, 100) }))}`);
    }
    return redirect('/dashboard', { ok: msg });
  }, { maxBody: 5 * 1024 * 1024 });

  // ---- settings -----------------------------------------------------------
  app.get('/settings', (ctx) => {
    const s = ctx.settings;
    return ctx.page(
      'Settings',
      html`${pageHeader('Settings')}
      <form method="post" action="/settings">${csrfField(ctx)}
        ${card('How your follow-ups sound', html`
          ${field({ label: 'Business name', name: 'business_name', value: s.business_name, placeholder: ctx.user.name })}
          ${field({ label: 'Sender name (signs the emails)', name: 'sender_name', value: s.sender_name, placeholder: ctx.user.name })}
          ${field({ label: 'What you offer', name: 'offer', type: 'textarea', value: s.offer, rows: 3, help: 'One or two sentences. Used as context by the AI and included in template drafts.' })}
          ${field({ label: 'Booking link (optional)', name: 'booking_link', type: 'url', value: s.booking_link, help: 'Calendly, Cal.com, Google Calendar… the only link follow-ups may contain.' })}
          ${field({ label: 'Tone', name: 'tone', type: 'select', options: [['friendly', 'Friendly'], ['professional', 'Professional'], ['direct', 'Direct']], value: s.tone })}
          ${field({ label: 'Reply-to email', name: 'reply_to', type: 'email', value: s.reply_to, placeholder: ctx.user.email, help: 'Replies land here. Defaults to your login email.' })}
        `)}
        ${card('Pipeline rules', html`
          ${field({ label: 'Lead is cold after (days without contact)', name: 'stale_days', type: 'number', value: s.stale_days, attrs: { min: 2, max: 90 } })}
          ${field({ label: 'Write drafts with AI when available', name: 'use_ai', type: 'checkbox', value: s.use_ai, help: 'Drafts are generated by Claude from your settings and the lead’s details. Turn off to use templates only.' })}
        `)}
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>`,
    );
  });

  app.post('/settings', (ctx) => {
    const b = ctx.body;
    const link = String(b.booking_link ?? '').trim();
    ctx.saveSettings({
      business_name: clean(b.business_name, 100),
      sender_name: clean(b.sender_name, 100),
      offer: clean(b.offer, 400),
      booking_link: safeUrl(link).startsWith('http') ? link.slice(0, 300) : '',
      tone: ['friendly', 'professional', 'direct'].includes(b.tone) ? b.tone : 'friendly',
      reply_to: isEmail(String(b.reply_to ?? '').trim().toLowerCase()) ? String(b.reply_to).trim().toLowerCase() : '',
      stale_days: Math.min(90, Math.max(2, Math.round(Number(b.stale_days)) || 7)),
      use_ai: b.use_ai === '1',
    });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  return app;
}
