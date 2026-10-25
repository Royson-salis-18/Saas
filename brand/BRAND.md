# Brand

**Three core colours**

| Name | Hex | Used for |
|---|---|---|
| Ink | `#0A0D0B` | dark-mode background; light-mode logo tile and text |
| Lime | `#B8F23B` | the signal colour: dark-mode logo tile, light-mode glyph, primary buttons, highlights |
| Paper | `#F3F5EF` | light-mode background; dark-mode text and wordmark |

Everything else in the UI (greys, red/amber/green status colours) is a neutral or a functional colour derived from these.
In light mode, buttons and links use a deepened Lime so text stays readable.

**Logo**: a rounded tile with a one-stroke line glyph, plus a wordmark set in the system sans (semi-bold, tight tracking).

| Mode | Tile | Glyph | Wordmark |
|---|---|---|---|
| Dark | Lime | Ink | Paper |
| Light | Ink | Lime | Ink |

Files are in `brand/logos/` (`*-mark-*.svg`, `*-lockup-*.svg`, `*-favicon.svg`). The favicon switches colours with the viewer's system theme.
Regenerate everything with `node scripts/build-brand.js`; the source is `packages/core/src/brand.js`.
Keep clear space around the mark equal to a quarter of its width, and don't recolour, stretch or add effects.
