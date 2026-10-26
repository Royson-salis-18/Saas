import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '@saas/core/testing';
import { createRenewalRadar } from '../src/app.js';

const boot = (options = {}) => startTestApp(createRenewalRadar, options);
const form = (o = {}) => ({ name: 'Zoho CRM', vendor: 'Zoho', category: 'Software', amount: '12000', cycle: 'yearly', renewal_date: '2026-12-20', notice_days: '20', auto_renew: '1', notes: '', ...o });
const row = (t, name) => t.app.db.get('SELECT * FROM contracts WHERE name = ?', name);

async function ready(t, plan = 'pro') {
  const c = t.client();
  await c.signup('owner@example.com', 'correct horse battery', { currency: 'INR' });
  t.app.db.run('UPDATE users SET plan = ?, plan_expires_at = ?', plan, t.clock.t + 30 * 86400000);
  return c;
}

test('landing page', async () => {
  const t = await boot();
  try {
    assert.match((await t.client().get('/')).text, /notice deadline/);
  } finally { await t.close(); }
});

test('add, view, edit and delete a contract; amounts stored in minor units', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/contracts', form());
    assert.equal(row(t, 'Zoho CRM').amount, 1200000);
    const id = row(t, 'Zoho CRM').id;
    assert.match((await c.get(`/contracts/${id}`)).text, /Zoho CRM/);
    await c.post(`/contracts/${id}/edit`, form({ amount: '15,000', notice_days: '10' }));
    assert.equal(row(t, 'Zoho CRM').amount, 1500000);
    assert.equal(row(t, 'Zoho CRM').notice_days, 10);
    assert.equal((await c.post('/contracts', form({ renewal_date: 'nonsense' }))).status, 400);
    await c.post(`/contracts/${id}/delete`, {});
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM contracts').n, 0);
  } finally { await t.close(); }
});

test('mark renewed rolls the date forward and clears reminder state; cancel counts as a saving', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/contracts', form());
    const id = row(t, 'Zoho CRM').id;
    t.app.db.run('UPDATE contracts SET reminder_for = renewal_date, reminder_level = 1 WHERE id = ?', id);
    await c.post(`/contracts/${id}/renewed`, {});
    assert.equal(row(t, 'Zoho CRM').renewal_date, '2027-12-20');
    assert.equal(row(t, 'Zoho CRM').reminder_level, null);
    await c.post(`/contracts/${id}/cancel`, {});
    assert.equal(row(t, 'Zoho CRM').status, 'cancelled');
    assert.match((await c.get('/dashboard')).text, /Saved by cancelling/);
    await c.post(`/contracts/${id}/reactivate`, {});
    assert.equal(row(t, 'Zoho CRM').status, 'active');
  } finally { await t.close(); }
});

test('contracts are private to their owner', async () => {
  const t = await boot();
  try {
    const a = await ready(t);
    await a.post('/contracts', form());
    const id = row(t, 'Zoho CRM').id;
    const b = t.client();
    await b.signup('other@example.com', 'correct horse battery', { currency: 'INR' });
    assert.equal((await b.get(`/contracts/${id}`)).status, 404);
    assert.equal((await b.post(`/contracts/${id}/delete`, {})).status, 404);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM contracts').n, 1);
  } finally { await t.close(); }
});

test('free plan limit blocks the 9th contract', async () => {
  const t = await boot();
  try {
    const c = await ready(t, 'free');
    for (let i = 1; i <= 9; i++) await c.post('/contracts', form({ name: `C${i}` }));
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM contracts').n, 8);
  } finally { await t.close(); }
});

test('csv import creates, updates by name+vendor, and reports bad rows; export round-trips', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    const csv = 'name,vendor,amount,cycle,renewal_date,notice_days,category\nSlack,Slack,"1,000",monthly,2026-12-01,30,Software\nOffice lease,Landlord,50000,monthly,2027-01-01,90,Rent\nBad,X,abc,yearly,2027-01-01,,';
    const r = await c.post('/import', { csv });
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM contracts').n, 2);
    assert.equal(r.status, 200);
    await c.post('/import', { csv: 'name,vendor,amount,cycle,renewal_date\nSlack,Slack,2000,monthly,2026-12-01' });
    assert.equal(row(t, 'Slack').amount, 200000);
    assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM contracts').n, 2);
    const out = (await c.get('/contracts.csv')).text;
    assert.match(out, /Office lease/);
  } finally { await t.close(); }
});

test('reminders: one email per level, to the alert address, none after renewal is rolled', async () => {
  const t = await boot();
  try {
    const c = await ready(t);
    await c.post('/settings', { lead_days: '14', alert_email: 'finance@example.com' });
    await c.post('/contracts', form({ renewal_date: '2026-12-20', notice_days: '20' })); // deadline 2026-11-30
    const sent = () => t.app.db.all('SELECT * FROM outbox').filter((m) => /Zoho/.test(m.subject));
    await t.app.runReminders({ force: true });
    assert.equal(sent().length, 0, 'deadline is 36 days away');
    t.clock.t += 25 * 86400000;
    await t.app.runReminders({ force: true });
    assert.equal(sent().length, 1);
    await t.app.runReminders({ force: true });
    assert.equal(sent().length, 1, 'idempotent');
    t.clock.t += 8 * 86400000;
    await t.app.runReminders({ force: true });
    assert.equal(sent().length, 2, 'next level');
    for (const m of sent()) assert.equal(m.to_email, 'finance@example.com');
    const id = row(t, 'Zoho CRM').id;
    await c.post(`/contracts/${id}/renewed`, {});
    await t.app.runReminders({ force: true });
    assert.equal(sent().length, 2, 'rolled forward: nothing due');
  } finally { await t.close(); }
});
