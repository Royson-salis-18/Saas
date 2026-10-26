import { html, raw, escape, safeUrl } from './html.js';
import { formatDate } from './dates.js';
import { formatMoney } from './money.js';
import { glyphPath } from './brand.js';

export { formatDate, formatMoney };

export const csrfField = (ctx) => html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;

export function badge(label, tone = 'neutral') {
  return html`<span class="badge badge-${tone}">${label}</span>`;
}

export function pageHeader(title, actions = '', sub = '') {
  return html`<div class="page-header">
    <div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ''}</div>
    <div class="actions">${actions}</div>
  </div>`;
}

export function card(title, body, { className = '' } = {}) {
  return html`<section class="card ${className}">${title ? html`<h2>${title}</h2>` : ''}${body}</section>`;
}

export function delta(text, tone = 'neutral') {
  return html`<span class="delta delta-${tone}">${text}</span>`;
}

/** KPI cards. Items: { label, value, hint, tone, delta, deltaTone } */
export function statGrid(items) {
  return html`<div class="stats">${items.map(
    (s) => html`<div class="stat ${s.tone ? `stat-${s.tone}` : ''}">
      <div class="stat-top"><div class="stat-label">${s.label}</div>${s.delta ? delta(s.delta, s.deltaTone ?? s.tone ?? 'neutral') : ''}</div>
      <div class="stat-value">${s.value}</div>
      ${s.hint ? html`<div class="stat-hint">${s.hint}</div>` : ''}
    </div>`,
  )}</div>`;
}

/** Donut gauge. value/max drive the arc; centre shows `text`. */
export function ring({ value, max = 100, text, label = '', tone = 'accent' }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  return html`<div class="ring ring-${tone}"><svg viewBox="0 0 120 120" role="img" aria-label="${label} ${text}">
    <circle cx="60" cy="60" r="${r}" class="ring-track"/>
    <circle cx="60" cy="60" r="${r}" class="ring-arc" stroke-dasharray="${(pct * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>
  </svg><div class="ring-text"><strong>${text}</strong><span>${label}</span></div></div>`;
}

/** Vertical bar chart. items: [{ label, value, tone? }]; the tallest bar is highlighted. */
export function vbars({ items, format = (v) => String(v), height = 150 }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return html`<div class="vbars" style="height:${height}px">${items.map((i) => {
    const h = Math.max(i.value ? 5 : 2, Math.round((i.value / max) * 100));
    return html`<div class="vbar ${i.value === max && max > 1 ? 'peak' : ''} ${i.tone ? `t-${i.tone}` : ''}"><span class="vbar-val">${format(i.value)}</span><div class="vbar-track"><div class="vbar-fill" style="height:${h}%"></div></div><span class="vbar-label">${i.label}</span></div>`;
  })}</div>`;
}

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M4 20h16"/>',
  sliders: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7.5 8.5 6 8.5-6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/>',
  out: '<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
};
function iconFor(item) {
  const h = item.href;
  if (/dashboard|monitors$/.test(h)) return 'grid';
  if (/import/.test(h)) return 'upload';
  if (/settings/.test(h)) return 'sliders';
  if (/drafts/.test(h)) return 'mail';
  if (/orders|products/.test(h)) return 'box';
  if (/new/.test(h)) return 'plus';
  return 'list';
}
export const icon = (name) => html`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name] ?? '')}</svg>`;

/** columns: [{ label, render(row) | key, align, className }] */
export function table({ columns, rows, empty = 'Nothing here yet.' }) {
  if (!rows.length) return html`<p class="empty">${empty}</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => html`<th class="${c.align === 'right' ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(
      (row) => html`<tr>${columns.map(
        (c) => html`<td class="${c.align === 'right' ? 'num' : ''} ${c.className ?? ''}">${typeof c.render === 'function' ? c.render(row) : row[c.key]}</td>`,
      )}</tr>`,
    )}</tbody>
  </table></div>`;
}

/**
 * Form field. type: text | email | password | number | date | url | tel |
 * textarea | select | checkbox. For select, options is [[value,label],...] or ['a','b'].
 */
export function field({ label, name, type = 'text', value = '', required = false, help = '', placeholder = '', options = [], rows = 3, attrs = {}, id }) {
  const fid = id ?? `f_${name}`;
  const extra = raw(
    Object.entries(attrs)
      .map(([k, v]) => (v === true ? ` ${escape(k)}` : ` ${escape(k)}="${escape(v)}"`))
      .join(''),
  );
  let control;
  if (type === 'textarea') {
    control = html`<textarea id="${fid}" name="${name}" rows="${rows}" placeholder="${placeholder}" ${required ? raw('required') : ''}${extra}>${value}</textarea>`;
  } else if (type === 'select') {
    control = html`<select id="${fid}" name="${name}"${extra}>${options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return html`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${l}</option>`;
    })}</select>`;
  } else if (type === 'checkbox') {
    return html`<label class="check"><input type="checkbox" id="${fid}" name="${name}" value="1" ${value ? raw('checked') : ''}${extra}> <span>${label}</span></label>${help ? html`<p class="help">${help}</p>` : ''}`;
  } else {
    control = html`<input id="${fid}" type="${type}" name="${name}" value="${value}" placeholder="${placeholder}" ${required ? raw('required') : ''}${extra}>`;
  }
  return html`<div class="field"><label for="${fid}">${label}</label>${control}${help ? html`<p class="help">${help}</p>` : ''}</div>`;
}

export function emptyState(title, body, action = '') {
  return html`<div class="empty-state"><h3>${title}</h3><p class="muted">${body}</p>${action}</div>`;
}

export function trendTone(value, { good = 'up' } = {}) {
  if (value === 0) return 'neutral';
  return (value > 0) === (good === 'up') ? 'good' : 'bad';
}

function navLink(ctx, item) {
  const active = ctx.path === item.href || (item.href !== '/' && ctx.path.startsWith(`${item.href}/`));
  return html`<a href="${item.href}" title="${item.label}" class="${active ? 'active' : ''}">${icon(iconFor(item))}<span>${item.label}</span></a>`;
}

/** Wrap page content in the shared document shell. */
const HEAD_FONTS = {
  sans: 'inherit',
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
const cssVars = (o = {}) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';');
/** Per-product palette: dark and light surfaces, radius, heading font. Values come from our own config, never user input. */
export function themeStyle(t) {
  if (!t) return '';
  return `<style>:root{${cssVars(t.dark)};--radius:${t.radius ?? 20}px;--radius-sm:${Math.round((t.radius ?? 20) * 0.6)}px;--head:${HEAD_FONTS[t.font] ?? HEAD_FONTS.sans};--a-ink:${t.ink ?? '#0A0D0B'}}@media (prefers-color-scheme:light){:root{${cssVars(t.light)};--a-ink:${t.lightInk ?? '#ffffff'}}}</style>`;
}

export function layout(ctx, { title, body, description, status = 200, noindex = true, scripts = [] }) {
  const { config } = ctx.app;
  const fullTitle = title && title !== config.name ? `${title} · ${config.name}` : `${config.name} — ${config.tagline}`;
  const cur = ctx.user?.currency ?? ctx.guessCurrency();
  const flash = ctx.flash;
  const doc = html`<!doctype html>
<html lang="en" data-cur="${cur}" data-skin="${config.theme?.skin ?? 'default'}" style="--accent:${config.theme?.accent ?? config.accent}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${fullTitle}</title>
  <meta name="description" content="${description ?? config.tagline}">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${description ?? config.tagline}">
  ${noindex ? raw('<meta name="robots" content="noindex">') : ''}
  ${ctx.csrf ? html`<meta name="csrf-token" content="${ctx.csrf}">` : ''}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/app.css">
  ${raw(themeStyle(config.theme))}
  <script src="/static/app.js" defer></script>
  ${scripts.map((s) => html`<script src="${s}" defer></script>`)}
</head>
<body class="${ctx.user ? 'app' : 'site'}">
  ${ctx.user
    ? html`<div class="shell">
      <aside class="side">
        <a class="brand" href="/"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphPath(config.glyph)}"/></svg></span>${config.name}</a>
        <p class="side-label">Menu</p>
        <nav>${config.nav.map((n) => navLink(ctx, n))}</nav>
        <div class="side-spacer"></div>
        ${ctx.plan === 'free'
          ? html`<div class="upsell"><strong>Upgrade to Pro</strong><span>Higher limits and priority support.</span><a class="btn btn-primary btn-sm" href="/billing">See plans</a></div>`
          : html`<div class="upsell"><strong>${ctx.planInfo.label} plan</strong><span>Thanks for supporting ${config.name}.</span><a class="btn btn-sm" href="/billing">Manage billing</a></div>`}
        <div class="me"><span class="avatar">${(ctx.user.name || ctx.user.email).slice(0, 1).toUpperCase()}</span>
          <div class="me-text"><strong>${ctx.user.name || 'Account'}</strong><span>${ctx.user.email}</span></div></div>
        <div class="me-links"><a href="/account" aria-label="Account" title="Account">${icon('user')}<span>Account</span></a><a href="/billing" aria-label="Billing" title="Billing">${icon('card')}<span>Billing</span></a>
          <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="link" type="submit" aria-label="Log out" title="Log out">${icon('out')}<span>Log out</span></button></form></div>
      </aside>
      <div class="content">
        <main class="container">${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.msg}</div>` : ''}${body}</main>
        <footer class="footer"><div class="container"><span>© ${new Date(ctx.now()).getUTCFullYear()} ${config.name}</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a>${config.env.SUPPORT_EMAIL ? html`<a href="mailto:${config.env.SUPPORT_EMAIL}">Support</a>` : ''}</div></footer>
      </div>
    </div>`
    : html`<header class="topbar"><div class="container bar">
        <a class="brand" href="/"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphPath(config.glyph)}"/></svg></span>${config.name}</a>
        <div class="bar-right"><a href="/#pricing">Pricing</a><a href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/signup">Start free</a></div></div></header>
      <main class="container">${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.msg}</div>` : ''}${body}</main>
      <footer class="footer"><div class="container"><span>© ${new Date(ctx.now()).getUTCFullYear()} ${config.name}</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a>${config.env.SUPPORT_EMAIL ? html`<a href="mailto:${config.env.SUPPORT_EMAIL}">Support</a>` : ''}</div></footer>`}
</body></html>`;
  return { status, body: doc };
}

export { safeUrl };
