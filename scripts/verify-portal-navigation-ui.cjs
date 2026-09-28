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
    const version=JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version;
    // Reproduce an already-open old document while the real API serves the upgraded runtime.
    const staleDocument = async route => {const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replaceAll('v'+version,'v1.2.48')});};
    await page.route(base+'/admin',staleDocument);
    await page.goto(base+'/admin');
    await page.waitForFunction(v=>document.getElementById('login-system-version').textContent==='v'+v,version);
    await page.locator('#login-form [name=username]').fill(config.adminUsername);
    await page.locator('#login-form [name=password]').fill(config.adminPassword);
    await page.locator('#login-form [type=submit]').click();await page.locator('#dashboard-view').waitFor({state:'visible'});
    await page.waitForFunction(v=>document.getElementById('admin-system-version').textContent==='v'+v,version);
    await page.locator('[data-view=cms]').click();
    await page.waitForFunction(v=>document.getElementById('update-current-version').textContent==='v'+v,version);
    const expanded=await page.locator('.app-sidebar').boundingBox();
    await page.getByRole('button',{name:'收起目录',exact:true}).click();
    assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-expanded'),'false');
    const collapsed=await page.locator('.app-sidebar').boundingBox();assert.ok(collapsed.width<expanded.width/2);
    await page.getByRole('button',{name:'套餐管理',exact:true}).click();
    await page.locator('[data-page=plans]').waitFor({state:'visible'});
    await page.screenshot({path:join(output,'admin-directory-collapsed.png'),fullPage:true});
    await page.reload();await page.locator('#dashboard-view').waitFor({state:'visible'});
    assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-expanded'),'false');
    await page.getByRole('button',{name:'展开目录',exact:true}).focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('.sidebar-toggle').getAttribute('aria-expanded'),'true');
    await page.getByRole('button',{name:'收起目录',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('.sidebar-toggle').isVisible(),false);
    await page.getByRole('button',{name:'打开导航',exact:true}).click();
    await page.locator('.nav-item[data-view=plans] > span:last-child').waitFor({state:'visible'});
    await page.getByRole('button',{name:'套餐管理',exact:true}).click();
    assert.ok(!(await page.locator('#dashboard-view').getAttribute('class')).includes('nav-open'));
    const issued=app.service.issueLicense({customerRef:'NAV-UI',domain:'nav.example.com',planCode:'paid'});
    const customerContext=await browser.newContext({viewport:{width:1440,height:1000}});
    const customer=await customerContext.newPage();customer.on('pageerror',error=>errors.push(error.message));
    await customer.route(base+'/build',staleDocument);await customer.goto(base+'/build');
    await customer.locator('[name=license_key]').fill(issued.licenseKey);await customer.locator('#login-form [type=submit]').click();
    await customer.locator('#dashboard-view').waitFor({state:'visible'});
    await customer.waitForFunction(v=>document.getElementById('customer-system-version').textContent==='v'+v,version);
    assert.equal(await customer.locator('.sidebar-toggle').getAttribute('aria-expanded'),'true');
    await customer.getByRole('button',{name:'收起目录',exact:true}).click();
    await customer.locator('[data-view=builds]').click();await customer.locator('[data-page=builds]').waitFor({state:'visible'});
    await customer.reload();await customer.locator('#dashboard-view').waitFor({state:'visible'});
    assert.equal(await customer.locator('.sidebar-toggle').getAttribute('aria-expanded'),'false');
    await customer.screenshot({path:join(output,'customer-directory-collapsed.png'),fullPage:true});
    await customer.evaluate(()=>{document.getElementById('customer-system-version').textContent='v1.2.48';window.dispatchEvent(new Event('focus'));});
    await customer.waitForFunction(v=>document.getElementById('customer-system-version').textContent==='v'+v,version);
    assert.deepEqual(errors,[]);
    console.log('PASS: real API runtime version replaces old document badges; admin/customer collapse, navigation, persistence, keyboard and mobile drawer.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
