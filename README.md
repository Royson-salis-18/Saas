# pingpulse (extracted from the SaaS suite)

Five small B2B products on one zero-dependency Node 22 platform (`packages/core`): accounts, sessions + CSRF,
plan limits, Stripe/Razorpay billing, email, scheduled jobs, SQLite.

| App | Port | What it does |
|---|---|---|
| `apps/pingpulse` | 3003 | Uptime, SSL expiry and cron-heartbeat monitoring + public status pages |

```bash
npm install          # links workspaces (LeadRevive also installs @anthropic-ai/sdk)
npm test
npm run start:pingpulse   # see .env.example for configuration
```

Requires Node >= 22.13 (uses built-in `node:sqlite`). Data is stored in `DATA_DIR/<app>.db`.
Not yet done: live payment/email/AI calls were only tested with mocks; legal pages are placeholders.
