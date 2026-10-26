import {
  HttpError,
  badge,
  card,
  ring,
  vbars,
  clean,
  createApp,
  csrfField,
  CURRENCIES,
  download,
  emptyState,
  field,
  addDays,
  formatDate,
  formatMoney,
  html,
  isEmail,
  isISODate,
  pageHeader,
  parseAmount,
  parseDateLoose,
  randomToken,
  raw,
  redirect,
  statGrid,
  table,
  todayIn,
  toArray,
  toCsv,
  toMinor,
  safeUrl,
} from '@saas/core';
import {
  BUCKET_LABELS,
  DEFAULT_STAGES,
  STAGES,
  agingBuckets,
  daysOverdue,
  nextStage,
  parseInvoiceCsv,
  reminderVars,
  renderReminder,
  statusOf,
  summarize,
  topDebtors,
} from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_email TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    issue_date TEXT,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    paid_on TEXT,
    paid_after_reminder INTEGER NOT NULL DEFAULT 0,
    pay_link TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    reminders_paused INTEGER NOT NULL DEFAULT 0,
    last_stage INTEGER,
    last_reminder_at INTEGER,
    claimed_paid_at INTEGER,
    public_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, number)
  );
  CREATE INDEX invoices_user_status_due ON invoices (user_id, status, due_date);
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage INTEGER NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_invoice ON reminders (invoice_id);
  `,,
  `ALTER TABLE invoices ADD COLUMN promise_date TEXT;`
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { invoices: 5, emails: 10 }, blurb: 'Try it on your real overdue invoices.', features: ['All reminder stages', 'Client payment page'] },
  starter: { label: 'Starter', price: { INR: 999, USD: 29 }, limits: { invoices: 50, emails: 300 }, blurb: 'For freelancers and small agencies.', features: ['CSV import & export', 'Aging report'] },
  pro: { label: 'Pro', price: { INR: 2499, USD: 59 }, limits: { invoices: 300, emails: 2000 }, featured: true, blurb: 'For teams chasing dozens of clients.', features: ['Everything in Starter', 'Priority support'] },
  business: { label: 'Business', price: { INR: 4999, USD: 99 }, limits: { invoices: 2000, emails: 10000 }, blurb: 'For distributors and busy finance teams.', features: ['Everything in Pro', 'Onboarding call'] },
};

const hourIn = (tz, ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms));
const loadSettings = (app, user) => {
  let saved = {};
  try {
    saved = JSON.parse(user.settings || '{}');
  } catch {
    /* defaults */
  }
  return { ...app.config.settingsDefaults, ...saved };
};

const STATUS_TONE = { overdue: 'bad', due_today: 'warn', upcoming: 'info', paid: 'good', void: 'neutral' };
const STATUS_LABEL = { overdue: 'Overdue', due_today: 'Due today', upcoming: 'Upcoming', paid: 'Paid', void: 'Void' };

export function createDunningDesk(options = {}) {
  const app = createApp({
    slug: 'dunningdesk',
    name: 'DunningDesk',
    tagline: 'Get paid on time without awkward emails',
    accent: '#b8f23b',
    glyph: 'invoice',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/invoices', label: 'Invoices' },
      { href: '/import', label: 'Import' },
      { href: '/settings', label: 'Settings' },
    ],
    plans: PLANS,
    limitLabels: { invoices: 'open invoices', emails: 'reminder emails / month' },
    migrations: MIGRATIONS,
    settingsDefaults: {
      business_name: '',
      reply_to: '',
      signoff: '',
      payment_instructions: '',
      late_fee_note: '',
      auto_send: true,
      enabled_stages: DEFAULT_STAGES,
      min_gap_days: 4,
    },
    usage: (db, user) => ({
      invoices: db.get(`SELECT COUNT(*) AS n FROM invoices WHERE user_id = ? AND status = 'open'`, user.id).n,
      emails: app.mailer.sentThisMonth(user.id),
    }),
    marketing: {
      preview: { chartTitle: 'Receivables aging', ringTitle: 'Collected after reminders', bars: [{ label: 'Current', value: 142 }, { label: '1–30d', value: 86 }, { label: '31–60d', value: 41 }, { label: '61–90d', value: 18 }, { label: '90d+', value: 9 }], ring: { value: 64, text: '64%', label: 'recovered', note: 'of overdue value paid after a reminder' }, kpis: [{ label: 'Outstanding', value: '₹12.8L', delta: '31 invoices' }, { label: 'Overdue', value: '₹4.1L', delta: '−12% vs last month', deltaTone: 'good' }, { label: 'Avg days paid late', value: '9d', delta: '−3d', deltaTone: 'good' }] },
      audience: 'For agencies, consultants and distributors',
      headline: 'Late invoices chased for you — politely, on schedule.',
      sub: 'DunningDesk sends the right reminder at the right time, stops the moment a client pays, and shows exactly how much cash it helped you collect.',
      points: [
        { title: 'Escalating, human reminders', body: 'Six ready-made stages from a friendly heads-up to a final notice. The first email is always polite, however late the invoice is.' },
        { title: 'Clients pay faster', body: 'Every email links to a clean invoice page with your payment details, a pay button, and an “I’ve already paid” button that pauses reminders.' },
        { title: 'See the cash you recovered', body: 'Aging report, top overdue clients, and “collected after a reminder” — so the subscription pays for itself in plain numbers.' },
      ],
      steps: [
        { title: 'Paste or import your invoices', body: 'Export a CSV from Tally, Zoho, QuickBooks, Excel — whatever you use. Columns are recognised automatically.' },
        { title: 'Pick your reminder stages', body: 'Keep the defaults or switch stages off. Emails go out in your time zone, during business hours.' },
        { title: 'Watch the invoices turn green', body: 'Mark paid, or let clients tell you. Reminders stop instantly.' },
      ],
      faq: [
        { q: 'Which email address do reminders come from?', a: 'They are sent through our mail service with your business name, and replies go straight to your own inbox.' },
        { q: 'Will it spam my clients?', a: 'No. Only the most recent applicable stage is sent, with a minimum gap between emails, and nothing is sent once an invoice is paid or paused.' },
        { q: 'Does it work with GST / USD invoices?', a: 'Yes — amounts are stored per invoice in any major currency and formatted correctly (₹1,23,456 or $123,456).' },
      ],
    },
    ...options,
  });

  const { db } = app;

  // ---- helpers ------------------------------------------------------------
  const getInvoice = (ctx, id) => {
    const inv = db.get('SELECT * FROM invoices WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    return inv;
  };
  const openCount = (userId) => db.get(`SELECT COUNT(*) AS n FROM invoices WHERE user_id = ? AND status = 'open'`, userId).n;
  const payUrl = (inv) => app.publicUrl(`/pay/${inv.public_token}`);
  const money = (inv) => formatMoney(inv.amount, inv.currency);

  /** Send one reminder email and record it. */
  async function sendReminder(user, settings, inv, stageIdx, { manual = false, today } = {}) {
    if (!isEmail(inv.client_email)) return { ok: false, reason: 'no_email' };
    const limit = app.limitFor(app.planFor(user), 'emails');
    if (app.mailer.sentThisMonth(user.id) >= limit) return { ok: false, reason: 'limit' };
    const t = app.now();
    const vars = reminderVars({ inv, today: today ?? todayIn(user.timezone, t), settings, user, payUrl: payUrl(inv) });
    const { subject, body } = renderReminder(stageIdx, vars);
    const result = await app.mailer.send({
      userId: user.id,
      to: inv.client_email,
      subject,
      text: body,
      replyTo: isEmail(settings.reply_to) ? settings.reply_to : user.email,
      fromName: vars.business,
    });
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    db.tx(() => {
      db.run(
        'UPDATE invoices SET last_stage = MAX(COALESCE(last_stage, -1), ?), last_reminder_at = ? WHERE id = ?',
        stageIdx,
        t,
        inv.id,
      );
      db.run(
        'INSERT INTO reminders (invoice_id, user_id, stage, to_email, subject, body, manual, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        inv.id,
        user.id,
        stageIdx,
        inv.client_email,
        subject,
        body,
        manual ? 1 : 0,
        t,
      );
    });
    return { ok: true };
  }

  /** Send every due reminder. Scheduled runs respect each account's local business hours. */
  async function runReminders({ userId = null, force = false } = {}) {
    const users = userId ? db.all('SELECT * FROM users WHERE id = ?', userId) : db.all('SELECT * FROM users');
    const summary = { sent: 0, failed: 0, skippedLimit: 0, noEmail: 0 };
    const t = app.now();
    for (const user of users) {
      const settings = loadSettings(app, user);
      if (!force && !settings.auto_send) continue;
      if (!force) {
        const h = hourIn(user.timezone, t);
        if (h < 8 || h >= 19) continue;
      }
      const today = todayIn(user.timezone, t);
      const invoices = db.all(`SELECT * FROM invoices WHERE user_id = ? AND status = 'open'`, user.id);
      for (const inv of invoices) {
        const stage = nextStage(inv, today, settings.enabled_stages, { nowMs: t, minGapDays: settings.min_gap_days });
        if (stage === null) continue;
        const r = await sendReminder(user, settings, inv, stage, { today });
        if (r.ok) summary.sent++;
        else if (r.reason === 'limit') summary.skippedLimit++;
        else if (r.reason === 'no_email') summary.noEmail++;
        else summary.failed++;
      }
    }
    return summary;
  }
  app.runReminders = runReminders;
  app.job('reminders', 30 * 60 * 1000, () => runReminders());

  // ---- dashboard -----------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const today = ctx.today();
    const all = db.all('SELECT * FROM invoices WHERE user_id = ?', ctx.user.id);
    if (!all.length) {
      return ctx.page(
        'Dashboard',
        html`${pageHeader('Dashboard')}${emptyState(
          'Add your first invoices',
          'Paste a CSV exported from your accounting tool, or add an invoice by hand. Reminders start going out automatically.',
          html`<p><a class="btn btn-primary" href="/import">Import invoices</a> <a class="btn" href="/invoices/new">Add one invoice</a></p>`,
        )}`,
      );
    }
    const summary = summarize(all, today);
    const aging = agingBuckets(all, today);
    const settings = ctx.settings;
    const due = all.filter((i) => nextStage(i, today, settings.enabled_stages, { nowMs: ctx.now(), minGapDays: settings.min_gap_days }) !== null);
    const noEmail = all.filter((i) => i.status === 'open' && !isEmail(i.client_email) && daysOverdue(i, today) > -3).length;
    const sent = app.mailer.sentThisMonth(ctx.user.id);
    const emailLimit = ctx.limit('emails');
    const debtors = topDebtors(all, today);

    const blocks = Object.entries(summary).map(
      ([cur, s]) => html`<h2 class="section-title">${cur} receivables</h2>${statGrid([
        { label: 'Outstanding', value: formatMoney(s.outstanding, cur) },
        { label: 'Overdue', value: formatMoney(s.overdue, cur), tone: s.overdue ? 'bad' : '', hint: `${s.overdueCount} invoice${s.overdueCount === 1 ? '' : 's'}` },
        { label: 'Due in 7 days', value: formatMoney(s.dueSoon, cur) },
        { label: 'Collected this month', value: formatMoney(s.collectedMonth, cur), tone: 'good' },
        { label: 'Collected after a reminder', value: formatMoney(s.collectedAfterReminder, cur), tone: 'good', hint: 'all time' },
        { label: 'Avg. days paid late', value: s.avgDelay === null ? '—' : `${s.avgDelay}d`, hint: 'last 90 days' },
      ])}`,
    );

    return ctx.page(
      'Dashboard',
      html`${pageHeader(
        'Dashboard',
        due.length
          ? html`<form method="post" action="/reminders/run">${csrfField(ctx)}<button class="btn btn-primary" type="submit">Send ${due.length} due reminder${due.length === 1 ? '' : 's'} now</button></form>`
          : '',
        settings.auto_send ? 'Auto-send is on: reminders go out in your local business hours.' : 'Auto-send is off: reminders wait for you to send them.',
      )}
      ${sent >= emailLimit ? html`<div class="flash flash-err">You have used all ${emailLimit} reminder emails on the ${ctx.planInfo.label} plan this month. <a href="/billing">Upgrade</a> to keep chasing.</div>` : ''}
      ${noEmail ? html`<div class="flash flash-err">${noEmail} open invoice${noEmail === 1 ? ' has' : 's have'} no valid client email, so no reminders can be sent. <a href="/invoices?filter=open">Review</a></div>` : ''}
      ${blocks}
      ${Object.entries(aging).slice(0, 1).map(([cur, a]) => html`<div class="viz">${card(`Receivables aging (${cur})`, vbars({ height: 170, format: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)), items: Object.keys(BUCKET_LABELS).map((k) => ({ label: BUCKET_LABELS[k].replace(' days', 'd').replace('Not yet due', 'Current'), value: Math.round(a[k].total / 100), tone: k === 'd61_90' || k === 'd90' ? 'bad' : k === 'd31_60' ? 'warn' : '' })) }))}${card('Overdue share', html`${ring({ value: summary[cur].overdue, max: summary[cur].outstanding || 1, text: `${summary[cur].outstanding ? Math.round((summary[cur].overdue / summary[cur].outstanding) * 100) : 0}%`, label: 'of outstanding' })}<p class="muted center">${formatMoney(summary[cur].collectedAfterReminder, cur)} collected after reminders</p>`, { className: 'ring-card' })}</div>`)}
      <div class="grid-2">
        ${card(
          'Aging',
          html`${Object.entries(aging).map(
            ([cur, a]) => html`<p class="muted">${cur}</p>${table({
              columns: [
                { label: 'Bucket', render: (r) => BUCKET_LABELS[r.k] },
                { label: 'Invoices', align: 'right', render: (r) => r.n },
                { label: 'Amount', align: 'right', render: (r) => formatMoney(r.total, cur) },
              ],
              rows: Object.keys(BUCKET_LABELS).map((k) => ({ k, ...a[k] })),
            })}`,
          )}`,
        )}
        ${card(
          'Biggest overdue clients',
          table({
            columns: [
              { label: 'Client', render: (r) => r.client },
              { label: 'Invoices', align: 'right', render: (r) => r.count },
              { label: 'Oldest', align: 'right', render: (r) => `${r.oldest}d` },
              { label: 'Owed', align: 'right', render: (r) => formatMoney(r.total, r.currency) },
            ],
            rows: debtors,
            empty: 'Nothing overdue. Nice.',
          }),
        )}
      </div>`,
    );
  });

  app.post('/reminders/run', async (ctx) => {
    const r = await runReminders({ userId: ctx.user.id, force: true });
    const parts = [`${r.sent} sent`];
    if (r.skippedLimit) parts.push(`${r.skippedLimit} held back by your plan's email limit`);
    if (r.noEmail) parts.push(`${r.noEmail} without a client email`);
    if (r.failed) parts.push(`${r.failed} failed`);
    return redirect('/dashboard', { ok: `Reminders: ${parts.join(', ')}.` });
  });

  // ---- invoices -----------------------------------------------------------
  const FILTERS = [
    ['open', 'Open'],
    ['overdue', 'Overdue'],
    ['paid', 'Paid'],
    ['all', 'All'],
  ];

  app.get('/invoices', (ctx) => {
    const today = ctx.today();
    const filter = FILTERS.some(([k]) => k === ctx.query.filter) ? ctx.query.filter : 'open';
    const q = clean(ctx.query.q, 80).toLowerCase();
    let rows = db.all('SELECT * FROM invoices WHERE user_id = ? ORDER BY due_date ASC, id ASC LIMIT 2000', ctx.user.id);
    rows = rows.filter((i) => {
      const st = statusOf(i, today);
      if (filter === 'open' && !['upcoming', 'due_today', 'overdue'].includes(st)) return false;
      if (filter === 'overdue' && st !== 'overdue') return false;
      if (filter === 'paid' && st !== 'paid') return false;
      return !q || i.client_name.toLowerCase().includes(q) || i.number.toLowerCase().includes(q);
    });
    if (filter === 'paid') rows.reverse();
    const shown = rows.slice(0, 300);
    return ctx.page(
      'Invoices',
      html`${pageHeader('Invoices', html`<a class="btn" href="/invoices.csv">Export CSV</a><a class="btn btn-primary" href="/invoices/new">Add invoice</a>`)}
      <div class="pill-row">${FILTERS.map(([k, l]) => html`<a href="/invoices?filter=${k}" class="${k === filter ? 'active' : ''}">${l}</a>`)}</div>
      <form method="get" action="/invoices" class="inline-form" style="margin-bottom:1rem"><input type="hidden" name="filter" value="${filter}"><input type="text" name="q" value="${q}" placeholder="Search client or number"><button class="btn" type="submit">Search</button></form>
      ${card(
        '',
        table({
          columns: [
            { label: 'Invoice', render: (i) => html`<a href="/invoices/${i.id}"><strong>${i.number}</strong></a>` },
            { label: 'Client', render: (i) => html`${i.client_name}${isEmail(i.client_email) ? '' : html`<span class="sub">no email</span>`}` },
            { label: 'Amount', align: 'right', render: (i) => money(i) },
            {
              label: 'Due',
              render: (i) => {
                const st = statusOf(i, today);
                const late = daysOverdue(i, today);
                return html`${formatDate(i.due_date)} ${badge(st === 'overdue' ? `${late}d overdue` : STATUS_LABEL[st], STATUS_TONE[st])}`;
              },
            },
            {
              label: 'Reminders',
              render: (i) =>
                i.claimed_paid_at && i.status === 'open'
                  ? badge('Client says paid', 'warn')
                  : i.promise_date && i.promise_date >= today && i.status === 'open'
                    ? badge(`Promised ${formatDate(i.promise_date)}`, 'info')
                  : i.reminders_paused
                    ? badge('Paused', 'neutral')
                    : i.last_stage !== null && i.status !== 'void'
                      ? html`<span class="muted">${STAGES[i.last_stage].label.split(',')[0]}</span>`
                      : html`<span class="muted">—</span>`,
            },
          ],
          rows: shown,
          empty: q ? 'No invoices match your search.' : 'No invoices here yet.',
        }),
      )}
      ${rows.length > shown.length ? html`<p class="muted">Showing the first ${shown.length} of ${rows.length}. Use search to narrow down.</p>` : ''}`,
    );
  });

  app.get('/invoices.csv', (ctx) => {
    const rows = db.all('SELECT * FROM invoices WHERE user_id = ? ORDER BY due_date', ctx.user.id);
    const today = ctx.today();
    return download(
      'invoices.csv',
      toCsv(rows, [
        { key: 'number', label: 'number' },
        { key: 'client_name', label: 'client' },
        { key: 'client_email', label: 'email' },
        { label: 'amount', value: (r) => r.amount / 100 },
        { key: 'currency', label: 'currency' },
        { key: 'issue_date', label: 'issue_date' },
        { key: 'due_date', label: 'due_date' },
        { label: 'status', value: (r) => statusOf(r, today) },
        { key: 'paid_on', label: 'paid_on' },
      ]),
    );
  });

  const invoiceForm = (ctx, inv = {}, error = '') =>
    html`${error ? html`<div class="flash flash-err">${error}</div>` : ''}
    <form method="post" action="${inv.id ? `/invoices/${inv.id}/edit` : '/invoices'}">${csrfField(ctx)}
      <div class="row">
        ${field({ label: 'Invoice number', name: 'number', value: inv.number ?? '', required: true })}
        ${field({ label: 'Client name', name: 'client_name', value: inv.client_name ?? '', required: true })}
        ${field({ label: 'Client email', name: 'client_email', type: 'email', value: inv.client_email ?? '', help: 'Needed to send reminders.' })}
      </div>
      <div class="row">
        ${field({ label: 'Amount', name: 'amount', value: inv.amount ? inv.amount / 100 : '', required: true, attrs: { inputmode: 'decimal' } })}
        ${field({ label: 'Currency', name: 'currency', type: 'select', options: CURRENCIES, value: inv.currency ?? ctx.user.currency })}
        ${field({ label: 'Issue date', name: 'issue_date', type: 'date', value: inv.issue_date ?? '' })}
        ${field({ label: 'Due date', name: 'due_date', type: 'date', value: inv.due_date ?? '', required: true })}
      </div>
      ${field({ label: 'Online payment link (optional)', name: 'pay_link', type: 'url', value: inv.pay_link ?? '', help: 'Razorpay / Stripe / PayPal link shown in every reminder.' })}
      ${field({ label: 'Private notes', name: 'notes', type: 'textarea', value: inv.notes ?? '' })}
      <button class="btn btn-primary" type="submit">${inv.id ? 'Save changes' : 'Add invoice'}</button>
    </form>`;

  function readInvoiceForm(ctx) {
    const b = ctx.body;
    const amount = parseAmount(b.amount);
    const dayFirst = ctx.user.currency === 'INR';
    const due = isISODate(b.due_date) ? b.due_date : parseDateLoose(b.due_date, { dayFirst });
    const issue = b.issue_date ? (isISODate(b.issue_date) ? b.issue_date : parseDateLoose(b.issue_date, { dayFirst })) : null;
    const email = String(b.client_email ?? '').trim().toLowerCase();
    const v = {
      number: clean(b.number, 60),
      client_name: clean(b.client_name, 120),
      client_email: email,
      amount: toMinor(amount),
      currency: CURRENCIES.includes(b.currency) ? b.currency : ctx.user.currency,
      issue_date: issue,
      due_date: due,
      pay_link: safeUrl(String(b.pay_link ?? '').trim()).startsWith('http') ? clean(b.pay_link, 500) : '',
      notes: clean(b.notes, 1000),
    };
    let error = '';
    if (!v.number || !v.client_name) error = 'Invoice number and client name are required.';
    else if (!Number.isFinite(amount) || amount <= 0) error = 'Enter an amount greater than zero.';
    else if (!due) error = 'Enter a valid due date.';
    else if (email && !isEmail(email)) error = 'That client email does not look valid.';
    return { v, error };
  }

  app.get('/invoices/new', (ctx) => ctx.page('Add invoice', html`${pageHeader('Add invoice')}${card('', invoiceForm(ctx))}`));

  app.post('/invoices', (ctx) => {
    const { v, error } = readInvoiceForm(ctx);
    if (error) return ctx.page('Add invoice', html`${pageHeader('Add invoice')}${card('', invoiceForm(ctx, v, error))}`, { status: 400 });
    const limitMsg = ctx.checkLimit('invoices', openCount(ctx.user.id));
    if (limitMsg) return redirect('/invoices', { err: limitMsg });
    if (db.get('SELECT 1 AS x FROM invoices WHERE user_id = ? AND number = ?', ctx.user.id, v.number)) {
      return ctx.page('Add invoice', html`${pageHeader('Add invoice')}${card('', invoiceForm(ctx, v, `Invoice ${v.number} already exists.`))}`, { status: 400 });
    }
    const id = db.run(
      `INSERT INTO invoices (user_id, number, client_name, client_email, amount, currency, issue_date, due_date, pay_link, notes, public_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.user.id, v.number, v.client_name, v.client_email, v.amount, v.currency, v.issue_date, v.due_date, v.pay_link, v.notes, randomToken(16), ctx.now(),
    ).id;
    return redirect(`/invoices/${id}`, { ok: 'Invoice added.' });
  });

  app.get('/invoices/:id', (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    const today = ctx.today();
    const st = statusOf(inv, today);
    const history = db.all('SELECT * FROM reminders WHERE invoice_id = ? ORDER BY sent_at DESC', inv.id);
    const stage = nextStage(inv, today, ctx.settings.enabled_stages, { nowMs: ctx.now(), minGapDays: ctx.settings.min_gap_days });
    const post = (action, label, cls = 'btn', extra = '') => html`<form method="post" action="/invoices/${inv.id}/${action}" class="inline" ${raw(extra)}>${csrfField(ctx)}<button class="${cls}" type="submit">${label}</button></form>`;
    return ctx.page(
      `Invoice ${inv.number}`,
      html`${pageHeader(
        html`Invoice ${inv.number} ${badge(STATUS_LABEL[st], STATUS_TONE[st])}`,
        inv.status === 'open'
          ? html`${post('paid', 'Mark paid', 'btn btn-primary')}${inv.reminders_paused ? post('resume', 'Resume reminders') : post('pause', 'Pause reminders')}`
          : inv.status === 'paid'
            ? post('reopen', 'Reopen')
            : post('reopen', 'Reopen'),
        `${inv.client_name} · ${money(inv)} · due ${formatDate(inv.due_date)}${st === 'overdue' ? ` (${daysOverdue(inv, today)} days overdue)` : ''}`,
      )}
      ${inv.claimed_paid_at && inv.status === 'open' ? html`<div class="flash flash-ok">${inv.client_name} says they've paid. Check your bank, then mark it paid. Reminders are paused.</div>` : ''}
      <div class="grid-2">
        ${card('Send a reminder', inv.status !== 'open'
          ? html`<p class="muted">This invoice is ${inv.status}; no reminders will be sent.</p>`
          : html`<p class="muted">${stage !== null ? html`Next automatic reminder: <strong>${STAGES[stage].label}</strong>.` : 'No automatic reminder is due right now.'}</p>
            ${isEmail(inv.client_email) ? '' : html`<p class="flash flash-err">Add a client email below to send reminders.</p>`}
            <form method="post" action="/invoices/${inv.id}/remind" class="inline-form">${csrfField(ctx)}
              <select name="stage">${STAGES.map((s, i) => html`<option value="${i}" ${i === (stage ?? Math.min(2, STAGES.length - 1)) ? 'selected' : ''}>${s.label}</option>`)}</select>
              <button class="btn" type="submit">Send now</button>
            </form>
            <p class="help">Public invoice page: <a href="/pay/${inv.public_token}" target="_blank" rel="noopener">${payUrl(inv)}</a></p>`)}
        ${card('Reminder history', table({
          columns: [
            { label: 'Sent', render: (r) => new Date(r.sent_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' },
            { label: 'Stage', render: (r) => STAGES[r.stage].label },
            { label: '', render: (r) => (r.manual ? badge('manual', 'neutral') : '') },
          ],
          rows: history,
          empty: 'No reminders sent yet.',
        }))}
      </div>
      ${inv.status === 'open' ? card('Promise to pay', html`
        <p class="muted">${inv.promise_date ? html`Client promised to pay by <strong>${formatDate(inv.promise_date)}</strong>. Reminders are on hold until then${inv.promise_date < today ? ' — the date has passed, so they have resumed' : ''}.` : 'If the client gives you a date, record it. Reminders pause until that day, and resume automatically if it is missed.'}</p>
        <form method="post" action="/invoices/${inv.id}/promise" class="inline-form">${csrfField(ctx)}<input type="date" name="date" value="${inv.promise_date ?? ''}" min="${today}" required><button class="btn" type="submit">${inv.promise_date ? 'Update date' : 'Record promise'}</button></form>
        ${inv.promise_date ? post('promise-clear', 'Clear promise', 'btn btn-sm') : ''}`) : ''}
      ${card('Details', invoiceForm(ctx, inv))}
      ${post('delete', 'Delete invoice', 'btn btn-danger', 'data-confirm="Delete this invoice and its history?"')}`,
    );
  });

  app.post('/invoices/:id/edit', (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    const { v, error } = readInvoiceForm(ctx);
    if (error) return redirect(`/invoices/${inv.id}`, { err: error });
    if (v.number !== inv.number && db.get('SELECT 1 AS x FROM invoices WHERE user_id = ? AND number = ?', ctx.user.id, v.number)) {
      return redirect(`/invoices/${inv.id}`, { err: `Invoice ${v.number} already exists.` });
    }
    db.run(
      `UPDATE invoices SET number = ?, client_name = ?, client_email = ?, amount = ?, currency = ?, issue_date = ?, due_date = ?, pay_link = ?, notes = ? WHERE id = ?`,
      v.number, v.client_name, v.client_email, v.amount, v.currency, v.issue_date, v.due_date, v.pay_link, v.notes, inv.id,
    );
    return redirect(`/invoices/${inv.id}`, { ok: 'Saved.' });
  });

  app.post('/invoices/:id/paid', (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    db.run(`UPDATE invoices SET status = 'paid', paid_on = ?, paid_after_reminder = ? WHERE id = ?`, ctx.today(), inv.last_stage === null ? 0 : 1, inv.id);
    return redirect(`/invoices/${inv.id}`, { ok: 'Marked paid — reminders stopped.' });
  });
  app.post('/invoices/:id/reopen', (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    const limitMsg = ctx.checkLimit('invoices', openCount(ctx.user.id));
    if (limitMsg) return redirect(`/invoices/${inv.id}`, { err: limitMsg });
    db.run(`UPDATE invoices SET status = 'open', paid_on = NULL, paid_after_reminder = 0, claimed_paid_at = NULL WHERE id = ?`, inv.id);
    return redirect(`/invoices/${inv.id}`, { ok: 'Invoice reopened.' });
  });
  app.post('/invoices/:id/pause', (ctx) => {
    db.run('UPDATE invoices SET reminders_paused = 1 WHERE id = ? AND user_id = ?', getInvoice(ctx, ctx.params.id).id, ctx.user.id);
    return redirect(`/invoices/${ctx.params.id}`, { ok: 'Reminders paused.' });
  });
  app.post('/invoices/:id/resume', (ctx) => {
    db.run('UPDATE invoices SET reminders_paused = 0, claimed_paid_at = NULL WHERE id = ? AND user_id = ?', getInvoice(ctx, ctx.params.id).id, ctx.user.id);
    return redirect(`/invoices/${ctx.params.id}`, { ok: 'Reminders resumed.' });
  });
  app.post('/invoices/:id/promise', (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    const today = ctx.today();
    const d = String(ctx.body.date ?? '');
    if (!isISODate(d) || d < today || d > addDays(today, 90)) return redirect(`/invoices/${inv.id}`, { err: 'Choose a date between today and 90 days from now.' });
    db.run('UPDATE invoices SET promise_date = ? WHERE id = ?', d, inv.id);
    return redirect(`/invoices/${inv.id}`, { ok: `Promise recorded. Reminders are on hold until ${formatDate(d)}.` });
  });
  app.post('/invoices/:id/promise-clear', (ctx) => {
    db.run('UPDATE invoices SET promise_date = NULL WHERE id = ? AND user_id = ?', getInvoice(ctx, ctx.params.id).id, ctx.user.id);
    return redirect(`/invoices/${ctx.params.id}`, { ok: 'Promise cleared.' });
  });
  app.post('/invoices/:id/delete', (ctx) => {
    db.run('DELETE FROM invoices WHERE id = ? AND user_id = ?', getInvoice(ctx, ctx.params.id).id, ctx.user.id);
    return redirect('/invoices', { ok: 'Invoice deleted.' });
  });

  app.post('/invoices/:id/remind', async (ctx) => {
    const inv = getInvoice(ctx, ctx.params.id);
    const idx = Number(ctx.body.stage);
    if (!Number.isInteger(idx) || idx < 0 || idx >= STAGES.length) return redirect(`/invoices/${inv.id}`, { err: 'Pick a reminder stage.' });
    if (inv.status !== 'open') return redirect(`/invoices/${inv.id}`, { err: 'Only open invoices can be chased.' });
    const r = await sendReminder(ctx.user, ctx.settings, inv, idx, { manual: true, today: ctx.today() });
    if (r.ok) return redirect(`/invoices/${inv.id}`, { ok: `Reminder sent to ${inv.client_email}.` });
    const why = { no_email: 'Add a valid client email first.', limit: `You've used this month's email allowance (${ctx.limit('emails')}). Upgrade to send more.`, send_failed: `The email could not be sent (${r.error}).` }[r.reason];
    return redirect(`/invoices/${inv.id}`, { err: why });
  });

  // ---- import -------------------------------------------------------------
  const importForm = (ctx, extra = '', text = '') =>
    ctx.page(
      'Import invoices',
      html`${pageHeader('Import invoices', '', 'Paste a CSV or choose a file. Re-importing the same invoice number updates it instead of duplicating it.')}
      ${extra}
      ${card('', html`<form method="post" action="/import">${csrfField(ctx)}
        <p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#csv"></p>
        ${field({ label: 'CSV data', name: 'csv', type: 'textarea', value: text, rows: 12, id: 'csv', placeholder: 'invoice,client,email,amount,due_date\nINV-1001,Acme Ltd,accounts@acme.com,12500,2026-10-30', attrs: { class: 'mono' }, required: true })}
        <p class="help">Recognised columns: invoice / number, client / customer, email, amount / total / balance, currency, due_date, issue_date, pay_link, status. Dates like 2026-10-30, 30/10/2026 and 30-Oct-2026 all work.</p>
        <button class="btn btn-primary" type="submit">Import</button>
      </form>`)}`,
    );

  app.get('/import', (ctx) => importForm(ctx));

  app.post('/import', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    let parsed;
    try {
      parsed = parseInvoiceCsv(text, { dayFirst: ctx.user.currency === 'INR', defaultCurrency: ctx.user.currency });
    } catch (err) {
      return importForm(ctx, html`<div class="flash flash-err">${err.message}</div>`, text);
    }
    if (parsed.missing.length) {
      return importForm(ctx, html`<div class="flash flash-err">Missing required column${parsed.missing.length > 1 ? 's' : ''}: ${parsed.missing.join(', ')}. Add a header row naming them.</div>`, text);
    }
    const t = ctx.now();
    let created = 0;
    let updated = 0;
    let overLimit = 0;
    let paidSkipped = 0;
    db.tx(() => {
      let open = openCount(ctx.user.id);
      const limit = ctx.limit('invoices');
      for (const r of parsed.rows) {
        const existing = db.get('SELECT id, status FROM invoices WHERE user_id = ? AND number = ?', ctx.user.id, r.number);
        if (existing) {
          if (existing.status === 'open') {
            db.run(
              `UPDATE invoices SET client_name = ?, client_email = CASE WHEN ? != '' THEN ? ELSE client_email END, amount = ?, currency = ?, due_date = ?,
               issue_date = COALESCE(?, issue_date), pay_link = CASE WHEN ? != '' THEN ? ELSE pay_link END WHERE id = ?`,
              r.client_name, r.client_email, r.client_email, r.amount, r.currency, r.due_date, r.issue_date, r.pay_link, r.pay_link, existing.id,
            );
            updated++;
          } else paidSkipped++;
          continue;
        }
        if (!r.paid && open + 1 > limit) {
          overLimit++;
          continue;
        }
        db.run(
          `INSERT INTO invoices (user_id, number, client_name, client_email, amount, currency, issue_date, due_date, pay_link, status, paid_on, public_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.user.id, r.number, r.client_name, r.client_email, r.amount, r.currency, r.issue_date, r.due_date, r.pay_link,
          r.paid ? 'paid' : 'open', r.paid ? r.due_date : null, randomToken(16), t,
        );
        if (!r.paid) open++;
        created++;
      }
    });
    const notes = [];
    if (overLimit) notes.push(`${overLimit} skipped because your ${ctx.planInfo.label} plan allows ${ctx.limit('invoices')} open invoices — upgrade on the Billing page`);
    if (paidSkipped) notes.push(`${paidSkipped} already paid`);
    const msg = `Imported ${created} new, updated ${updated}${notes.length ? `; ${notes.join('; ')}` : ''}.`;
    if (parsed.errors.length) {
      return importForm(
        ctx,
        html`<div class="flash flash-ok">${msg}</div>${card(
          `${parsed.errors.length} row${parsed.errors.length === 1 ? '' : 's'} need attention`,
          table({ columns: [{ label: 'Line', render: (e) => e.line }, { label: 'Problem', render: (e) => e.message }], rows: parsed.errors.slice(0, 100) }),
        )}`,
      );
    }
    return redirect('/invoices', { ok: msg });
  }, { maxBody: 5 * 1024 * 1024 });

  // ---- settings -----------------------------------------------------------
  app.get('/settings', (ctx) => {
    const s = ctx.settings;
    return ctx.page(
      'Settings',
      html`${pageHeader('Settings')}
      <form method="post" action="/settings">${csrfField(ctx)}
        ${card('Your business', html`
          ${field({ label: 'Business name shown to clients', name: 'business_name', value: s.business_name, placeholder: ctx.user.name })}
          ${field({ label: 'Reply-to email', name: 'reply_to', type: 'email', value: s.reply_to, placeholder: ctx.user.email, help: 'Client replies land here. Defaults to your login email.' })}
          ${field({ label: 'Email sign-off', name: 'signoff', value: s.signoff, placeholder: s.business_name || ctx.user.name })}
          ${field({ label: 'Payment instructions', name: 'payment_instructions', type: 'textarea', value: s.payment_instructions, rows: 4, help: 'Bank account / UPI ID / wire details. Shown in emails and on the client’s invoice page.' })}
          ${field({ label: 'Late fee note (optional)', name: 'late_fee_note', value: s.late_fee_note, help: 'Added to overdue reminders, e.g. “A late fee of 1.5% per month applies after 30 days.”' })}
        `)}
        ${card('Reminder schedule', html`
          ${field({ label: 'Send reminders automatically', name: 'auto_send', type: 'checkbox', value: s.auto_send, help: 'Emails go out between 8am and 7pm in your time zone.' })}
          <p><strong>Stages</strong></p>
          ${STAGES.map((st) => html`<label class="check"><input type="checkbox" name="stages[]" value="${st.key}" ${s.enabled_stages.includes(st.key) ? 'checked' : ''}> <span>${st.label}</span></label>`)}
          ${field({ label: 'Minimum days between emails', name: 'min_gap_days', type: 'number', value: s.min_gap_days, attrs: { min: 1, max: 30 } })}
        `)}
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>`,
    );
  });

  app.post('/settings', (ctx) => {
    const b = ctx.body;
    const gap = Math.min(30, Math.max(1, Math.round(Number(b.min_gap_days)) || 4));
    ctx.saveSettings({
      business_name: clean(b.business_name, 100),
      reply_to: isEmail(String(b.reply_to ?? '').trim().toLowerCase()) ? String(b.reply_to).trim().toLowerCase() : '',
      signoff: clean(b.signoff, 100),
      payment_instructions: clean(b.payment_instructions, 800),
      late_fee_note: clean(b.late_fee_note, 300),
      auto_send: b.auto_send === '1',
      enabled_stages: toArray(b.stages).filter((k) => DEFAULT_STAGES.includes(k)),
      min_gap_days: gap,
    });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  // ---- public client page -------------------------------------------------
  const publicInvoice = (token) => db.get('SELECT i.*, u.name AS owner_name, u.email AS owner_email, u.settings AS owner_settings, u.timezone AS owner_tz FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.public_token = ?', token);

  app.get('/pay/:token', (ctx) => {
    const inv = publicInvoice(ctx.params.token);
    if (!inv) throw new HttpError(404, 'This invoice link is not valid.');
    let s = {};
    try { s = JSON.parse(inv.owner_settings || '{}'); } catch { /* none */ }
    const business = s.business_name || inv.owner_name;
    const today = todayIn(inv.owner_tz, ctx.now());
    const st = statusOf(inv, today);
    return ctx.page(
      `Invoice ${inv.number} from ${business}`,
      html`<div class="auth-card card" style="max-width:560px">
        <p class="muted">${business}</p>
        <h1>Invoice ${inv.number}</h1>
        <p class="stat-value">${money(inv)}</p>
        <p>${badge(STATUS_LABEL[st], STATUS_TONE[st])} Due ${formatDate(inv.due_date)}</p>
        <p>Billed to <strong>${inv.client_name}</strong></p>
        ${inv.status === 'paid' ? html`<p>This invoice has been paid. Thank you!</p>` : html`
          ${s.payment_instructions ? html`<h3>How to pay</h3><div class="draft">${s.payment_instructions}</div>` : ''}
          ${safeUrl(inv.pay_link) ? html`<p><a class="btn btn-primary btn-lg" href="${safeUrl(inv.pay_link)}" rel="noopener">Pay online</a></p>` : ''}
          ${inv.claimed_paid_at ? html`<p class="flash flash-ok">Thanks — we've let ${business} know you've paid.</p>` : html`
            <form method="post" action="/pay/${inv.public_token}/paid"><button class="btn" type="submit">I've already paid</button></form>`}`}
        <p class="help">Questions? Reply to the email you received or contact ${inv.owner_email}.</p>
      </div>`,
      { noindex: true },
    );
  }, { public: true });

  app.post('/pay/:token/paid', async (ctx) => {
    const inv = publicInvoice(ctx.params.token);
    if (!inv) throw new HttpError(404, 'This invoice link is not valid.');
    if (!app.limiter.hit(`claim:${ctx.ip}`, 20, 3600e3, ctx.now()).ok) throw new HttpError(429, 'Too many requests');
    if (inv.status === 'open' && !inv.claimed_paid_at) {
      db.run('UPDATE invoices SET claimed_paid_at = ? WHERE id = ?', ctx.now(), inv.id);
      await app.mailer.send({
        userId: inv.user_id,
        to: inv.owner_email,
        subject: `${inv.client_name} says invoice ${inv.number} is paid`,
        text: `${inv.client_name} marked invoice ${inv.number} (${money(inv)}) as paid.\n\nReminders for it are paused. Please check your bank and mark it paid in DunningDesk: ${app.publicUrl(`/invoices/${inv.id}`)}`,
        fromName: 'DunningDesk',
        footer: false,
      });
    }
    return redirect(`/pay/${inv.public_token}`);
  }, { public: true, csrf: false });

  return app;
}
