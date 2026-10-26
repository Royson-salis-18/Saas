// One visual identity per product: palette (dark + light), corner radius, heading face, and a `skin`
// that switches structural CSS in app.css. Colours are the only place a product's accent is defined.
const t = (skin, accent, ink, lightInk, radius, font, dark, light) => ({ skin, accent, ink, lightInk, radius, font, dark, light });

export const THEMES = {
  // warm ember on charcoal: friendly, sales-y
  leadrevive: t('ember', '#ff8a4c', '#1a0d06', '#fff7f1', 18, 'sans',
    { bg: '#110c0a', bg2: '#160f0c', surface: '#1a1311', surface2: '#221916' },
    { bg: '#fbf3ee', bg2: '#f5e8e0', surface: '#ffffff', surface2: '#fbf5f1' }),
  // ledger blue on navy, serif headings: finance, trust
  dunningdesk: t('ledger', '#6f8fff', '#060b1d', '#ffffff', 10, 'serif',
    { bg: '#080c18', bg2: '#0c1222', surface: '#101729', surface2: '#161e34' },
    { bg: '#f6f4ec', bg2: '#eeebe0', surface: '#fffefa', surface2: '#f8f6ee' }),
  // terminal green on pure black, mono: ops, uptime
  pingpulse: t('terminal', '#2dffa8', '#00130b', '#ffffff', 6, 'mono',
    { bg: '#000000', bg2: '#050806', surface: '#0a0d0b', surface2: '#0f1411' },
    { bg: '#eef3ef', bg2: '#e2e9e4', surface: '#ffffff', surface2: '#f4f8f5' }),
  // gold on graphite, serif: craft, proposals
  quoteforge: t('atelier', '#f2b84b', '#1c1204', '#fff8e8', 14, 'serif',
    { bg: '#111010', bg2: '#161514', surface: '#1b1a18', surface2: '#232120' },
    { bg: '#f8f3e8', bg2: '#efe8d8', surface: '#fffdf7', surface2: '#faf5e9' }),
  // cyan on slate, dense: logistics
  stockwise: t('warehouse', '#2cd4f2', '#031319', '#ffffff', 8, 'sans',
    { bg: '#0a101b', bg2: '#0e1522', surface: '#121a29', surface2: '#18223a' },
    { bg: '#eef3f8', bg2: '#e2eaf2', surface: '#ffffff', surface2: '#f3f7fb' }),
  // rose on plum-black, very round: food, warmth
  platecost: t('kitchen', '#ff5d7a', '#1f0309', '#fff5f6', 28, 'sans',
    { bg: '#130a10', bg2: '#190d14', surface: '#1f1119', surface2: '#281621' },
    { bg: '#fdf1f2', bg2: '#f8e3e6', surface: '#ffffff', surface2: '#fdf6f7' }),
  // violet on deep indigo: time, orbit
  renewalradar: t('orbit', '#a78bfa', '#0f0824', '#ffffff', 16, 'sans',
    { bg: '#0a0818', bg2: '#0f0c20', surface: '#141129', surface2: '#1b1735' },
    { bg: '#f4f1fc', bg2: '#eae5f8', surface: '#ffffff', surface2: '#f7f4fd' }),
  // magenta on aubergine-black, flat and tabular: reconciliation (standalone static app)
  settlecheck: t('ledgerpink', '#ff6bd6', '#1f0719', '#ffffff', 8, 'sans',
    { bg: '#0d090d', bg2: '#120c12', surface: '#171017', surface2: '#1f1620' },
    { bg: '#faf3f8', bg2: '#f3e7ef', surface: '#ffffff', surface2: '#fcf6fa' }),
  // amber-lime on olive-black: planned / maintenance
  servicedue: t('workshop', '#f7c948', '#1c1500', '#ffffff', 10, 'sans',
    { bg: '#0f0f0a', bg2: '#14140d', surface: '#191912', surface2: '#21211a' },
    { bg: '#f7f6ec', bg2: '#eeecdb', surface: '#ffffff', surface2: '#f9f8ee' }),
  // sky on ink: measurement
  supplierscore: t('scoreboard', '#5ab0ff', '#02101f', '#ffffff', 12, 'sans',
    { bg: '#080d14', bg2: '#0c131d', surface: '#111a27', surface2: '#172335' },
    { bg: '#eef4fb', bg2: '#e1ebf6', surface: '#ffffff', surface2: '#f3f8fd' }),
};
