# SettleCheck

Compare what you expected to be paid with what you received (marketplace payouts, bank statements, any two CSVs)
and list references that are missing, paid the wrong amount, or not in your list.

- Runs entirely in the browser. No backend, no accounts, no storage. The page's Content-Security-Policy sets
  `connect-src 'none'`, so it cannot send data anywhere.
- Works on any CSV: you pick the reference and amount columns. It does not depend on any marketplace's format.
- Reports only. It does not file, send or pay anything.

```bash
npm test         # logic tests
npm start        # http://localhost:3006 (or host /public on any static host with the same CSP header)
```

`public/terms.html` and `public/privacy.html` are templates: fill in the placeholders and have a lawyer review them
for your country before launch. This is not legal advice.
