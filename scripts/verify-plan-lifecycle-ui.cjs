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
    assert.equal(await customer.locator('#customer-plan-name').textContent(),'当前套餐：定义版');
    await customer.locator('[data-view=builds]').click();
    const product=app.repository.productByCode('appgog');
    database.prepare("INSERT INTO source_versions (id,product_id,version,display_name,source_kind,source_ref,status,access_tier,created_at,published_at) VALUES ('ui-release',?,'9.0.0','测试版本','official','fixture.zip','active','free',?,?)").run(product.id,new Date().toISOString(),new Date().toISOString());
    await page.locator('[data-view=plans]').click();
    for(const name of ['定义版','免费版']) {
      const row=page.locator('#plan-list tr').filter({has:page.locator('strong',{hasText:name})});
      await row.getByRole('button',{name:'删除',exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:'删除套餐',exact:true}).click();
      await page.locator('.modal-overlay').waitFor({state:'detached'});
      await row.waitFor({state:'detached'});
    }
    await page.locator('[data-view=licenses]').click();
    const row=page.locator('#license-list tr').filter({hasText:'LIFECYCLE-UI'});
    assert.equal((await row.locator('.license-plan-cell').textContent()).trim(),'更改套餐');
    await row.getByRole('button',{name:'更改套餐',exact:true}).click();
    let dialog=page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await dialog.getByRole('button',{name:'确认切换'}).isDisabled(),true);
    assert.ok((await dialog.textContent()).includes('暂无其他可用套餐'));
    assert.ok((await dialog.textContent()).includes('套餐已删除 · 保留原权益'));
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.modal-overlay').waitFor({state:'detached'});
    await customer.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await customer.getByText('套餐已删除，当前授权保留原权益；如需调整请联系管理员更改套餐。',{exact:true}).waitFor();
    assert.ok(!(await customer.locator('#version-catalog').textContent()).includes('免费授权可用'));
    await customer.getByText('当前套餐可用',{exact:true}).waitFor();
    await customer.screenshot({path:join(output,'deleted-plan-customer.png'),fullPage:true});
    // Create externally after the overview loaded: the dialog must fetch fresh candidates.
    app.service.createLicensePlan({code:'ui-new',name:'自定义新套餐',accessTier:'paid_only',status:'active',capabilities:['settings:read','updates:read'],limits:{max_builds_per_day:7,max_activations:2}});
    await row.getByRole('button',{name:'更改套餐',exact:true}).click();dialog=page.getByRole('dialog');await dialog.waitFor();
    assert.equal(await dialog.locator('select').inputValue(),'ui-new');
    await dialog.getByRole('button',{name:'确认切换',exact:true}).click();await page.locator('.modal-overlay').waitFor({state:'detached'});
    assert.equal((await row.locator('.license-plan-cell').textContent()).trim(),'更改套餐');
    await row.getByRole('button',{name:'更改套餐',exact:true}).click();
    await page.getByRole('dialog').getByText('当前套餐：自定义新套餐',{exact:true}).waitFor();
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.modal-overlay').waitFor({state:'detached'});
    await page.screenshot({path:join(output,'changed-plan-admin.png'),fullPage:true});
    await customer.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await customer.getByText('当前套餐：自定义新套餐',{exact:true}).waitFor();
    // The only free release is no longer eligible after the explicit paid-only switch.
    assert.ok(!(await customer.locator('#version-catalog').textContent()).includes('免费授权可用'));
    await customer.reload();await customer.locator('#dashboard-view').waitFor({state:'visible'});
    assert.equal(await customer.locator('#customer-plan-name').textContent(),'当前套餐：自定义新套餐');
    assert.deepEqual(errors,[]);
    console.log('PASS: deleted plan status, empty targets, fresh plan list, manual switch, customer focus/reload and browser errors.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    database.close(); rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
