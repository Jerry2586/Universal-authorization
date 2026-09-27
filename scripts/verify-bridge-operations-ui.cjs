// Local browser regression: actual operations HTML/CSS/module with a simulated Xboard connection BFF.
const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let state = { connected: false, busy: false, state: 'idle', message: '请连接目标 Xboard 站点', log: [] }, failRead = false;
    const writes = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/web/admin/system/bridge')) {
        if (failRead) return route.fulfill({ status: 503, json: { message: '测试连接中断' } });
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON(); writes.push({ path: url.pathname, body });
          if (url.pathname.endsWith('/connect')) state = { ...state, connected: true, origin: body.origin, current_version: '1.1.0', expires_at: new Date(Date.now() + 1200000).toISOString(), message: '已连接，请检查更新' };
          if (body.action === 'check-update') state = { ...state, latest_version: '1.1.3', installable: true, checked_at: new Date().toISOString(), message: '可更新到授权桥 1.1.3' };
          if (body.action === 'install-version') state = { ...state, current_version: '1.1.3', installable: false, repairable: true, state: 'succeeded', message: '授权桥 1.1.3 健康检查通过，安装身份保持不变', log: ['签名校验通过', '健康检查通过'] };
          if (body.action === 'repair-current') state = { ...state, message: '修复完成，安装身份保持不变' };
          if (url.pathname.endsWith('/disconnect')) state = { connected: false, state: 'idle', message: '请连接目标 Xboard 站点' };
        }
        return route.fulfill({ json: state });
      }
      if (url.pathname === '/admin') {
        let html = await fs.readFile('apps/web/public/admin.html', 'utf8');
        html = html.replace('<script src="/assets/admin-portal.js" type="module"></script>', '').replace('</body>', `<script type="module">
          import {createBridgeUpdateUi} from '/assets/portal/bridge-updates.js';
          document.querySelector('#login-view').hidden=true;document.querySelector('#dashboard-view').hidden=false;
          document.querySelectorAll('.page-view').forEach(n=>n.classList.toggle('active',n.dataset.page==='cms'));
          window.ui=createBridgeUpdateUi({can:()=>true,notify:message=>window.lastNotice=message,request:async(url,options={})=>{const r=await fetch(url,{...options,headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});if(!r.ok)throw Error('连接中断');return r.json();}});ui.bind();await ui.refresh();window.ready=true;
        </script></body>`);
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      const file = path.join('apps/web/public', url.pathname);
      try { return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://fixture.local/admin'); await page.waitForFunction(() => window.ready);
    assert.equal(await page.locator('#bridge-install').isDisabled(), true);
    const form = page.locator('#bridge-connect-form');
    await form.locator('[name=origin]').fill('https://panel.example.com');
    await form.locator('[name=admin_path]').fill('secure');
    await form.locator('[name=email]').fill('admin@example.com');
    await form.locator('[name=password]').fill('fixture-password');
    await page.locator('#bridge-connect').click();
    await page.waitForFunction(() => document.querySelector('#bridge-current').textContent === 'v1.1.0');
    assert.equal(await form.locator('[name=password]').inputValue(), '');
    await page.locator('#bridge-check').click(); await page.waitForFunction(() => !document.querySelector('#bridge-install').disabled);
    await page.locator('#bridge-install').click(); await page.waitForFunction(() => document.querySelector('#bridge-current').textContent === 'v1.1.3');
    await page.locator('#bridge-repair').click(); await page.waitForFunction(() => document.querySelector('#bridge-message').textContent.startsWith('修复完成'));
    assert.equal(writes.filter(x => x.body.action === 'install-version').length, 1);
    const card = page.locator('section[aria-labelledby="bridge-title"]');
    await fs.mkdir('.codex-tmp', { recursive: true });
    await card.screenshot({ path: '.codex-tmp/bridge-maintenance43.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    assert.ok(await card.evaluate(n => n.scrollWidth <= n.clientWidth + 1), 'Mobile bridge card overflows');
    failRead = true; await page.evaluate(() => ui.refresh());
    assert.equal(await page.locator('#bridge-install').isDisabled(), true); assert.equal(await page.locator('#bridge-repair').isDisabled(), true);
    failRead = false; await page.evaluate(() => ui.refresh()); await page.locator('#bridge-disconnect').click();
    await page.waitForFunction(() => !document.querySelector('#bridge-connect-fields').disabled);
    await form.locator('[name=password]').fill('unsent-password');
    await page.evaluate(() => document.dispatchEvent(new Event('appgog-session-cleared')));
    assert.equal(await form.locator('[name=password]').inputValue(), '');
    assert.deepEqual(errors, []);
    console.log('Bridge UI: connection, password clearing, check, update, repair, failure lock, narrow layout and session clearing passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
