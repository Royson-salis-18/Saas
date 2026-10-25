// Generates every logo file and the brand sheet from packages/core/src/brand.js
//   node scripts/build-brand.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { COLORS, PRODUCTS, faviconSvg, lockupSvg, markSvg } from '../packages/core/src/brand.js';

mkdirSync('brand/logos', { recursive: true });
for (const [slug, p] of Object.entries(PRODUCTS)) {
  for (const mode of ['light', 'dark']) {
    writeFileSync(`brand/logos/${slug}-mark-${mode}.svg`, markSvg(p.glyph, mode));
    writeFileSync(`brand/logos/${slug}-lockup-${mode}.svg`, lockupSvg(p.name, p.glyph, mode));
  }
  writeFileSync(`brand/logos/${slug}-favicon.svg`, faviconSvg(p.glyph));
}

const sw = (name, hex, use) => `<div class="sw"><i style="background:${hex}"></i><b>${name}</b><code>${hex}</code><span>${use}</span></div>`;
const row = (mode, bg) => `<div class="panel" style="background:${bg}">${Object.entries(PRODUCTS).map(([s, p]) => `<div class="cell">${markSvg(p.glyph, mode, { size: 64 })}${lockupSvg(p.name, p.glyph, mode)}</div>`).join('')}</div>`;
writeFileSync('brand/index.html', `<!doctype html><meta charset="utf-8"><title>Brand</title><style>
body{margin:0;font:14px/1.5 ui-sans-serif,Inter,sans-serif;background:${COLORS.paper};color:${COLORS.ink}}main{max-width:1000px;margin:auto;padding:3rem 1.5rem}
h1{font-size:2rem;letter-spacing:-.03em;margin:0 0 .3rem}h2{margin:2.5rem 0 .8rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;opacity:.6}
.sws{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}.sw{border:1px solid #0001;border-radius:16px;overflow:hidden;background:#fff;display:grid;gap:.15rem;padding-bottom:1rem}.sw i{height:110px;border-bottom:1px solid #0001;margin-bottom:.7rem}.sw b,.sw code,.sw span{padding:0 1rem}.sw span{opacity:.65;font-size:.82rem}
.panel{border-radius:20px;padding:1.5rem;display:grid;grid-template-columns:repeat(3,1fr);gap:1.6rem 1rem;border:1px solid #0001}.cell{display:grid;gap:.9rem;justify-items:start}
@media(max-width:800px){.sws,.panel{grid-template-columns:1fr}}</style><main>
<h1>Brand</h1><p>Three colours, one logo family. A rounded tile with a single-stroke glyph; the tile and glyph swap colours between modes.</p>
<h2>Core colours</h2><div class="sws">${sw('Ink', COLORS.ink, 'Dark-mode background, light-mode tile and text')}${sw('Lime', COLORS.lime, 'Signal colour: dark-mode tile, light-mode glyph, primary actions')}${sw('Paper', COLORS.paper, 'Light-mode background, dark-mode text')}</div>
<h2>Dark mode</h2>${row('dark', COLORS.ink)}<h2>Light mode</h2>${row('light', COLORS.paper)}</main>`);
console.log('brand files written');
