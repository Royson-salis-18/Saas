// Helpers for integration-testing an app over real HTTP with an in-memory database.

/** Cookie-jar HTTP client that never follows redirects (so tests can assert on them). */
export class Client {
  constructor(base, slug) {
    this.base = base;
    this.slug = slug;
    this.jar = new Map();
    this.token = null;
  }

  async request(method, path, { form, json, headers = {}, body } = {}) {
    const h = { ...headers };
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k.endsWith('[]') ? k : `${k}[]`, x));
        else if (v !== undefined && v !== null) p.append(k, v);
      }
      payload = p.toString();
    } else if (json) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a)) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    const m = text.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (m) this.token = m[1];
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }

  get(path, opts) {
    return this.request('GET', path, opts);
  }

  /** POST a form; fetches a CSRF token first when logged in and none is cached. */
  async post(path, form = {}, opts = {}) {
    if (!this.token && opts.csrf !== false) await this.get('/account');
    const f = opts.csrf === false ? form : { _csrf: this.token, ...form };
    return this.request('POST', path, { ...opts, form: f });
  }

  async signup(email = 'owner@example.com', password = 'correct horse battery', extra = {}) {
    const res = await this.post('/signup', { name: 'Test Owner', email, password, currency: 'USD', ...extra }, { csrf: false });
    await this.get('/account');
    return res;
  }
}

export async function startTestApp(factory, options = {}) {
  const clock = { t: options.start ?? Date.UTC(2026, 9, 25, 9, 0, 0) };
  const app = factory({
    dbPath: ':memory:',
    env: { NODE_ENV: 'test', ...(options.env ?? {}) },
    now: () => clock.t,
    ...(options.config ?? {}),
  });
  const server = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    clock,
    client: () => new Client(base, app.config.slug),
    async close() {
      app.stopJobs();
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
      app.db.close();
    },
  };
}
