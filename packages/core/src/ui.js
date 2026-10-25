import { html, raw, escape, safeUrl } from './html.js';
import { formatDate } from './dates.js';
import { formatMoney } from './money.js';

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

export function statGrid(items) {
  return html`<div class="stats">${items.map(
    (s) => html`<div class="stat ${s.tone ? `stat-${s.tone}` : ''}">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
      ${s.hint ? html`<div class="stat-hint">${s.hint}</div>` : ''}
    </div>`,
  )}</div>`;
}

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
  return html`<a href="${item.href}" class="${active ? 'active' : ''}">${item.label}</a>`;
}

/** Wrap page content in the shared document shell. */
export function layout(ctx, { title, body, description, status = 200, noindex = true, scripts = [] }) {
  const { config } = ctx.app;
  const fullTitle = title && title !== config.name ? `${title} · ${config.name}` : `${config.name} — ${config.tagline}`;
  const cur = ctx.user?.currency ?? ctx.guessCurrency();
  const flash = ctx.flash;
  const doc = html`<!doctype html>
<html lang="en" data-cur="${cur}" style="--accent:${config.accent}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${fullTitle}</title>
  <meta name="description" content="${description ?? config.tagline}">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${description ?? config.tagline}">
  ${noindex ? raw('<meta name="robots" content="noindex">') : ''}
  ${ctx.csrf ? html`<meta name="csrf-token" content="${ctx.csrf}">` : ''}
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/app.js" defer></script>
  ${scripts.map((s) => html`<script src="${s}" defer></script>`)}
</head>
<body>
  <header class="topbar">
    <div class="container bar">
      <a class="brand" href="/"><span class="logo">${config.name.slice(0, 1)}</span>${config.name}</a>
      <nav>${ctx.user ? config.nav.map((n) => navLink(ctx, n)) : ''}</nav>
      <div class="bar-right">
        ${ctx.user
          ? html`<a class="plan-pill" href="/billing">${ctx.planInfo.label}</a>
              <a href="/account">Account</a>
              <form method="post" action="/logout" class="inline">${csrfField(ctx)}<button class="link" type="submit">Log out</button></form>`
          : html`<a href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/signup">Start free</a>`}
      </div>
    </div>
  </header>
  <main class="container">
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.msg}</div>` : ''}
    ${body}
  </main>
  <footer class="footer"><div class="container">
    <span>© ${new Date(ctx.now()).getUTCFullYear()} ${config.name}</span>
    <a href="/privacy">Privacy</a><a href="/terms">Terms</a>
    ${config.env.SUPPORT_EMAIL ? html`<a href="mailto:${config.env.SUPPORT_EMAIL}">Support</a>` : ''}
  </div></footer>
</body></html>`;
  return { status, body: doc };
}

export { safeUrl };
