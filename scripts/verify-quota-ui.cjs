const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['/admin','/build'].includes(url.pathname)) {
        const admin = url.pathname === '/admin';
        let html = await fs.readFile('apps/web/public/' + (admin ? 'admin.html' : 'build.html'), 'utf8');
        html = html.replace(/<script src="\/assets\/[^\"]+" type="module"><\/script>/g, '');
        const setup = `window.license={id:'test',customer_ref:'ORDER-1001',status:'active',bound_domain:'example.com',plan_code:'paid',plan_name:'付费版',key_prefix:'APPGOG-TEST',max_builds_per_day:5,builds_used_last_24_hours:1,max_builds_total:10,build_count:9,total_builds_used:9};window.state={session:{is_owner:true},data:{license,versions:[{version:'1.19.11',display_name:'APPGOG',eligible:true,is_latest:true,is_latest_eligible:true,release_notes:'修复已知问题',access_tier:'paid'}],builds:[],tickets:[]}};window.writes=[];const shell={state,can:()=>true,request:async(url,options)=>{writes.push({url,...options});if(options?.body?.max_builds_total===null)license.max_builds_total=null;return{};},notify:()=>{},refresh:async()=>window.rerender(),selectView:()=>{},showSecret:()=>{},dialog:()=>{},actions:()=>{}};
          document.querySelector('#login-view').hidden=true;document.querySelector('#dashboard-view').hidden=false;document.querySelectorAll('.page-view').forEach(n=>n.classList.toggle('active',n.dataset.page==='${admin ? 'licenses' : 'overview'}'));`;
        const module = admin ? `import{createLicenseUi}from'/assets/portal/licenses.js';${setup}const ui=createLicenseUi(shell);ui.bind();window.rerender=()=>ui.renderLicenseManager([license]);rerender();document.querySelector('#license-list').replaceChildren(ui.licenseRow(license));`
          : `import{createCustomerPage}from'/assets/portal/customer-page.js';${setup}const ui=createCustomerPage(shell);window.rerender=()=>ui.render(state.data);rerender();`;
        html = html.replace('</body>', '<script type="module">' + module + ';window.ready=true;</script></body>');
        return route.fulfill({ contentType:'text/html; charset=utf-8', body:html });
      }
      const file=path.join('apps/web/public',url.pathname);
      try { return route.fulfill({ body:await fs.readFile(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'image/png' }); }
      catch { return route.fulfill({status:404,body:''}); }
    });
    await page.goto('http://fixture.local/admin'); await page.waitForFunction(()=>window.ready);
    await page.getByRole('button',{name:'打包额度',exact:true}).click();
    assert.equal(await page.locator('#managed-license-available').innerText(),'1 次');
    const form=page.locator('#license-quota-form');
    await form.locator('[name=max_builds_total]').fill('20');await form.locator('[name=reason]').fill('续费增加额度');
    await page.evaluate(()=>rerender());
    assert.equal(await form.locator('[name=max_builds_total]').inputValue(),'20');
    assert.equal(await form.locator('[name=reason]').inputValue(),'续费增加额度');
    await form.locator('[name=total_mode]').selectOption('unlimited');
    assert.equal(await form.locator('[name=max_builds_total]').isVisible(),false);
    await form.locator('button[type=submit]').click();
    assert.equal(await page.evaluate(()=>writes[0].body.max_builds_total),null);
    assert.equal(await page.locator('#managed-license-available').innerText(),'4 次');
    await form.locator('[name=total_mode]').selectOption('limited');
    await form.locator('[name=max_builds_total]').fill('12');await form.locator('[name=reason]').fill('设置有限次数');
    await form.locator('button[type=submit]').click();
    assert.equal(await page.evaluate(()=>writes[1].body.max_builds_total),12);
    await fs.mkdir('.codex-tmp',{recursive:true});
    await page.locator('.license-management-panel').screenshot({path:'.codex-tmp/quota-admin44.png'});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('.license-management-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    await page.setViewportSize({width:1440,height:1050});
    await page.goto('http://fixture.local/build');await page.waitForFunction(()=>window.ready);
    assert.equal(await page.locator('#license-limit').innerText(),'1 次');
    assert.equal(await page.locator('.delivery-flow-disclosure').getAttribute('open'),null);
    assert.equal(await page.getByRole('button',{name:'开始打包',exact:true}).count(),1);
    await page.locator('.quota-inline-details summary').click();
    assert.match(await page.locator('#customer-quota-total').innerText(),/10.*9/);
    await page.evaluate(()=>{license.total_builds_used=10;rerender();});
    assert.equal(await page.locator('#license-limit').innerText(),'0 次');
    assert.match(await page.locator('#license-quota-note').innerText(),/总额度已用完/);
    await page.evaluate(()=>{license.total_builds_used=9;rerender();});
    await page.locator('[data-page=overview]').screenshot({path:'.codex-tmp/quota-customer44.png'});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('[data-page=overview]').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    assert.deepEqual(errors,[]);console.log('Quota UI passed: shared remaining, total limit choice, save payload, edit preservation, customer disclosure, narrow layout.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
