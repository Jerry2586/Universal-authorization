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
  const root = mkdtempSync(join(tmpdir(), 'appgog-appearance-ui-'));
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
  const output = resolve(process.env.APPGOG_UI_OUTPUT || '.codex-tmp/appearance-ui'); mkdirSync(output, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
    const errors = [], failedAssets = [];
    async function pageFor(context) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.url().includes('/assets/') && response.status() >= 400) failedAssets.push(response.url()); });
      return page;
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'light' });
    const page = await pageFor(context);
    const theme = async (page, value) => {
      await page.locator('[data-theme-control]:visible .appearance-trigger').click();
      await page.locator('.appearance-menu:visible [data-appearance="' + value + '"]').click();
      await page.waitForFunction(mode => document.documentElement.dataset.portalAppearance === mode, value);
    };
    const overflow = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page must not overflow horizontally');
    const darkSurface = async page => {
      const color = await page.locator('.surface:visible, .admin-entry-card:visible').first().evaluate(element => getComputedStyle(element).backgroundColor);
      assert.equal(color, 'rgb(23, 26, 33)', 'dark surface must use the semantic dark palette');
    };
    await page.goto(base + '/admin');
    assert.equal(await page.locator('html').getAttribute('data-portal-theme'), 'light');
    await theme(page, 'dark'); await darkSurface(page);
    await page.screenshot({ path: join(output, 'admin-login-dark.png'), fullPage: true, animations: 'disabled' });
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-portal-theme'), 'dark');
    await page.locator('.appearance-trigger:visible').focus(); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('html').getAttribute('data-portal-appearance'), 'light');
    assert.equal(await page.locator('.appearance-trigger:visible').evaluate(element => element === document.activeElement), true);
    await page.locator('.appearance-trigger:visible').click(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.appearance-menu:visible').count(), 0);
    await page.locator('.appearance-trigger:visible').click(); await page.locator('#admin-login-title').click();
    assert.equal(await page.locator('.appearance-menu:visible').count(), 0);
    await theme(page, 'system'); await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.portalTheme === 'dark');
    await theme(page, 'light'); await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.locator('html').getAttribute('data-portal-theme'), 'light');
    await page.locator('#login-form [name=username]').fill('fixture-admin');
    await page.locator('#login-form [name=password]').fill('fixture-local-password');
    await page.locator('#login-form [type=submit]').click(); await page.locator('#dashboard-view').waitFor({ state: 'visible' });
    await overflow(page); await page.screenshot({ path: join(output, 'admin-overview-light.png'), fullPage: true, animations: 'disabled' });
    await theme(page, 'dark'); await darkSurface(page);
    await page.screenshot({ path: join(output, 'admin-overview-dark.png'), fullPage: true, animations: 'disabled' });
    await page.locator('[data-view=licenses]').click(); await page.locator('[data-page=licenses]').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(output, 'admin-licenses-dark.png'), fullPage: true, animations: 'disabled' });
    // A real issued license exercises the existing authorization and quota controllers.
    const issued = app.service.issueLicense({ customerRef: 'APPEARANCE-DEMO', domain: 'preview.example.com', planCode: 'paid' });
    await page.locator('#refresh-admin').click();
    await page.locator('[data-view=licenses]').click();
    const other = await pageFor(context); await other.goto(base + '/build');
    assert.equal(await other.locator('html').getAttribute('data-portal-theme'), 'dark');
    await theme(page, 'light');
    await other.waitForFunction(() => document.documentElement.dataset.portalTheme === 'light');
    await other.locator('[name=license_key]').fill(issued.licenseKey);
    await other.locator('#login-form [type=submit]').click(); await other.locator('#dashboard-view').waitFor({ state: 'visible' });
    await overflow(other); await other.screenshot({ path: join(output, 'customer-overview-light.png'), fullPage: true, animations: 'disabled' });
    await theme(other, 'dark'); await darkSurface(other);
    assert.equal(await page.locator('.badge.success').first().evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(23, 46, 38)');
    await other.screenshot({ path: join(output, 'customer-overview-dark.png'), fullPage: true, animations: 'disabled' });
    await other.locator('[data-view=builds]').click(); await other.locator('[data-page=builds]').waitFor({ state: 'visible' });
    await other.screenshot({ path: join(output, 'customer-builds-dark.png'), fullPage: true, animations: 'disabled' });
    await other.locator('[data-view=tickets]').click(); await other.locator('#open-customer-ticket').click();
    await other.locator('dialog[open]').waitFor({ state: 'visible' });
    const dialog = await other.locator('dialog[open]').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
    assert.equal(dialog.background, 'rgb(23, 26, 33)');
    await other.screenshot({ path: join(output, 'customer-ticket-dialog-dark.png'), fullPage: true, animations: 'disabled' });
    await other.keyboard.press('Escape');
    await page.locator('#open-account-center').click();
    await page.locator('.modal-card').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.modal-card').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 26, 33)');
    await page.screenshot({ path: join(output, 'admin-account-dialog-dark.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.locator('.modal-card').waitFor({ state: 'hidden' });
    for (const current of [page, other]) {
      await current.setViewportSize({ width: 390, height: 844 });
      await overflow(current);
      assert.equal(await current.locator('.sidebar-toggle').isVisible(), false);
      await current.locator('.mobile-menu').click();
      await current.locator('[data-view=overview]').click();
      await current.locator('[data-page=overview]').waitFor({ state: 'visible' });
      await overflow(current);
      await current.screenshot({ path: join(output, current === page ? 'admin-mobile-dark.png' : 'customer-mobile-dark.png'), fullPage: true, animations: 'disabled' });
    }
    const blocked = await browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
    const blockedPage = await pageFor(blocked); await blockedPage.goto(base + '/admin');
    assert.equal(await blockedPage.locator('html').getAttribute('data-portal-theme'), 'dark');
    await theme(blockedPage, 'light'); await overflow(blockedPage);
    await blockedPage.screenshot({ path: join(output, 'login-mobile-light.png'), fullPage: true, animations: 'disabled' });
    const invalid = await browser.newContext({ colorScheme: 'light' });
    await invalid.addInitScript(() => localStorage.setItem('appgog:portal:appearance', 'invalid-preference'));
    const invalidPage = await pageFor(invalid); await invalidPage.goto(base + '/build');
    assert.equal(await invalidPage.locator('html').getAttribute('data-portal-appearance'), 'system');
    assert.deepEqual(errors, []); assert.deepEqual(failedAssets, []);
    console.log('PASS: real admin/customer login and navigation; light/dark/system, refresh persistence, keyboard, Escape/outside close, cross-tab sync, invalid/blocked storage, dark dialog, mobile overflow, no asset or browser errors.');
    console.log('Screenshots: ' + output);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
