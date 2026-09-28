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
    const issued=app.service.issueLicense({customerRef:'LIFECYCLE-UI',domain:'ui.example.com',planCode:'paid'});
    const customerContext=await browser.newContext({viewport:{width:1440,height:1000}});
    const customer=await customerContext.newPage(); customer.on('pageerror',error=>errors.push(error.message));
    await customer.goto(base+'/build');
    await customer.locator('[name=license_key]').fill(issued.licenseKey);
    await customer.locator('#login-form [type=submit]').click();
    await customer.locator('#dashboard-view').waitFor({state:'visible'});
    assert.equal(await customer.locator('#customer-plan-name').textContent(),'你的套餐：付费版');
    await page.locator('[data-view=versions]').click();
    const zip=writeZip(new Map([['config.json',Buffer.from('{"name":"APPGOG","version":"9.0.0"}')],['index.html',Buffer.from('<html><head></head><body>Fixture</body></html>')]]));
    await page.locator('#version-form [type=submit]').click();
    await page.locator('#release-publish-status').getByText('请选择主题 ZIP',{exact:true}).waitFor();
    await page.locator('#source-zip').setInputFiles({name:'APPGOG-9.0.0.zip',mimeType:'application/zip',buffer:zip});
    await page.locator('#version-form [type=submit]').click();
    await page.locator('#release-publish-status').getByText('请选择至少一个可用套餐',{exact:true}).waitFor();
    await page.locator('#version-search').fill('不存在的版本');
    await page.locator('#release-plan-options input[value=paid]').check();
    await page.locator('#version-form [type=submit]').click();
    await page.getByRole('button',{name:'设置套餐',exact:true}).waitFor();
    assert.equal(await page.locator('#version-search').inputValue(),'');
    assert.ok((await page.locator('#release-publish-status').textContent()).includes('已发布'));
    await page.locator('#source-zip').setInputFiles({name:'APPGOG-9.0.0.zip',mimeType:'application/zip',buffer:zip});
    await page.locator('#release-plan-options input[value=paid]').check();
    await page.locator('#version-form [type=submit]').click();
    await page.locator('#release-publish-status').getByText('该版本已经发布',{exact:true}).waitFor();
    assert.equal(await page.locator('#version-form [type=submit]').isDisabled(),false);
    await customer.locator('[data-view=builds]').click();
    await customer.reload();await customer.locator('#dashboard-view').waitFor();
    await customer.locator('#version-catalog').getByText('APPGOG 9.0.0',{exact:true}).waitFor();
    assert.ok((await customer.locator('#version-catalog').textContent()).includes('付费版'));
    await page.locator('[data-view=plans]').click();
    const paidRow=page.locator('#plan-list tr').filter({has:page.locator('strong',{hasText:'付费版'})});
    assert.equal(await paidRow.getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
    assert.throws(()=>app.service.deleteLicensePlan({code:'paid',actorId:'fixture'}),e=>e.code==='PLAN_HAS_LICENSES');
    await page.locator('[data-view=licenses]').click();
    const row=page.locator('#license-list tr').filter({hasText:'LIFECYCLE-UI'});
    assert.equal((await row.locator('.license-plan-cell').textContent()).trim(),'更改套餐');
    await row.getByRole('button',{name:'更改套餐',exact:true}).click();
    let dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.locator('select').selectOption('free');
    await dialog.getByRole('button',{name:'确认切换',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    await customer.reload();await customer.locator('#dashboard-view').waitFor();
    assert.equal(await customer.locator('#customer-plan-name').textContent(),'你的套餐：免费版');
    assert.ok(!(await customer.locator('#version-catalog').textContent()).includes('9.0.0'));
    await page.locator('[data-view=versions]').click();
    await page.getByRole('button',{name:'设置套餐',exact:true}).click();
    dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.locator('input[value=paid]').uncheck();await dialog.locator('input[value=free]').check();
    await dialog.getByRole('button',{name:'保存套餐',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    await customer.reload();await customer.locator('#dashboard-view').waitFor();
    await customer.locator('#version-catalog').getByText('APPGOG 9.0.0',{exact:true}).waitFor();
    assert.ok((await customer.locator('#version-catalog').textContent()).includes('免费版'));
    await customer.screenshot({path:join(output,'your-plan-customer.png'),fullPage:true});
    await page.locator('[data-view=plans]').click();
    await paidRow.getByRole('button',{name:'删除',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'删除套餐',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});await paidRow.waitFor({state:'detached'});
    await page.locator('[data-view=versions]').click();
    assert.equal(await page.locator('#release-plan-options input[value=paid]').count(),0);
    await page.screenshot({path:join(output,'version-plan-admin.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: real ZIP publishing, plan-bound visibility, assigned-plan deletion guard, same-key plan switch, release reassignment and your-plan display.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
