// Isolated browser acceptance: real local API and fresh database; never contacts production.
const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

(async () => {
  const { bootstrap } = await import('../apps/license-api/src/bootstrap.js');
  const { openDatabase } = await import('../apps/license-api/src/database.js');
  const { createHttpHandler } = await import('../apps/license-api/src/http.js');
  const { writeZip } = await import('../packages/core/src/zip.js');
  const root = mkdtempSync(join(tmpdir(), 'appgog-plan-ui-'));
  const database = openDatabase(':memory:');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const config = {
    pepper: 'fixture-product-pepper-longer-than-thirty-two-characters',
    sessionSecret: 'fixture-product-session-longer-than-thirty-two-characters',
    deliveryEncryptionKey: 'fixture-product-delivery-longer-than-thirty-two-characters',
    adminToken: 'fixture-only-admin-token', workerToken: 'fixture-only-worker-token',
    adminUsername: 'fixture-admin', adminPassword: 'fixture-local-password',
    publicBaseUrl: 'http://127.0.0.1', webSessionTtlSeconds: 28800,
    activationTokenTtlSeconds: 604800, buildTicketTtlSeconds: 900,
    artifactRoot: join(root, 'artifacts'), uploadRoot: join(root, 'uploads'),
    updateControlPath: join(root, 'updates'), maxSourceUploadBytes: 1024 * 1024,
  };
  const app = bootstrap({ database, config, privateKey, publicKey: pem });
  const server = createServer(createHttpHandler({ ...app, config, publicKey: pem }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const output = resolve(process.env.APPGOG_UI_OUTPUT || '.codex-tmp/plan-scope-ui'); mkdirSync(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/admin');
    await page.locator('#login-form [name=username]').fill(config.adminUsername);
    await page.locator('#login-form [name=password]').fill(config.adminPassword);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#dashboard-view').waitFor({ state: 'visible' });
    await page.locator('[data-view=plans]').click();
    const legacyPaid=page.locator('#plan-list tr').filter({has:page.locator('small.table-subline', {hasText:/^paid$/})});
    await legacyPaid.getByRole('button',{name:'编辑套餐',exact:true}).click();
    assert.equal(await page.getByRole('dialog').locator('[name=access_tier]').inputValue(),'paid_only');
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    await page.locator('#create-plan').click();
    let dialog = page.getByRole('dialog');
    assert.deepEqual(await dialog.locator('[name=access_tier] option').allTextContents(), ['免费版本','付费版本']);
    await dialog.locator('[name=name]').fill('独立付费套餐');
    await dialog.locator('[name=code]').fill('only-paid-ui');
    await dialog.locator('[name=access_tier]').selectOption('paid_only');
    await dialog.getByRole('button',{name:'保存套餐',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    const row=page.locator('#plan-list tr').filter({hasText:'only-paid-ui'});
    await row.waitFor();assert.ok((await row.textContent()).includes('付费版本'));
    await row.getByRole('button',{name:'编辑套餐',exact:true}).click();
    dialog=page.getByRole('dialog');assert.equal(await dialog.locator('[name=access_tier]').inputValue(),'paid_only');
    await dialog.locator('[name=name]').fill('单独付费已编辑');
    await dialog.getByRole('button',{name:'保存套餐',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    await page.reload();await page.locator('#dashboard-view').waitFor({state:'visible'});
    await page.locator('[data-view=plans]').click();
    const saved=page.locator('#plan-list tr').filter({hasText:'only-paid-ui'});await saved.waitFor();
    assert.ok((await saved.textContent()).includes('单独付费已编辑'));
    assert.ok((await saved.textContent()).includes('付费版本'));
    await saved.getByRole('button',{name:'编辑套餐',exact:true}).click();
    assert.equal(await page.getByRole('dialog').locator('[name=access_tier]').inputValue(),'paid_only');
    await page.screenshot({path:join(output,'paid-only-plan.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: two separate scopes, paid-only create/save/edit/reload and list labels; no browser errors.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
