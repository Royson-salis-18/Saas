# SaaS suite

Five small B2B products on one zero-dependency Node 22 platform (`packages/core`): accounts, sessions + CSRF,
plan limits, Stripe/Razorpay billing, email, scheduled jobs, SQLite.

| App | Port | What it does |
|---|---|---|
| `apps/leadrevive` | 3001 | Finds cold leads, drafts follow-ups (templates or Claude), tracks recovered revenue |
| `apps/dunningdesk` | 3002 | Chases overdue invoices on a polite escalating schedule |
| `apps/pingpulse` | 3003 | Uptime, SSL expiry and cron-heartbeat monitoring + public status pages |
| `apps/quoteforge` | 3004 | Branded quotes with GST/tax and one-click client acceptance |
| `apps/stockwise` | 3005 | Reorder points, purchase orders, dead-stock cash report |

```bash
npm install          # links workspaces (LeadRevive also installs @anthropic-ai/sdk)
npm test             # 165 tests
npm run start:dunningdesk   # or any other app; see .env.example for configuration
```

Requires Node >= 22.13 (uses built-in `node:sqlite`). Data is stored in `DATA_DIR/<app>.db`.
Not yet done: live payment/email/AI calls were only tested with mocks; legal pages are placeholders.
