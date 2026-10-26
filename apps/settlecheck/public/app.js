import { exceptionsCsv, guessColumns, parseCsv, reconcile } from './reconcile.js';

const $ = (s, r = document) => r.querySelector(s);
const state = { a: null, b: null, result: null, tab: 'missing' };
const MAX_BYTES = 25 * 1024 * 1024;
let currency = '';

const fmt = (minor) => {
  const n = minor / 100;
  const s = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : ''}${currency}${s}`;
};
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (e.className = v) : e.setAttribute(k, v);
  for (const kid of kids) e.append(kid);
  return e;
};

function load(side, text, name) {
  const status = $(`[data-status=${side}]`);
  try {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('No data rows found. The first row should be column headers.');
    const header = rows[0].map((h) => h.trim());
    state[side] = { header, rows: rows.slice(1) };
    const g = guessColumns(header);
    for (const [kind, sel] of [['key', g.key], ['amt', g.amount]]) {
      const s = $(`[data-${kind}=${side}]`);
      s.replaceChildren(...header.map((h, i) => el('option', { value: i }, h || `Column ${i + 1}`)));
      s.value = sel;
    }
    $(`[data-cols=${side}]`).classList.remove('hidden');
    status.textContent = `${name ? `${name}: ` : ''}${(rows.length - 1).toLocaleString()} rows loaded`;
    status.className = 'loaded ok';
  } catch (e) {
    state[side] = null;
    $(`[data-cols=${side}]`).classList.add('hidden');
    status.textContent = e.message;
    status.className = 'loaded bad';
  }
  $('#run').disabled = !(state.a && state.b);
}

for (const side of ['a', 'b']) {
  $(`[data-file=${side}]`).addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_BYTES) { load(side, '', ''); $(`[data-status=${side}]`).textContent = 'File is larger than 25 MB. Split it into smaller files.'; return; }
    const r = new FileReader();
    r.onload = () => load(side, String(r.result), f.name);
    r.readAsText(f);
  });
  $(`[data-paste=${side}]`).addEventListener('input', (e) => (e.target.value.trim() ? load(side, e.target.value, 'Pasted text') : load(side, '', '')));
}

$('#run').addEventListener('click', () => {
  $('#error').textContent = '';
  try {
    const num = (id) => Math.max(0, Number($(id).value) || 0);
    state.result = reconcile(state.a.rows, state.b.rows, {
      keyA: +$('[data-key=a]').value, amtA: +$('[data-amt=a]').value, keyB: +$('[data-key=b]').value, amtB: +$('[data-amt=b]').value,
      tolAbs: num('#tolAbs'), tolPct: num('#tolPct'), stripKeys: $('#strip').checked,
    });
    state.tab = state.result.missing.length ? 'missing' : state.result.mismatched.length ? 'mismatched' : state.result.extra.length ? 'extra' : 'matched';
    render();
    $('#results').classList.remove('hidden');
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#error').textContent = e.message;
  }
});

function stat(label, value, hint, tone) {
  return el('div', { class: `stat ${tone || ''}` }, el('div', { class: 'l' }, label), el('div', { class: 'v' }, value), el('div', { class: 'h' }, hint || ''));
}

function render() {
  const { summary: s } = state.result;
  $('#summary').replaceChildren(
    stat('Expected', fmt(s.expected), `${s.refsA.toLocaleString()} references`),
    stat('Received', fmt(s.received), `${s.refsB.toLocaleString()} references`),
    stat('Net difference', fmt(s.difference), s.difference < 0 ? 'received is lower' : s.difference > 0 ? 'received is higher' : 'balanced', s.difference < 0 ? 'bad' : ''),
    stat('Never received', fmt(s.missingValue), `${s.missing} references`, s.missing ? 'bad' : ''),
    stat('Paid short', fmt(s.underpaid), `${s.mismatched} amount differences`, s.underpaid ? 'bad' : ''),
  );
  const tabs = [['missing', 'Missing in received', s.missing], ['mismatched', 'Amount differs', s.mismatched], ['extra', 'Not in expected', s.extra], ['matched', 'Matched', s.matched]];
  $('#tabs').replaceChildren(...tabs.map(([k, label, n]) => {
    const b = el('button', { class: `tab ${k === state.tab ? 'on' : ''}`, role: 'tab', type: 'button' }, `${label} `, el('span', { class: 'n' }, String(n)));
    b.addEventListener('click', () => { state.tab = k; render(); });
    return b;
  }));
  const rows = state.result[state.tab];
  const skipped = state.result.skippedA.length + state.result.skippedB.length;
  const table = el('table', {}, el('thead', {}, el('tr', {}, ...['Reference', 'Expected', 'Received', 'Difference'].map((h, i) => el('th', { class: i ? 'num' : '' }, h)))));
  const body = el('tbody');
  for (const r of rows.slice(0, 500)) {
    body.append(el('tr', {}, el('td', {}, r.ref), el('td', { class: 'num' }, fmt(r.expected)), el('td', { class: 'num' }, fmt(r.received)), el('td', { class: `num ${r.diff < 0 ? 'neg' : r.diff > 0 ? 'pos' : ''}` }, fmt(r.diff))));
  }
  table.append(body);
  $('#table').replaceChildren(
    rows.length ? table : el('p', { class: 'empty' }, 'Nothing in this list.'),
    ...(rows.length > 500 ? [el('p', { class: 'note pad' }, `Showing the largest 500 of ${rows.length.toLocaleString()}. The CSV download contains all exceptions.`)] : []),
    ...(skipped ? [el('p', { class: 'note pad' }, `${skipped} row(s) were skipped because the reference was empty or the amount was not a number (first: line ${(state.result.skippedA[0] ?? state.result.skippedB[0]).line}).`)] : []),
  );
}

$('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exceptionsCsv(state.result)], { type: 'text/csv' }));
  const a = el('a', { href: url, download: 'settlecheck-exceptions.csv' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});
