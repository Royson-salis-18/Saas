import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpCheck, isPrivateIp, parseTargetUrl, postJson, statusMatcher, validStatusSpec } from '../src/netcheck.js';
import { makeCert, startTarget, startTlsTarget } from './helpers.js';

test('private / reserved addresses are recognised (v4, v6, mapped, metadata)', () => {
  const blocked = ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'ff02::1'];
  for (const ip of blocked) assert.ok(isPrivateIp(ip), `${ip} should be blocked`);
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  for (const ip of allowed) assert.ok(!isPrivateIp(ip), `${ip} should be allowed`);
  assert.ok(isPrivateIp('not-an-ip'), 'unparseable addresses are refused');
});

test('monitor URLs are validated', () => {
  assert.ok(parseTargetUrl('https://example.com/health').url);
  for (const bad of ['', 'example.com', 'ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@example.com', 'http://localhost:3000', 'http://foo.localhost', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://intranet.local', 'http://db.internal']) {
    assert.ok(parseTargetUrl(bad).error, `${bad} should be rejected`);
  }
  assert.ok(parseTargetUrl('http://127.0.0.1:8080/', { allowPrivate: true }).url, 'dev override');
});

test('status code specs', () => {
  const m = statusMatcher('200-299, 404');
  assert.ok(m(200) && m(299) && m(404));
  assert.ok(!m(500) && !m(302));
  assert.ok(statusMatcher('')(204), 'empty spec falls back to 200-399');
  assert.ok(validStatusSpec('200-399') && validStatusSpec('200,204') && validStatusSpec(' 200 - 299 , 404 '));
  assert.ok(!validStatusSpec('abc') && !validStatusSpec('20') && !validStatusSpec('200-') && !validStatusSpec(''));
});

test('httpCheck: success, failure statuses, keyword, headers', async () => {
  const target = await startTarget({ body: 'Welcome to Acme' });
  try {
    const ok = await httpCheck({ url: target.url, allowPrivate: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.latencyMs >= 0);
    assert.match(target.state.hits[0].ua, /PingPulse/);

    assert.equal((await httpCheck({ url: target.url, allowPrivate: true, keyword: 'Acme' })).ok, true);
    const missing = await httpCheck({ url: target.url, allowPrivate: true, keyword: 'Nope' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Keyword "Nope" not found/);

    target.state.status = 503;
    const down = await httpCheck({ url: target.url, allowPrivate: true });
    assert.equal(down.ok, false);
    assert.equal(down.statusCode, 503);
    assert.match(down.error, /Unexpected status 503/);

    assert.equal((await httpCheck({ url: target.url, allowPrivate: true, expected: '503' })).ok, true, 'custom expected status');

    target.state.status = 200;
    const head = await httpCheck({ url: target.url, allowPrivate: true, method: 'HEAD' });
    assert.equal(head.ok, true);
    assert.equal(target.state.hits.at(-1).method, 'HEAD');
  } finally {
    await target.close();
  }
});

test('httpCheck follows redirects and judges the final response', async () => {
  const target = await startTarget();
  try {
    assert.equal((await httpCheck({ url: `${target.url}/redirect-ok`, allowPrivate: true })).ok, true);
    const bad = await httpCheck({ url: `${target.url}/redirect-to-500`, allowPrivate: true });
    assert.equal(bad.ok, false, 'a redirect to an error page is DOWN even though 3xx is in the default spec');
    assert.equal(bad.statusCode, 500);
    const loop = await httpCheck({ url: `${target.url}/redirect-loop`, allowPrivate: true });
    assert.equal(loop.ok, false);
    assert.match(loop.error, /Too many redirects/);
    const ftp = await httpCheck({ url: `${target.url}/redirect-ftp`, allowPrivate: true });
    assert.match(ftp.error, /unsupported protocol/);
    const noFollow = await httpCheck({ url: `${target.url}/redirect-to-500`, allowPrivate: true, followRedirects: false });
    assert.equal(noFollow.ok, true, 'with follow off the 301 itself is judged');
    assert.equal(noFollow.statusCode, 301);
  } finally {
    await target.close();
  }
});

test('httpCheck reports timeouts, refused connections and DNS failures without throwing', async () => {
  const slow = await startTarget({ delayMs: 1500 });
  try {
    const t0 = Date.now();
    const r = await httpCheck({ url: slow.url, allowPrivate: true, timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.error, /Timed out/);
    assert.ok(Date.now() - t0 < 1200, 'gives up near the timeout');
  } finally {
    await slow.close();
  }
  const closed = await startTarget();
  const url = closed.url;
  await closed.close();
  assert.match((await httpCheck({ url, allowPrivate: true })).error, /refused/i);
  assert.match((await httpCheck({ url: 'http://no-such-host.invalid/', timeoutMs: 3000 })).error, /DNS/);
  assert.equal((await httpCheck({ url: 'not a url' })).error, 'Invalid URL');
});

test('SSRF: private targets are refused at connect time (literals and DNS names)', async () => {
  const target = await startTarget();
  try {
    const attempts = [target.url, `http://localhost:${target.port}`, `http://[::1]:${target.port}`, 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0.0.0.0:80/'];
    for (const url of attempts) {
      const r = await httpCheck({ url, timeoutMs: 2000 });
      assert.equal(r.ok, false, url);
      assert.match(r.error, /Blocked|private/i, `${url} -> ${r.error}`);
    }
    assert.equal(target.state.hits.length, 0, 'nothing ever reached the internal server');
  } finally {
    await target.close();
  }
});

test('webhook delivery uses the same SSRF protection', async () => {
  const target = await startTarget();
  try {
    const blocked = await postJson(`${target.url}/hook`, { a: 1 });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Blocked/);
    assert.equal(target.state.hits.length, 0);
    assert.equal((await postJson(`${target.url}/hook`, { a: 1 }, { allowPrivate: true })).ok, true);
    assert.equal(target.state.hits.at(-1).method, 'POST');
    assert.equal((await postJson('ftp://x/y', {})).ok, false);
  } finally {
    await target.close();
  }
});

const creds = makeCert(10);
test('TLS: untrusted certificates fail; trusted ones report expiry date', { skip: !creds && 'openssl unavailable' }, async () => {
  const tls = await startTlsTarget(creds);
  try {
    const untrusted = await httpCheck({ url: tls.url, allowPrivate: true });
    assert.equal(untrusted.ok, false);
    assert.match(untrusted.error, /not trusted/);

    const trusted = await httpCheck({ url: tls.url, allowPrivate: true, tls: { ca: creds.cert } });
    assert.equal(trusted.ok, true);
    const days = Math.round((Date.parse(trusted.sslExpiresOn) - Date.now()) / 86400000);
    assert.ok(days >= 9 && days <= 11, `expiry ~10 days away, got ${days}`);
  } finally {
    await tls.close();
  }
});
