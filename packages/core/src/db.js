import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const bind = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/** Thin wrapper over node:sqlite with a statement cache and synchronous transactions. */
export class Db {
  constructor(raw) {
    this.raw = raw;
    this.cache = new Map();
    this.depth = 0;
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 500) this.cache.clear();
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...bind(params));
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...bind(params)) ?? null;
  }

  run(sql, ...params) {
    const r = this.stmt(sql).run(...bind(params));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /** Run fn inside a transaction. fn must be synchronous. Nested calls join the outer one. */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.raw.close();
  }
}

const CORE_MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    plan TEXT NOT NULL DEFAULT 'free',
    plan_expires_at INTEGER,
    stripe_customer_id TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX outbox_user_time ON outbox(user_id, created_at);
  CREATE TABLE billing_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

function migrate(db, scope, list) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    scope TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL,
    PRIMARY KEY (scope, version))`);
  const done = new Set(
    db.all('SELECT version FROM schema_migrations WHERE scope = ?', scope).map((r) => r.version),
  );
  list.forEach((sql, i) => {
    const version = i + 1;
    if (done.has(version)) return;
    db.tx(() => {
      db.exec(sql);
      db.run(
        'INSERT INTO schema_migrations (scope, version, applied_at) VALUES (?, ?, ?)',
        scope,
        version,
        Date.now(),
      );
    });
  });
}

export function openDb(file, appMigrations = []) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(
    'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;',
  );
  const db = new Db(raw);
  migrate(db, 'core', CORE_MIGRATIONS);
  migrate(db, 'app', appMigrations);
  return db;
}
