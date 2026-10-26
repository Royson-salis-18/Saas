import {
  HttpError, badge, card, clean, createApp, csrfField, download, emptyState, field, formatDate, formatMoney, html, isEmail, raw, isISODate,
  pageHeader, parseAmount, parseDateLoose, redirect, ring, statGrid, table, toCsv, todayIn, toMinor, vbars, THEMES } from '@saas/core';
import { CYCLES, annualCost, noticeDeadline, nextReminder, nextRenewal, parseContractCsv, summarise, urgency } from './logic.js';

const MIGRATIONS = [
  `
  CREATE TABLE contracts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    vendor TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    cycle TEXT NOT NULL DEFAULT 'yearly',
    renewal_date TEXT NOT NULL,
    notice_days INTEGER NOT NULL DEFAULT 30,
    auto_renew INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT NOT NULL DEFAULT '',
    cancelled_on TEXT,
    reminder_for TEXT,
    reminder_level INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX contracts_user_status ON contracts (user_id, status, renewal_date);
  `,
];

export const PLANS = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { contracts: 8 }, blurb: 'Track your biggest renewals.', features: ['Email reminders', 'Annual spend view'] },
  starter: { label: 'Starter', price: { INR: 999, USD: 29 }, limits: { contracts: 40 }, blurb: 'For a small business or team.', features: ['CSV import & export', 'Spend by category'] },
  pro: { label: 'Pro', price: { INR: 2499, USD: 69 }, limits: { contracts: 200 }, featured: true, blurb: 'For growing companies and agencies.', features: ['Everything in Starter', 'Priority support'] },
  business: { label: 'Business', price: { INR: 4999, USD: 129 }, limits: { contracts: 1000 }, blurb: 'For finance and procurement teams.', features: ['Everything in Pro', 'Onboarding call'] },
};

const U_LABEL = { cancelled: 'Cancelled', lapsed: 'Update date', locked: 'Locked in', act: 'Decide now', soon: 'Renews soon', ok: 'On track' };
const U_TONE = { cancelled: 'neutral', lapsed: 'warn', locked: 'bad', act: 'bad', soon: 'warn', ok: 'good' };
const hourIn = (tz, ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms));

export function createRenewalRadar(options = {}) {
  const app = createApp({
    slug: 'renewalradar',
    name: 'RenewalRadar',
    tagline: 'Never miss a cancellation window again',
    accent: THEMES.renewalradar.accent,
    theme: THEMES.renewalradar,
    glyph: 'calendar',
    home: '/dashboard',
    nav: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/contracts', label: 'Contracts' },
      { href: '/contracts/new', label: 'Add contract' },
      { href: '/import', label: 'Import' },
      { href: '/settings', label: 'Settings' },
    ],
    plans: PLANS,
    limitLabels: { contracts: 'contracts & subscriptions' },
    migrations: MIGRATIONS,
    settingsDefaults: { lead_days: 14, alert_email: '' },
    usage: (db, user) => ({ contracts: db.get('SELECT COUNT(*) AS n FROM contracts WHERE user_id = ?', user.id).n }),
    marketing: {
      audience: 'For finance, operations and procurement teams',
      headline: 'Every renewal, every notice deadline, in one place.',
      sub: 'Software subscriptions, leases, insurance, AMCs. RenewalRadar tracks when each renews and — more importantly — when you must cancel by, then emails you before the window closes.',
      preview: { chartTitle: 'Yearly spend by category', ringTitle: 'Spend on auto-renew', bars: [{ label: 'Software', value: 412 }, { label: 'Rent', value: 540 }, { label: 'Insurance', value: 180 }, { label: 'Marketing', value: 126 }, { label: 'Services', value: 96 }], ring: { value: 71, text: '71%', label: 'auto-renews', note: '3 contracts have a cancellation deadline within 14 days' }, kpis: [{ label: 'Yearly commitments', value: '₹13.5L', delta: '38 contracts' }, { label: 'Renewing in 30 days', value: '₹2.1L', delta: '6 renewals', deltaTone: 'warn' }, { label: 'Need a decision', value: '3', delta: 'deadline ≤14 days', deltaTone: 'bad' }] },
      points: [
        { title: 'Deadlines, not just dates', body: 'The date that costs you money is the cancellation deadline. RenewalRadar tracks it from each contract’s notice period.' },
        { title: 'Reminders that arrive in time', body: 'Emails at 14 days, 3 days and on the deadline — once each — so nothing auto-renews by surprise.' },
        { title: 'See what you really commit to', body: 'Monthly, quarterly and yearly costs are annualised, grouped by category, and shown with how much auto-renews.' },
        { title: 'Savings you can point to', body: 'Cancel a contract and its yearly cost is counted as money saved.' },
      ],
      steps: [
        { title: 'Add or import contracts', body: 'Name, cost, billing cycle, renewal date and notice period.' },
        { title: 'Get reminded', body: 'Emails before each notice deadline, to you or a shared inbox.' },
        { title: 'Decide and update', body: 'Mark renewed to roll the date forward, or cancel and log the saving.' },
      ],
      faq: [
        { q: 'Does it cancel anything for me?', a: 'No. It reminds you and keeps the record; you cancel with the vendor.' },
        { q: 'Where do reminders go?', a: 'To your login email, or another address you set in Settings.' },
        { q: 'Is the cancellation deadline always right?', a: 'It is calculated from the notice period you enter. Check your contract for the exact terms.' },
      ],
    },
    ...options,
  });

  const { db } = app;
  const money = (ctx) => (m) => formatMoney(m, ctx.user.currency);
  const getContract = (ctx, id) => {
    const c = db.get('SELECT * FROM contracts WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    if (!c) throw new HttpError(404, 'Contract not found');
    return c;
  };

  // ---- reminders ----------------------------------------------------------------
  async function runReminders({ force = false } = {}) {
    const t = app.now();
    let sent = 0;
    for (const user of db.all('SELECT * FROM users')) {
      if (!force && (hourIn(user.timezone, t) < 8 || hourIn(user.timezone, t) >= 19)) continue;
      let s = {};
      try { s = JSON.parse(user.settings || '{}'); } catch { /* defaults */ }
      const lead = Math.min(60, Math.max(4, Number(s.lead_days) || 14));
      const to = isEmail(s.alert_email) ? s.alert_email : user.email;
      const today = todayIn(user.timezone, t);
      for (const c of db.all(`SELECT * FROM contracts WHERE user_id = ? AND status = 'active'`, user.id)) {
        const level = nextReminder(c, today, lead);
        if (level === null) continue;
        const deadline = noticeDeadline(c);
        const days = Math.round((Date.parse(deadline) - Date.parse(today)) / 86400000);
        const when = days > 0 ? `in ${days} day${days === 1 ? '' : 's'} (${formatDate(deadline)})` : days === 0 ? 'today' : 'already passed';
        const r = await app.mailer.send({
          userId: user.id, to, fromName: 'RenewalRadar', footer: false,
          subject: `${days <= 0 ? 'Deadline today' : `Cancellation deadline ${when}`}: ${c.name}`.slice(0, 150),
          text: `${c.name}${c.vendor ? ` (${c.vendor})` : ''} renews on ${formatDate(c.renewal_date)} for ${formatMoney(c.amount, user.currency)} ${CYCLES[c.cycle].label.toLowerCase()}.\nThe last day to cancel or renegotiate is ${formatDate(deadline)} — ${when}.\n${c.auto_renew ? 'It renews automatically unless you act.' : 'It does not renew automatically; decide whether to renew.'}\n\nOpen it: ${app.publicUrl(`/contracts/${c.id}`)}`,
        });
        if (r.ok) {
          db.run('UPDATE contracts SET reminder_for = ?, reminder_level = ? WHERE id = ?', c.renewal_date, level, c.id);
          sent++;
        }
      }
    }
    return sent;
  }
  app.runReminders = runReminders;
  app.job('reminders', 3_600_000, () => runReminders());

  // ---- dashboard -----------------------------------------------------------------
  app.get('/dashboard', (ctx) => {
    const today = ctx.today();
    const all = db.all('SELECT * FROM contracts WHERE user_id = ? ORDER BY renewal_date', ctx.user.id);
    const m = money(ctx);
    if (!all.length) return ctx.page('Dashboard', html`${pageHeader('Dashboard')}${emptyState('Add your first contract', 'Start with the renewals that would hurt most if they slipped: software, leases, insurance, maintenance contracts.', html`<p><a class="btn btn-primary" href="/contracts/new">Add a contract</a> <a class="btn" href="/import">Import a CSV</a></p>`)}`);
    const s = summarise(all, today);
    const attention = all.filter((c) => ['act', 'locked', 'lapsed', 'soon'].includes(urgency(c, today))).sort((a, b) => noticeDeadline(a).localeCompare(noticeDeadline(b))).slice(0, 10);
    const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return ctx.page(
      'Dashboard',
      html`${pageHeader('Dashboard', html`<a class="btn btn-primary" href="/contracts/new">Add contract</a>`)}
      ${statGrid([
        { label: 'Yearly commitments', value: m(s.annual), hint: `${s.active} active contracts` },
        { label: 'Renewing in 30 days', value: m(s.next30Value), hint: `${s.next30} renewal${s.next30 === 1 ? '' : 's'}`, tone: s.next30 ? 'warn' : '' },
        { label: 'Need a decision', value: s.act + s.locked + s.lapsed, tone: s.act + s.locked + s.lapsed ? 'bad' : 'good', hint: `${s.act} deadline soon · ${s.locked} locked in · ${s.lapsed} to update` },
        { label: 'Saved by cancelling', value: m(s.cancelledSaving), tone: s.cancelledSaving ? 'good' : '', hint: 'yearly cost removed' },
      ])}
      <div class="viz">${card('Yearly spend by category', vbars({ height: 170, format: (v) => (v >= 1e5 ? `${Math.round(v / 1e5)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)), items: cats.map(([k, v]) => ({ label: k.slice(0, 10), value: Math.round(v / 100) })) }))}
        ${card('Spend on auto-renew', html`${ring({ value: s.autoRenewShare, max: 100, text: `${s.autoRenewShare}%`, label: 'auto-renews' })}<p class="muted center">Renews unless you cancel in time</p>`, { className: 'ring-card' })}</div>
      ${card('Deadlines to watch', table({
        columns: [
          { label: 'Contract', render: (c) => html`<a href="/contracts/${c.id}"><strong>${c.name}</strong></a>${c.vendor ? html`<span class="sub">${c.vendor}</span>` : ''}` },
          { label: 'Cancel by', render: (c) => { const d = Math.round((Date.parse(noticeDeadline(c)) - Date.parse(today)) / 86400000); return html`${formatDate(noticeDeadline(c))}<span class="sub">${d < 0 ? `${-d}d ago` : d === 0 ? 'today' : `in ${d}d`}</span>`; } },
          { label: 'Renews', render: (c) => formatDate(c.renewal_date) },
          { label: 'Cost / year', align: 'right', render: (c) => m(annualCost(c)) },
          { label: '', render: (c) => { const u = urgency(c, today); return badge(U_LABEL[u], U_TONE[u]); } },
        ],
        rows: attention, empty: 'Nothing needs a decision right now.',
      }))}`,
    );
  });

  // ---- contracts --------------------------------------------------------------------
  const FILTERS = [['active', 'Active'], ['action', 'Needs action'], ['soon', 'Renewing soon'], ['cancelled', 'Cancelled'], ['all', 'All']];
  app.get('/contracts', (ctx) => {
    const today = ctx.today();
    const filter = FILTERS.some(([k]) => k === ctx.query.filter) ? ctx.query.filter : 'active';
    const q = clean(ctx.query.q, 80).toLowerCase();
    const m = money(ctx);
    const rows = db.all('SELECT * FROM contracts WHERE user_id = ? ORDER BY renewal_date LIMIT 3000', ctx.user.id).filter((c) => {
      const u = urgency(c, today);
      if (filter === 'active' && c.status !== 'active') return false;
      if (filter === 'cancelled' && c.status !== 'cancelled') return false;
      if (filter === 'action' && !['act', 'locked', 'lapsed'].includes(u)) return false;
      if (filter === 'soon' && !['act', 'soon', 'locked'].includes(u)) return false;
      return !q || [c.name, c.vendor, c.category].some((v) => v.toLowerCase().includes(q));
    });
    return ctx.page(
      'Contracts',
      html`${pageHeader('Contracts', html`<a class="btn" href="/contracts.csv">Export CSV</a><a class="btn btn-primary" href="/contracts/new">Add contract</a>`)}
      <div class="pill-row">${FILTERS.map(([k, l]) => html`<a href="/contracts?filter=${k}" class="${k === filter ? 'active' : ''}">${l}</a>`)}</div>
      <form method="get" action="/contracts" class="inline-form" style="margin-bottom:1rem"><input type="hidden" name="filter" value="${filter}"><input type="text" name="q" value="${q}" placeholder="Search name, vendor, category"><button class="btn" type="submit">Search</button></form>
      ${card('', table({
        columns: [
          { label: 'Contract', render: (c) => html`<a href="/contracts/${c.id}"><strong>${c.name}</strong></a><span class="sub">${[c.vendor, c.category].filter(Boolean).join(' · ')}</span>` },
          { label: 'Cost', align: 'right', render: (c) => html`${m(c.amount)}<span class="sub">${CYCLES[c.cycle].label}</span>` },
          { label: 'Cancel by', render: (c) => formatDate(noticeDeadline(c)) },
          { label: 'Renews', render: (c) => formatDate(c.renewal_date) },
          { label: '', render: (c) => { const u = urgency(c, today); return badge(U_LABEL[u], U_TONE[u]); } },
        ],
        rows: rows.slice(0, 300), empty: q ? 'No contracts match your search.' : 'No contracts in this view.',
      }))}`,
    );
  });

  app.get('/contracts.csv', (ctx) => download('contracts.csv', toCsv(db.all('SELECT * FROM contracts WHERE user_id = ? ORDER BY renewal_date', ctx.user.id), [
    { key: 'name', label: 'name' }, { key: 'vendor', label: 'vendor' }, { key: 'category', label: 'category' }, { label: 'amount', value: (c) => c.amount / 100 }, { key: 'cycle', label: 'cycle' },
    { key: 'renewal_date', label: 'renewal_date' }, { key: 'notice_days', label: 'notice_days' }, { label: 'auto_renew', value: (c) => (c.auto_renew ? 'yes' : 'no') }, { key: 'status', label: 'status' },
  ])));

  const contractForm = (ctx, c = {}) => html`<form method="post" action="${c.id ? `/contracts/${c.id}/edit` : '/contracts'}">${csrfField(ctx)}
    <div class="row">
      ${field({ label: 'Contract / subscription', name: 'name', value: c.name ?? '', required: true })}
      ${field({ label: 'Vendor', name: 'vendor', value: c.vendor ?? '' })}
      ${field({ label: 'Category', name: 'category', value: c.category ?? '', placeholder: 'Software, rent, insurance…' })}
    </div>
    <div class="row">
      ${field({ label: `Cost per billing cycle (${ctx.user.currency})`, name: 'amount', value: c.amount != null ? c.amount / 100 : '', required: true, attrs: { inputmode: 'decimal' } })}
      ${field({ label: 'Billing cycle', name: 'cycle', type: 'select', options: Object.entries(CYCLES).map(([k, v]) => [k, v.label]), value: c.cycle ?? 'yearly' })}
      ${field({ label: 'Next renewal date', name: 'renewal_date', type: 'date', value: c.renewal_date ?? '', required: true })}
      ${field({ label: 'Cancellation notice (days)', name: 'notice_days', type: 'number', value: c.notice_days ?? 30, attrs: { min: 0, max: 365 } })}
    </div>
    ${field({ label: 'Renews automatically', name: 'auto_renew', type: 'checkbox', value: c.id ? c.auto_renew : 1 })}
    ${field({ label: 'Notes', name: 'notes', type: 'textarea', rows: 3, value: c.notes ?? '' })}
    <button class="btn btn-primary" type="submit">${c.id ? 'Save changes' : 'Add contract'}</button></form>`;

  function readContract(ctx) {
    const b = ctx.body;
    const amount = parseAmount(b.amount);
    const date = isISODate(b.renewal_date) ? b.renewal_date : parseDateLoose(b.renewal_date, { dayFirst: ctx.user.currency === 'INR' });
    const notice = b.notice_days === '' || b.notice_days === undefined ? 30 : Math.round(Number(b.notice_days));
    const v = { name: clean(b.name, 120), vendor: clean(b.vendor, 100), category: clean(b.category, 50), amount: toMinor(amount), cycle: CYCLES[b.cycle] ? b.cycle : 'yearly', renewal_date: date, notice_days: notice, auto_renew: b.auto_renew === '1' ? 1 : 0, notes: clean(b.notes, 1000) };
    let error = '';
    if (!v.name) error = 'Name is required.';
    else if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) error = 'Enter the cost per billing cycle.';
    else if (!date) error = 'Enter a valid renewal date.';
    else if (!Number.isFinite(notice) || notice < 0 || notice > 365) error = 'Notice period must be between 0 and 365 days.';
    return { v, error };
  }

  app.get('/contracts/new', (ctx) => ctx.page('Add contract', html`${pageHeader('Add contract')}${card('', contractForm(ctx))}`));
  app.post('/contracts', (ctx) => {
    const { v, error } = readContract(ctx);
    if (error) return ctx.page('Add contract', html`${pageHeader('Add contract')}<div class="flash flash-err">${error}</div>${card('', contractForm(ctx, { ...v }))}`, { status: 400 });
    const limitMsg = ctx.checkLimit('contracts', db.get('SELECT COUNT(*) AS n FROM contracts WHERE user_id = ?', ctx.user.id).n);
    if (limitMsg) return redirect('/contracts', { err: limitMsg });
    const id = db.run('INSERT INTO contracts (user_id, name, vendor, category, amount, cycle, renewal_date, notice_days, auto_renew, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ctx.user.id, v.name, v.vendor, v.category, v.amount, v.cycle, v.renewal_date, v.notice_days, v.auto_renew, v.notes, ctx.now()).id;
    return redirect(`/contracts/${id}`, { ok: 'Contract added.' });
  });

  app.get('/contracts/:id', (ctx) => {
    const c = getContract(ctx, ctx.params.id);
    const today = ctx.today();
    const u = urgency(c, today);
    const m = money(ctx);
    const act = (path, label, cls = 'btn', extra = '') => html`<form method="post" action="/contracts/${c.id}/${path}" class="inline" ${raw(extra)}>${csrfField(ctx)}<button class="${cls}" type="submit">${label}</button></form>`;
    return ctx.page(
      c.name,
      html`${pageHeader(html`${c.name} ${badge(U_LABEL[u], U_TONE[u])}`, c.status === 'active' ? html`${act('renewed', `Mark renewed → ${formatDate(nextRenewal(c))}`, 'btn btn-primary')}${act('cancel', 'Cancel contract', 'btn')}` : act('reactivate', 'Reactivate', 'btn btn-primary'), `${c.vendor ? `${c.vendor} · ` : ''}${m(c.amount)} ${CYCLES[c.cycle].label.toLowerCase()}`)}
      ${statGrid([
        { label: 'Cancel by', value: formatDate(noticeDeadline(c)), tone: ['act', 'locked'].includes(u) ? 'bad' : '', hint: `${c.notice_days}-day notice` },
        { label: 'Renews', value: formatDate(c.renewal_date), hint: c.auto_renew ? 'automatically' : 'manual decision' },
        { label: 'Cost per year', value: m(annualCost(c)) },
        ...(c.status === 'cancelled' ? [{ label: 'Cancelled', value: formatDate(c.cancelled_on), tone: 'good', hint: `saves ${m(annualCost(c))} a year` }] : []),
      ])}
      ${card('Details', contractForm(ctx, c))}
      ${act('delete', 'Delete contract', 'btn btn-danger', 'data-confirm="Delete this contract permanently?"')}`,
    );
  });

  app.post('/contracts/:id/edit', (ctx) => {
    const c = getContract(ctx, ctx.params.id);
    const { v, error } = readContract(ctx);
    if (error) return redirect(`/contracts/${c.id}`, { err: error });
    db.run('UPDATE contracts SET name = ?, vendor = ?, category = ?, amount = ?, cycle = ?, renewal_date = ?, notice_days = ?, auto_renew = ?, notes = ? WHERE id = ?', v.name, v.vendor, v.category, v.amount, v.cycle, v.renewal_date, v.notice_days, v.auto_renew, v.notes, c.id);
    return redirect(`/contracts/${c.id}`, { ok: 'Saved.' });
  });
  app.post('/contracts/:id/renewed', (ctx) => {
    const c = getContract(ctx, ctx.params.id);
    let next = nextRenewal(c);
    for (let n = 0; n < 60 && next < ctx.today(); n++) next = nextRenewal({ ...c, renewal_date: next });
    db.run('UPDATE contracts SET renewal_date = ?, reminder_for = NULL, reminder_level = NULL WHERE id = ?', next, c.id);
    return redirect(`/contracts/${c.id}`, { ok: `Renewed. Next renewal ${formatDate(next)}.` });
  });
  app.post('/contracts/:id/cancel', (ctx) => {
    const c = getContract(ctx, ctx.params.id);
    db.run(`UPDATE contracts SET status = 'cancelled', cancelled_on = ? WHERE id = ?`, ctx.today(), c.id);
    return redirect(`/contracts/${c.id}`, { ok: 'Marked as cancelled. Its yearly cost now counts as a saving.' });
  });
  app.post('/contracts/:id/reactivate', (ctx) => {
    const c = getContract(ctx, ctx.params.id);
    const limitMsg = ctx.checkLimit('contracts', db.get(`SELECT COUNT(*) AS n FROM contracts WHERE user_id = ? AND status = 'active'`, ctx.user.id).n);
    if (limitMsg) return redirect(`/contracts/${c.id}`, { err: limitMsg });
    db.run(`UPDATE contracts SET status = 'active', cancelled_on = NULL WHERE id = ?`, c.id);
    return redirect(`/contracts/${c.id}`, { ok: 'Reactivated.' });
  });
  app.post('/contracts/:id/delete', (ctx) => {
    db.run('DELETE FROM contracts WHERE id = ?', getContract(ctx, ctx.params.id).id);
    return redirect('/contracts', { ok: 'Contract deleted.' });
  });

  // ---- import / settings -----------------------------------------------------------------
  const importPage = (ctx, extra = '', text = '') => ctx.page('Import contracts', html`${pageHeader('Import contracts', '', 'Paste a CSV or choose a file. Contracts with the same name and vendor are updated.')}${extra}
    ${card('', html`<form method="post" action="/import">${csrfField(ctx)}<p><input type="file" accept=".csv,text/csv,text/plain" data-load-into="#csv"></p>
      ${field({ label: 'CSV data', name: 'csv', type: 'textarea', rows: 12, id: 'csv', value: text, required: true, placeholder: 'name,vendor,amount,cycle,renewal_date,notice_days,auto_renew,category\nZoho CRM,Zoho,12000,yearly,2027-03-15,30,yes,Software' })}
      <p class="help">Required: name, amount, renewal_date. Optional: vendor, cycle (monthly, quarterly, half-yearly, yearly, every 2 years), notice_days (default 30), auto_renew (default yes), category.</p>
      <button class="btn btn-primary" type="submit">Import</button></form>`)}`);
  app.get('/import', (ctx) => importPage(ctx));
  app.post('/import', (ctx) => {
    const text = String(ctx.body.csv ?? '');
    let parsed;
    try { parsed = parseContractCsv(text, { dayFirst: ctx.user.currency === 'INR' }); } catch (err) { return importPage(ctx, html`<div class="flash flash-err">${err.message}</div>`, text); }
    if (parsed.missing.length) return importPage(ctx, html`<div class="flash flash-err">Missing column: ${parsed.missing.join(', ')}.</div>`, text);
    let created = 0; let updated = 0; let over = 0;
    db.tx(() => {
      let total = db.get('SELECT COUNT(*) AS n FROM contracts WHERE user_id = ?', ctx.user.id).n;
      const limit = ctx.limit('contracts');
      for (const r of parsed.rows) {
        const ex = db.get('SELECT id FROM contracts WHERE user_id = ? AND name = ? COLLATE NOCASE AND vendor = ? COLLATE NOCASE', ctx.user.id, r.name, r.vendor);
        if (ex) {
          db.run('UPDATE contracts SET category = ?, amount = ?, cycle = ?, renewal_date = ?, notice_days = ?, auto_renew = ? WHERE id = ?', r.category, r.amount, r.cycle, r.renewal_date, r.notice_days, r.auto_renew, ex.id);
          updated++;
        } else if (total + 1 > limit) over++;
        else {
          db.run('INSERT INTO contracts (user_id, name, vendor, category, amount, cycle, renewal_date, notice_days, auto_renew, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ctx.user.id, r.name, r.vendor, r.category, r.amount, r.cycle, r.renewal_date, r.notice_days, r.auto_renew, ctx.now());
          total++; created++;
        }
      }
    });
    const msg = `Imported ${created} new, updated ${updated}${over ? `; ${over} skipped because your ${ctx.planInfo.label} plan allows ${ctx.limit('contracts').toLocaleString('en-US')} contracts — upgrade on the Billing page` : ''}.`;
    if (parsed.errors.length) return importPage(ctx, html`<div class="flash flash-ok">${msg}</div>${card(`${parsed.errors.length} row${parsed.errors.length === 1 ? '' : 's'} need attention`, table({ columns: [{ label: 'Line', render: (e) => e.line }, { label: 'Problem', render: (e) => e.message }], rows: parsed.errors.slice(0, 100) }))}`);
    return redirect('/contracts', { ok: msg });
  }, { maxBody: 3 * 1024 * 1024 });

  app.get('/settings', (ctx) => ctx.page('Settings', html`${pageHeader('Settings')}<form method="post" action="/settings">${csrfField(ctx)}${card('Reminders', html`
    ${field({ label: 'First reminder (days before the cancellation deadline)', name: 'lead_days', type: 'number', value: ctx.settings.lead_days, attrs: { min: 4, max: 60 }, help: 'You also get reminders 3 days before and on the deadline itself.' })}
    ${field({ label: 'Send reminders to', name: 'alert_email', type: 'email', value: ctx.settings.alert_email, placeholder: ctx.user.email, help: 'Defaults to your login email. Use a shared inbox for a team.' })}`)}<button class="btn btn-primary" type="submit">Save settings</button></form>`));
  app.post('/settings', (ctx) => {
    ctx.saveSettings({ lead_days: Math.min(60, Math.max(4, Math.round(Number(ctx.body.lead_days)) || 14)), alert_email: isEmail(String(ctx.body.alert_email ?? '').trim().toLowerCase()) ? String(ctx.body.alert_email).trim().toLowerCase() : '' });
    return redirect('/settings', { ok: 'Settings saved.' });
  });

  return app;
}
