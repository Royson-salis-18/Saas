// Pure monitoring logic: state transitions, heartbeat deadlines, SSL alert
// thresholds and uptime maths. No I/O, so everything here is unit-testable.

import { daysBetween } from '@saas/core';

export const SSL_THRESHOLDS = [14, 7, 3, 1];

/**
 * Debounced up/down state machine.
 * A monitor goes DOWN only after `threshold` consecutive failures (so one blip
 * doesn't page anyone) and recovers on the first success.
 * Returns { state, failCount, transition: null | 'down' | 'up' }.
 */
export function nextState({ state = 'pending', failCount = 0 }, ok, threshold = 2) {
  if (ok) {
    return { state: 'up', failCount: 0, transition: state === 'down' ? 'up' : null };
  }
  const fails = failCount + 1;
  if (state === 'down') return { state: 'down', failCount: fails, transition: null };
  if (fails >= threshold) return { state: 'down', failCount: fails, transition: 'down' };
  return { state, failCount: fails, transition: null };
}

/** Has a heartbeat (cron job) monitor missed its deadline? */
export function heartbeatStatus(m, nowMs) {
  const reference = m.last_ping_at ?? m.created_at;
  const deadline = reference + (m.interval_s + m.grace_s) * 1000;
  return { late: nowMs > deadline, deadline, overdueS: Math.max(0, Math.round((nowMs - deadline) / 1000)) };
}

export const sslDaysLeft = (expiresOn, today) => (expiresOn ? daysBetween(today, expiresOn) : null);

/**
 * Which SSL-expiry alert (if any) should fire now? `alertedAt` is the smallest
 * threshold already alerted for the current certificate (null if none).
 * Expired certificates alert at 0. Returns a threshold number or null.
 */
export function sslAlert(daysLeft, alertedAt) {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return alertedAt === 0 ? null : 0;
  const crossed = SSL_THRESHOLDS.filter((t) => daysLeft <= t);
  if (!crossed.length) return null;
  const tightest = Math.min(...crossed);
  return alertedAt !== null && alertedAt !== undefined && alertedAt <= tightest ? null : tightest;
}

/** Percentage with 2 decimals, or null with no data. */
export function pct(ok, total) {
  return total > 0 ? Math.round((ok / total) * 10000) / 100 : null;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Split recent checks into `n` equal time buckets: 'up' | 'down' | 'none'. */
export function timeline(checks, nowMs, spanMs, n = 48) {
  const size = spanMs / n;
  const start = nowMs - spanMs;
  const out = Array.from({ length: n }, () => ({ ok: 0, bad: 0 }));
  for (const c of checks) {
    const i = Math.floor((c.at - start) / size);
    if (i < 0 || i >= n) continue;
    if (c.ok) out[i].ok++;
    else out[i].bad++;
  }
  return out.map((b) => (b.bad ? 'down' : b.ok ? 'up' : 'none'));
}

export const INTERVALS = [
  [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [3600, '1 hour'],
];
export const HEARTBEAT_PERIODS = [
  [60, 'every minute'], [300, 'every 5 minutes'], [900, 'every 15 minutes'], [3600, 'hourly'],
  [21600, 'every 6 hours'], [43200, 'every 12 hours'], [86400, 'daily'], [604800, 'weekly'],
];
export const GRACE_PERIODS = [
  [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'],
];

export const slugOk = (s) => /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(s) && !/--/.test(s);
export const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'www', 'status', 'login', 'signup', 'ping', 'static', 'billing', 'account']);
