const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><table><tbody id=rows></tbody></table><script type=module>
        import {createLicenseUi} from '/assets/portal/licenses.js';
        window.copied=[];window.notices=[];window.requests=0;window.denied=false;
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async key=>{if(denied)throw Error('denied');copied.push(key);}}});
        const license={id:'fixture',customer_ref:'customer',key_prefix:'APPGOG-',key_recoverable:true,status:'active'};
        const ui=createLicenseUi({state:{session:{is_owner:true}},can:()=>true,request:async()=>{requests++;return{license_key:'FIXTURE-COMPLETE-KEY-ONLY'};},notify:(text,error)=>notices.push({text,error:!!error})});
        window.render=()=>rows.replaceChildren(ui.licenseRow(license));render();window.ready=true;
      </script>` });
      const file = path.join('apps/web/public', url.pathname);
      try { return route.fulfill({ body: await fs.readFile(file), contentType: 'text/javascript' }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('https://fixture.local/fixture'); await page.waitForFunction(() => window.ready);
    const key = page.locator('.license-key-value'), eye = page.locator('.license-key-eye');
    await key.click(); assert.equal(await page.evaluate(() => copied.length), 0);
    await eye.click(); assert.equal(await page.evaluate(() => copied.length), 0);
    assert.equal(await key.getAttribute('role'), 'button');
    await key.click(); assert.deepEqual(await page.evaluate(() => copied), ['FIXTURE-COMPLETE-KEY-ONLY']);
    assert.equal(await page.evaluate(() => notices.at(-1).text), '已复制');
    await key.press('Enter'); await key.press('Space');
    assert.equal(await page.evaluate(() => copied.length), 3);
    await page.evaluate(() => render()); await page.locator('.license-key-value').click();
    assert.equal(await page.evaluate(() => copied.length), 4);
    assert.equal(await page.evaluate(() => requests), 1);
    await page.evaluate(() => denied = true); await key.click();
    assert.equal(await page.evaluate(() => notices.at(-1).error), true);
    await eye.click(); await key.click();
    assert.equal(await key.getAttribute('role'), null);
    assert.equal(await page.evaluate(() => copied.length), 4);
    assert.deepEqual(errors, []);
    console.log('License Key copy: reveal-only, click/keyboard, rerender, permission failure and hidden-state checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
