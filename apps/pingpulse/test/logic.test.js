import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, heartbeatStatus, nextState, pct, slugOk, sslAlert, sslDaysLeft, timeline } from '../src/logic.js';

test('two consecutive failures are needed to go down; first success recovers', () => {
  let s = { state: 'up', failCount: 0 };
  s = nextState(s, false, 2);
  assert.deepEqual(s, { state: 'up', failCount: 1, transition: null });
  s = nextState(s, true, 2);
  assert.deepEqual(s, { state: 'up', failCount: 0, transition: null }, 'a blip resets the counter');
  s = nextState(nextState(s, false, 2), false, 2);
  assert.equal(s.state, 'down');
  assert.equal(s.transition, 'down');
  s = nextState(s, false, 2);
  assert.equal(s.transition, null, 'no repeated down alerts');
  s = nextState(s, true, 2);
  assert.equal(s.state, 'up');
  assert.equal(s.transition, 'up');
});

test('threshold 1 alerts immediately; pending monitors never "recover"', () => {
  assert.equal(nextState({ state: 'up', failCount: 0 }, false, 1).transition, 'down');
  assert.equal(nextState({ state: 'pending', failCount: 0 }, true, 2).transition, null);
  assert.equal(nextState({ state: 'pending', failCount: 0 }, false, 2).state, 'pending');
  assert.equal(nextState({ state: 'pending', failCount: 1 }, false, 2).transition, 'down');
});

test('heartbeat deadline = last ping + period + grace (or creation time if never pinged)', () => {
  const m = { interval_s: 3600, grace_s: 300, last_ping_at: 1_000_000, created_at: 0 };
  const deadline = 1_000_000 + 3900 * 1000;
  assert.equal(heartbeatStatus(m, deadline).late, false);
  const late = heartbeatStatus(m, deadline + 61_000);
  assert.equal(late.late, true);
  assert.equal(late.overdueS, 61);
  assert.equal(heartbeatStatus({ ...m, last_ping_at: null }, 3900 * 1000 + 1).late, true);
  assert.equal(heartbeatStatus({ ...m, last_ping_at: null }, 3900 * 1000).late, false);
});

test('SSL alerts fire once per threshold as expiry approaches, and again after renewal', () => {
  assert.equal(sslAlert(30, null), null);
  assert.equal(sslAlert(14, null), 14);
  assert.equal(sslAlert(13, 14), null, 'already alerted at 14');
  assert.equal(sslAlert(7, 14), 7);
  assert.equal(sslAlert(6, 7), null);
  assert.equal(sslAlert(3, 7), 3);
  assert.equal(sslAlert(1, 3), 1);
  assert.equal(sslAlert(0, 1), 0);
  assert.equal(sslAlert(-4, 0), null);
  assert.equal(sslAlert(2, null), 3, 'a monitor added late jumps straight to the tightest threshold crossed');
  assert.equal(sslAlert(null, null), null);
  assert.equal(sslDaysLeft('2026-11-08', '2026-10-25'), 14);
  assert.equal(sslDaysLeft(null, '2026-10-25'), null);
});

test('uptime percentage and durations', () => {
  assert.equal(pct(9990, 10000), 99.9);
  assert.equal(pct(1, 3), 33.33);
  assert.equal(pct(0, 0), null);
  assert.deepEqual(['45s', '5m', '2h 5m', '3d 2h'], [45_000, 300_000, 7_500_000, 266_400_000].map(fmtDuration));
});

test('timeline marks any failure in a bucket as down and empty buckets as none', () => {
  const now = 48 * 1000;
  const span = 48 * 1000; // 1s buckets
  const checks = [
    { at: 1000, ok: 1 },
    { at: 1500, ok: 1 },
    { at: 5500, ok: 0 },
    { at: 5600, ok: 1 },
    { at: -5, ok: 1 }, // out of range
  ];
  const t = timeline(checks, now, span, 48);
  assert.equal(t.length, 48);
  assert.equal(t[1], 'up');
  assert.equal(t[5], 'down');
  assert.equal(t[0], 'none');
  assert.equal(t[47], 'none');
});

test('status page slugs', () => {
  for (const ok of ['acme', 'acme-status', 'a1b', 'x'.repeat(40)]) assert.ok(slugOk(ok), ok);
  for (const bad of ['ab', '-acme', 'acme-', 'ac--me', 'Acme', 'ac me', 'a'.repeat(41), '../x']) assert.ok(!slugOk(bad), bad);
});
