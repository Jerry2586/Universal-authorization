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
  const root = mkdtempSync(join(tmpdir(), 'appgog-product-ui-'));
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
  const output = resolve(process.env.APPGOG_UI_OUTPUT || '.codex-tmp/product-ui'); mkdirSync(output, { recursive: true });
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
    await page.locator('[data-view=products]').click();
    await page.locator('#create-product').click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('[name=name]').fill('独立产品');
    await dialog.locator('[name=code]').fill('catalog-fixture');
    await dialog.getByRole('button', { name: '保存产品', exact: true }).click();
    await page.locator('.modal-overlay').waitFor({ state: 'detached' });
    const row = page.locator('#product-list tr').filter({ hasText: 'catalog-fixture' });
    await row.waitFor();
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    dialog = page.getByRole('dialog');
    assert.equal(await dialog.locator('[name=code]').getAttribute('readonly'), '');
    await dialog.locator('[name=name]').fill('独立主题产品');
    await dialog.getByRole('button', { name: '保存产品', exact: true }).click();
    await page.locator('.modal-overlay').waitFor({ state: 'detached' });
    assert.match(await row.innerText(), /独立主题产品/);
    assert.equal(await page.locator('#license-product option[value="catalog-fixture"]').count(), 1);
    await page.screenshot({ path: join(output, 'products-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.locator('[data-view=licenses]').click();
    await page.locator('#license-product').selectOption('catalog-fixture');
    await page.locator('#license-form [name=customer_ref]').fill('UI-selected-product');
    const issuedResponse = page.waitForResponse(response => response.url().endsWith('/web/admin/licenses') && response.request().method() === 'POST');
    await page.locator('#license-form [type=submit]').click();
    const issued = await issuedResponse;
    assert.equal(issued.status(), 201);
    const issuedData = await issued.json();
    assert.equal(app.repository.licenseById(issuedData.license_id).product_code, 'catalog-fixture');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.modal-overlay').waitFor({ state: 'detached' });
    await page.locator('[data-view=versions]').click();
    await page.locator('#version-product').selectOption('catalog-fixture');
    await page.locator('#release-plan-options input[value="paid"]').check();
    const zip = writeZip(new Map([['config.json', Buffer.from('{"name":"独立主题","version":"3.0.0"}')], ['index.html', Buffer.from('<html><head></head><body>Fixture</body></html>')]]));
    await page.locator('#source-zip').setInputFiles({ name: 'theme.zip', mimeType: 'application/zip', buffer: zip });
    const published = page.waitForResponse(response => response.url().includes('/web/admin/versions/upload'));
    await page.locator('#version-form [type=submit]').click();
    assert.equal((await published).status(), 201);
    await page.locator('#version-list .release-item').filter({ hasText: '独立主题产品' }).waitFor();
    await page.locator('#version-product-filter').selectOption('catalog-fixture');
    assert.equal(await page.locator('#version-list .release-item').count(), 1);
    await page.locator('[data-view=products]').click();
    await row.getByRole('button', { name: '归档', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认归档', exact: true }).click();
    await page.locator('.modal-overlay').waitFor({ state: 'detached' });
    assert.match(await row.innerText(), /已归档/);
    assert.equal(await page.locator('#license-product option[value="catalog-fixture"]').count(), 0);
    assert.equal(await page.locator('#version-product option[value="catalog-fixture"]').count(), 0);
    await row.getByRole('button', { name: '恢复', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).click();
    await page.locator('.modal-overlay').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#license-product option[value="catalog-fixture"]').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, 'products-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'product page horizontal overflow');
    const license = app.service.issueLicense({ customerRef: 'UI fixture', domain: 'fixture.example.com' });
    await page.goto(base + '/build');
    await page.locator('#login-form [name=license_key]').fill(license.licenseKey);
    await page.locator('#login-form [type=submit]').click();
    await page.locator('#dashboard-view').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('[data-view=lifecycle]').click();
    assert.equal(await page.locator('.lifecycle-steps li').count(), 3);
    assert.equal(await page.locator('.lifecycle-card').count(), 4);
    await page.screenshot({ path: join(output, 'lifecycle-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, 'lifecycle-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'lifecycle page horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('PASS: product create/edit/archive/restore, upload selection, version filtering, mobile layout, lifecycle guide, no page errors.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
