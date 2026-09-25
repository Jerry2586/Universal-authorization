import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBuildCenterHandler } from '../apps/build-center/src/server.js';

const token = 'test-connectivity-token-at-least-32-characters';
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
function upstreamHandler(request, response) {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') { response.end(JSON.stringify({ ok: true, version: expectedVersion })); return; }
  if (request.url === '/web/session?actor=customer') {
    response.statusCode = request.headers['x-appgog-internal'] === token ? 401 : 403;
    response.end(JSON.stringify({ error: { code: response.statusCode === 401 ? 'SESSION_REQUIRED' : 'INTERNAL_AUTH_REQUIRED' } })); return;
  }
  response.setHeader('x-request-id', request.headers['x-request-id'] || 'upstream-generated-id');
  response.end(JSON.stringify({ ip: request.headers['x-forwarded-for'], request_id: request.headers['x-request-id'] }));
}

test('customer HTML and every recursive ES module load through the standalone build center', async t => {
  const { url } = await listen(t, createBuildCenterHandler({ internalToken: token }));
  const htmlResponse = await fetch(url + '/build');
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  const pending = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)].map(match => match[1]);
  const visited = new Set();
  while (pending.length) {
    const path = pending.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    const source = await response.text();
    if (!path.endsWith('.js')) continue;
    assert.match(response.headers.get('content-type'), /javascript/, path);
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) pending.push(new URL(match[1], url + path).pathname);
    }
  }
  assert.ok(visited.has('/assets/portal/shell.js'));
  assert.ok(visited.has('/assets/portal/api-client.js'));
  for (const path of ['/admin', '/assets/admin-portal.js', '/assets/portal/admin-page.js', '/assets/portal.js', '/.env']) {
    assert.equal((await fetch(url + path)).status, 404, path);
  }
});

test('proxy preserves trusted client IP and request IDs, and reports correlated errors', async t => {
  const upstream = await listen(t, upstreamHandler);
  const { url } = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token }));
  const response = await fetch(url + '/web/customer/overview', { headers: { 'x-forwarded-for': '192.0.2.23', 'x-request-id': 'connectivity-test-id' } });
  assert.equal(response.headers.get('x-request-id'), 'connectivity-test-id');
  assert.deepEqual(await response.json(), { ip: '192.0.2.23', request_id: 'connectivity-test-id' });
  for (const [path, status] of [['/missing', 404], ['/web/session?actor=admin', 403]]) {
    const result = await fetch(url + path);
    assert.equal(result.status, status);
    assert.equal((await result.json()).error.request_id, result.headers.get('x-request-id'));
    assert.ok(result.headers.get('x-request-id'));
  }
});

test('readiness checks resources, upstream availability and node credentials', async t => {
  const upstream = await listen(t, upstreamHandler);
  const good = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token }));
  assert.equal((await fetch(good.url + '/health')).status, 200);
  const wrong = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token + '-wrong' }));
  assert.equal((await fetch(wrong.url + '/health')).status, 503);
  const emptyRoot = mkdtempSync(join(tmpdir(), 'appgog-assets-'));
  t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
  const missing = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token, publicRoot: emptyRoot }));
  assert.equal((await fetch(missing.url + '/health')).status, 503);
  upstream.server.closeAllConnections();
  await new Promise(resolve => upstream.server.close(resolve));
  assert.equal((await fetch(good.url + '/health')).status, 503);
  const response = await fetch(good.url + '/web/customer/overview');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.request_id, response.headers.get('x-request-id'));
});

test('stalled upstream is terminated with a visible timeout error', async t => {
  const upstream = await listen(t, () => {});
  const { url } = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token, proxyTimeoutMs: 80 }));
  const response = await fetch(url + '/web/customer/overview', { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'LICENSE_CENTER_TIMEOUT');
});

test('both login pages and standalone health expose the package version; mixed versions fail readiness', async t => {
  const upstream = await listen(t, upstreamHandler);
  const good = await listen(t, createBuildCenterHandler({ internalUrl: upstream.url, internalToken: token }));
  const health = await fetch(good.url + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-appgog-version'), expectedVersion);
  assert.equal((await health.json()).version, expectedVersion);
  const page = await fetch(good.url + '/build').then(r => r.text());
  assert.ok(page.includes('id="login-system-version">v' + expectedVersion + '</span>'));
  assert.ok(page.includes('id="customer-system-version">v' + expectedVersion + '</strong>'));
  assert.ok(!page.includes('{{APPGOG_VERSION}}'));
  const old = await listen(t, (request, response) => {
    if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ok:true,version:'0.0.1'})); }
    else upstreamHandler(request, response);
  });
  const mixed = await listen(t, createBuildCenterHandler({ internalUrl: old.url, internalToken: token }));
  const mismatch = await fetch(mixed.url + '/health');
  assert.equal(mismatch.status, 503);
  const data = await mismatch.json();
  assert.equal(data.version, expectedVersion);
  assert.equal(data.upstream_version, '0.0.1');
  assert.equal(data.error.code, 'VERSION_MISMATCH');
});
