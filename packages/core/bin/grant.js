#!/usr/bin/env node
// Manually grant a plan (e.g. after a bank transfer / invoice payment):
//   npm run grant -- --db data/leadrevive.db --email a@b.com --plan pro --days 31
import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    email: { type: 'string' },
    plan: { type: 'string' },
    days: { type: 'string', default: '31' },
  },
});

if (!values.db || !values.email || !values.plan) {
  console.error('Usage: grant --db <file> --email <user email> --plan <plan key> [--days 31]');
  process.exit(1);
}

const db = openDb(values.db);
const days = Number(values.days);
const until = values.plan === 'free' ? null : Date.now() + days * 86400000;
const r = db.run('UPDATE users SET plan = ?, plan_expires_at = ? WHERE email = ?', values.plan, until, values.email.toLowerCase());
console.log(r.changes ? `Granted ${values.plan} to ${values.email}${until ? ` until ${new Date(until).toISOString().slice(0, 10)}` : ''}` : 'No such user');
db.close();
process.exit(r.changes ? 0 : 2);
