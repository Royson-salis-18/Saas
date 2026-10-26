# PlateCost (extracted from the SaaS suite)

Small B2B product on one zero-dependency Node 22 platform (`packages/core`): accounts, sessions + CSRF,
plan limits, Stripe/Razorpay billing, email, scheduled jobs, SQLite.

| App | Port | What it does |
|---|---|---|
| `apps/platecost` | 3007 | Recipe and menu costing: food-cost %, margin, price-change impact |

```bash
npm install          # links workspaces (LeadRevive also installs @anthropic-ai/sdk)
npm test
npm run start:platecost   # see .env.example for configuration
```

Requires Node >= 22.13 (uses built-in `node:sqlite`). Data is stored in `DATA_DIR/<app>.db`.
Not yet done: live payment/email/AI calls were only tested with mocks; legal pages are placeholders.
