import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { serveStatic } from '../apps/license-api/src/http/static.js';

test('combined entry opens operations directly and the saved landing page is outside both centers', async (t) => {
  const server = createServer((request, response) => {
    if (!serveStatic(new URL(request.url, 'http://localhost').pathname, response, 'entry-test')) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const entry of ['/', '/index.html', '/admin']) {
    const response = await fetch(`${base}${entry}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-portal="admin"/);
    assert.doesNotMatch(html, /landing-page|href="\/"/);
  }
  const build = await (await fetch(`${base}/build`)).text();
  assert.match(build, /id="build-login-title"/);
  assert.doesNotMatch(build, /landing-page|href="\/"/);
  assert.equal((await fetch(`${base}/design/landing-page/index.html`)).status, 404);
  const saved = readFileSync('design/landing-page/index.html', 'utf8');
  assert.match(saved, /主题授权与安全交付/);
  assert.doesNotMatch(saved, /href="\/(?:admin|build)"|<script/);
  for (const asset of ['site.css', 'logo.png', 'favicon.svg']) assert.ok(existsSync(`design/landing-page/assets/${asset}`));
});
