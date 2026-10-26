// Generates every logo file and the brand sheet from packages/core/src/{brand,themes}.js
//   node scripts/build-brand.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { PRODUCTS, faviconSvg, lockupSvg, markSvg } from '../packages/core/src/brand.js';
import { THEMES } from '../packages/core/src/themes.js';

mkdirSync('brand/logos', { recursive: true });
for (const [slug, p] of Object.entries(PRODUCTS)) {
  for (const mode of ['light', 'dark']) {
    writeFileSync(`brand/logos/${slug}-mark-${mode}.svg`, markSvg(p.glyph, mode, { product: slug }));
    writeFileSync(`brand/logos/${slug}-lockup-${mode}.svg`, lockupSvg(p.name, p.glyph, mode, slug));
  }
  writeFileSync(`brand/logos/${slug}-favicon.svg`, faviconSvg(p.glyph, slug));
}

const chip = (hex, label) => `<span class="chip"><i style="background:${hex}"></i>${label}<code>${hex}</code></span>`;
const card = ([slug, p]) => {
  const th = THEMES[slug];
  if (!th) return '';
  return `<section class="prod"><div class="pair"><div class="face" style="background:${th.dark.bg}">${lockupSvg(p.name, p.glyph, 'dark', slug)}</div><div class="face" style="background:${th.light.bg}">${lockupSvg(p.name, p.glyph, 'light', slug)}</div></div>
<div class="chips">${chip(th.accent, 'Accent')}${chip(th.dark.bg, 'Dark')}${chip(th.light.bg, 'Light')}</div><p>${th.skin} skin · ${th.font} headings · ${th.radius}px corners</p></section>`;
};
writeFileSync('brand/index.html', `<!doctype html><meta charset="utf-8"><title>Brand</title><style>
body{margin:0;font:14px/1.5 ui-sans-serif,Inter,sans-serif;background:#f3f5ef;color:#0a0d0b}main{max-width:1040px;margin:auto;padding:3rem 1.5rem}
h1{font-size:2rem;letter-spacing:-.03em;margin:0 0 .3rem}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.4rem;margin-top:2rem}
.prod{border:1px solid #0001;border-radius:20px;background:#fff;padding:1rem}.pair{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}.face{border-radius:14px;padding:1.2rem 1rem;display:grid;place-items:center;border:1px solid #0001}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.9rem}.chip{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem}.chip i{width:14px;height:14px;border-radius:50%;border:1px solid #0003}.chip code{opacity:.6}.prod p{margin:.6rem 0 0;opacity:.65;font-size:.82rem}
@media(max-width:800px){.grid{grid-template-columns:1fr}}</style><main>
<h1>Brand</h1><p>Every product has its own identity: its own three colours (accent, dark and light surface), logo tile, heading face and corner radius.</p>
<div class="grid">${Object.entries(PRODUCTS).map(card).join('')}</div></main>`);
console.log('brand files written');
