// Run with APPGOG_PLAYWRIGHT_PATH when Playwright is not on Node's module path.
const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}),
    headless: true,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 760, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const script = await fs.readFile('apps/build-worker/xboard-bridge/AppgogLicenseBridge/assets/admin-entry.js', 'utf8');
    const { generateKeyPairSync } = require('node:crypto');
    const { browserLicenseRuntime } = await import('../apps/build-worker/src/runtime.js');
    const { signCompactToken } = await import('../packages/core/src/signing.js');
    const keys = generateKeyPairSync('ed25519');
    const der = keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
    const runtimeConfig = {p:'appgog',v:'1.19.11',b:'bld_ui_fixture',i:'pkg_ui_fixture',u:'https://license.example.com',k:der,a:der,q:der,n:der,s:[],o:[],
      gc:'appgog_license_bridge',gv:'1.1.5',gt:'APPGOG',j:'/fixture-bridge.zip',y:'00',
      m:signCompactToken({typ:'package-manifest',product:'appgog',build_id:'bld_ui_fixture',package_id:'pkg_ui_fixture',version:'1.19.11',domain:'fixture.example.com'},keys.privateKey)};
    let enabled = 0;
    await context.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/theme/getThemes')) return route.fulfill({ json: {
        data: { themes: { APPGOG: { name: 'APPGOG', appgog_activation: { schema: 1 } } } },
      } });
      if (path.endsWith('/config/save')) {
        enabled++;
        return route.fulfill({ json: { data: true } });
      }
      if (path.endsWith('/plugin/getPlugins')) return route.fulfill({json:{data:[]}});
      if (path.endsWith('/health') || path.endsWith('/admin-context')) return route.fulfill({status:404,json:{}});
      if (path === '/fixture-bridge.zip') return route.fulfill({body:Buffer.from('PK\x03\x04wrong-zip')});
      if (path.endsWith('/editor.html')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><script>('+browserLicenseRuntime.toString()+')('+JSON.stringify(runtimeConfig)+');</script></body>' });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset=utf-8>
<style>body{font:16px system-ui;background:#f5f6fa;padding:20px}.card{position:relative;background:white;border:1px solid #dfe4ed;border-radius:20px;padding:30px;max-width:550px;margin-bottom:20px}.delete{position:absolute;right:12px;top:12px;width:36px;height:36px;padding:0}footer{display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;margin-top:35px}button{padding:12px 20px;border:1px solid #dfe4ed;border-radius:9px;background:white}.primary{background:#101828;color:white}h3{font-size:26px;margin:0 0 12px}p{color:#667085}</style>
<article class=card id=protected><button class=delete aria-label=删除>×</button><div><h3>APPGOG</h3><p>APPGOG · 可配置品牌、客户端下载、节日活动与营销弹窗</p><p>版本：1.19.11</p></div><footer><button id=settings>主题设置</button><button class=primary id=activate onclick="fetch('/api/v2/secure/config/save',{method:'POST'})">激活主题</button></footer></article>
<article class=card id=other><div><h3>Other Theme</h3></div><footer><button>主题设置</button><button>激活主题</button></footer></article>
<script>window.settings={secure_path:'secure'};localStorage.setItem('XBOARD_ACCESS_TOKEN',JSON.stringify({value:'fixture-token'}));window.originalControls=[document.querySelector('#settings'),document.querySelector('#activate')];</script><script>${script}</script>` });
    });
    await page.goto('https://fixture.example.com/secure#/config/theme');
    const action = page.locator('[data-appgog-theme-action]');
    await action.waitFor();
    assert.equal(await page.locator('#settings').isVisible(), false);
    assert.equal(await page.locator('#activate').isVisible(), false);
    assert.equal(await page.locator('#other button:visible').count(), 2);
    assert.equal(await page.locator('#protected button:visible').count(), 2);
    assert.equal(await page.evaluate(() => originalControls.every(n => n.isConnected && n.parentElement.tagName === 'FOOTER')), true);
    await action.click();
    await page.locator('dialog[open]').waitFor();
    assert.equal(enabled, 0);
    const frame = page.frameLocator('dialog iframe');
    await frame.locator('#__appgog_gate').waitFor();
    assert.match(await frame.locator('#__appgog_setup_progress').innerText(), /准备失败，已停止/);
    assert.match(await frame.locator('#__appgog_card').innerText(), /与当前主题包不一致/);
    assert.equal(await frame.locator('#__appgog_card button:disabled').count(),0);
    assert.ok(await page.locator('dialog').evaluate(n=>n.scrollHeight<=n.clientHeight+1));
    assert.ok(await frame.locator('html').evaluate(n=>getComputedStyle(n).overflow==='hidden'));
    await frame.getByRole('button',{name:'重新检查并准备插件'}).click();
    await frame.locator('#__appgog_error').filter({hasText:'与当前主题包不一致'}).waitFor();
    await page.screenshot({path:'.codex-tmp/activation-dialog45.png'});
    await page.locator('dialog button').click();
    await page.locator('.delete').click();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    // Host state changes and translated text must not duplicate the custom entry.
    await page.locator('#activate').evaluate(n => { n.innerHTML = '<font>当前主题</font>'; n.disabled = true; });
    await page.waitForFunction(() => document.querySelectorAll('[data-appgog-theme-action]').length === 1);
    assert.equal(await page.locator('#activate').isVisible(), false);
    // Simulate host replacing its complete card footer during re-render.
    await page.locator('#protected footer').evaluate(n => {
      const replacement = document.createElement('footer');
      replacement.innerHTML = '<button id=settings>主题设置</button><button id=activate>激活主题</button>';
      n.replaceWith(replacement);
    });
    await action.waitFor();
    assert.equal(await page.locator('#protected button:visible').count(), 2);
    const layout = await action.evaluate(n => ({
      parent: n.parentElement.tagName, position: getComputedStyle(n).position,
      right: n.getBoundingClientRect().right, cardRight: n.closest('.card').getBoundingClientRect().right,
    }));
    assert.equal(layout.parent, 'FOOTER');
    assert.equal(layout.position, 'static');
    assert.ok(layout.right < layout.cardRight);
    if (process.env.APPGOG_UI_SCREENSHOT) await page.screenshot({ path: process.env.APPGOG_UI_SCREENSHOT });
    await action.click();
    await page.locator('dialog[open]').waitFor();
    assert.equal(enabled, 0);
    await page.locator('dialog button').click();
    await page.setViewportSize({ width: 390, height: 800 });
    assert.ok(await action.evaluate(n => n.getBoundingClientRect().right <= document.documentElement.clientWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ nativeActionsHidden: true, nativeNodesPreserved: true, otherThemesUnchanged: true,
      singleActivationEntry: true, deleteUnaffected: true, rerenderPassed: true, narrowLayoutPassed: true, enabledRequests: enabled }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
