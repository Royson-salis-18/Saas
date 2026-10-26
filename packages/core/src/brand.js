// Brand system: three core colours and a family of logo marks (rounded tile + line glyph).
//   Ink   #0A0D0B  near-black with a green cast: dark-mode background, light-mode tile
//   Lime  #B8F23B  the signal colour: dark-mode tile, light-mode glyph, primary buttons
//   Paper #F3F5EF  warm off-white: light-mode background, dark-mode wordmark
// Dark mode : Ink background, Lime tile, Ink glyph, Paper wordmark.
// Light mode: Paper background, Ink tile, Lime glyph, Ink wordmark.

import { THEMES } from './themes.js';

export const COLORS = { ink: '#0A0D0B', lime: '#B8F23B', paper: '#F3F5EF' };

/** 24x24 line glyphs (stroke only, round caps). */
export const GLYPHS = {
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  revive: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
  invoice: 'M6 3h9l4 4v14H6zM9 13.2l2.4 2.4L16 11',
  spark: 'M12 3l2.1 5.9L20 11l-5.9 2.1L12 19l-2.1-5.9L4 11l5.9-2.1z',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4M9 15.5l2 2 4-4',
  wrench: 'M14.7 6.3a4.5 4.5 0 0 0-5.7 5.7L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5L11.500 14.500a4.500 4.500 0 0 0 5.700-5.700l-2.700 2.700-2.300-.5-.5-2.300z',
  scorecard: 'M5 20V11M12 20V4M19 20v-6',
  plate: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  match: 'M10 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM14 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
};

export const PRODUCTS = {
  leadrevive: { name: 'LeadRevive', glyph: 'revive' },
  dunningdesk: { name: 'DunningDesk', glyph: 'invoice' },
  pingpulse: { name: 'PingPulse', glyph: 'pulse' },
  quoteforge: { name: 'QuoteForge', glyph: 'spark' },
  stockwise: { name: 'StockWise', glyph: 'cube' },
  settlecheck: { name: 'SettleCheck', glyph: 'match' },
  platecost: { name: 'PlateCost', glyph: 'plate' },
  renewalradar: { name: 'RenewalRadar', glyph: 'calendar' },
  servicedue: { name: 'ServiceDue', glyph: 'wrench' },
  supplierscore: { name: 'SupplierScore', glyph: 'scorecard' },
};

const FONT = "ui-sans-serif, Inter, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Each product has its own palette (themes.js); the shared defaults are only a fallback. */
const scheme = (mode, slug) => {
  const th = THEMES[slug];
  if (!th) return mode === 'dark' ? { bg: COLORS.ink, tile: COLORS.lime, glyph: COLORS.ink, word: COLORS.paper } : { bg: COLORS.paper, tile: COLORS.ink, glyph: COLORS.lime, word: COLORS.ink };
  return mode === 'dark' ? { bg: th.dark.bg, tile: th.accent, glyph: th.ink, word: '#f1f4f2' } : { bg: th.light.bg, tile: th.dark.bg, glyph: th.accent, word: '#101412' };
};

const glyphEl = (g, color, x = 0, y = 0, size = 24) =>
  `<path transform="translate(${x} ${y}) scale(${size / 24})" d="${GLYPHS[g]}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Square mark: rounded tile with the glyph. */
export function markSvg(glyph, mode = 'dark', { size = 96, product } = {}) {
  const c = scheme(mode, product);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96" role="img"><rect width="96" height="96" rx="26" fill="${c.tile}"/>${glyphEl(glyph, c.glyph, 20, 20, 56)}</svg>\n`;
}

/** Horizontal lockup: mark + wordmark, on a transparent background. */
export function lockupSvg(name, glyph, mode = 'dark', product) {
  const c = scheme(mode, product);
  const w = Math.round(64 + name.length * 19.5);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="48" viewBox="0 0 ${w} 48" role="img" aria-label="${name}"><rect width="48" height="48" rx="13" fill="${c.tile}"/>${glyphEl(glyph, c.glyph, 10, 10, 28)}<text x="62" y="32" font-family="${FONT}" font-size="26" font-weight="650" letter-spacing="-0.6" fill="${c.word}">${name}</text></svg>\n`;
}

/** Favicon that follows the viewer's light/dark setting. */
export function faviconSvg(glyph, product) {
  const d = scheme('dark', product);
  const l = scheme('light', product);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><style>.t{fill:${d.tile}}.g{stroke:${d.glyph}}@media (prefers-color-scheme:light){.t{fill:${l.tile}}.g{stroke:${l.glyph}}}</style><rect class="t" width="96" height="96" rx="26"/><path class="g" transform="translate(20 20) scale(2.333)" d="${GLYPHS[glyph]}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`;
}

/** Inline glyph for the in-app logo tile (colours come from CSS). */
export const glyphPath = (g) => GLYPHS[g] ?? GLYPHS.pulse;
