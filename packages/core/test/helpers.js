import { createApp, html } from '../src/index.js';

export const plans = {
  free: { label: 'Free', price: { INR: 0, USD: 0 }, limits: { items: 2 } },
  pro: { label: 'Pro', price: { INR: 999, USD: 29 }, limits: { items: 50 }, featured: true },
};

export function makeFixtureApp(opts = {}) {
  const app = createApp({
    slug: 'fixture',
    name: 'Fixture',
    tagline: 'A fixture app',
    plans,
    limitLabels: { items: 'items' },
    nav: [{ href: '/dashboard', label: 'Dashboard' }],
    migrations: [`CREATE TABLE items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL)`],
    usage: (db, user) => ({ items: db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = ?', user.id).n }),
    marketing: { headline: 'Hello', sub: 'World', points: [{ title: 'A', body: 'B' }] },
    ...opts,
  });
  app.get('/dashboard', (ctx) => {
    const items = ctx.db.all('SELECT * FROM items WHERE user_id = ?', ctx.user.id);
    return ctx.page('Dashboard', html`<h1>Dash</h1><ul>${items.map((i) => html`<li>${i.name}</li>`)}</ul>`);
  });
  app.post('/items', (ctx) => {
    const n = ctx.db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = ?', ctx.user.id).n;
    const msg = ctx.checkLimit('items', n);
    if (msg) return ctx.redirect('/dashboard', { err: msg });
    ctx.db.run('INSERT INTO items (user_id, name) VALUES (?, ?)', ctx.user.id, String(ctx.body.name));
    return ctx.redirect('/dashboard', { ok: 'added' });
  });
  return app;
}
