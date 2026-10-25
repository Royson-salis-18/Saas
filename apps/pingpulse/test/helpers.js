import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Local target whose behaviour tests can change on the fly. */
export async function startTarget(initial = {}) {
  const state = { status: 200, body: 'hello world', delayMs: 0, headers: {}, hits: [], ...initial };
  const server = http.createServer((req, res) => {
    state.hits.push({ url: req.url, ua: req.headers['user-agent'], method: req.method });
    const respond = () => {
      if (req.url === '/redirect-ok') {
        res.writeHead(302, { location: '/' });
        return res.end();
      }
      if (req.url === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' });
        return res.end();
      }
      if (req.url === '/redirect-to-500') {
        res.writeHead(301, { location: '/boom' });
        return res.end();
      }
      if (req.url === '/boom') {
        res.writeHead(500);
        return res.end('boom');
      }
      if (req.url === '/redirect-ftp') {
        res.writeHead(302, { location: 'ftp://example.com/x' });
        return res.end();
      }
      res.writeHead(state.status, state.headers);
      res.end(state.body);
    };
    state.delayMs ? setTimeout(respond, state.delayMs) : respond();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    state,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

/** Self-signed cert for 127.0.0.1 valid for `days`. Returns null when openssl is unavailable. */
export function makeCert(days) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pp-cert-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', String(days), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startTlsTarget(creds) {
  const server = https.createServer({ key: creds.key, cert: creds.cert }, (req, res) => res.end('secure ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    url: `https://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

export async function startHookReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { received, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}
