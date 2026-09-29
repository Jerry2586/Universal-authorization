const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/admin') {
        let html = await fs.readFile('apps/web/public/admin.html', 'utf8');
        html = html.replace('<script src="/assets/admin-portal.js" type="module"></script>', '').replace('</body>', `<script type="module">
          import {createOperationsUi} from '/assets/portal/operations.js';
          document.querySelector('#login-view').hidden=true;
          document.querySelector('#dashboard-view').hidden=false;
          document.querySelectorAll('.page-view').forEach(node=>node.classList.toggle('active',node.dataset.page==='cms'));
          window.state={available:true,state:'idle',current_version:'1.2.52',latest_version:'1.2.53',check_status:'succeeded',freshness:'fresh',relation:'update_available',installable:true,version_lock:{locked:false,version:null,valid:true}};
          window.calls=[];window.reloads=0;window.failNextGet=false;window.notice='';
          let sequence=0;
          const request=async(url,options)=>{
            if(url.includes('/bridge'))return{current_version:'1.1.7',message:'组件已就绪',repairable:true};
            if(options){
              calls.push({url,...options});
              if(url.endsWith('/lock')){state.version_lock={locked:options.body.locked,version:state.current_version,valid:true};state.installable=!options.body.locked&&state.relation==='update_available';return structuredClone(state);}
              const action=options.body.action,id='upd-live-'+(++sequence),version=action==='install-version'?state.latest_version:state.current_version;
              state={...state,state:'queued',request_id:id,requested_action:action,target_version:version,installable:false,message:'更新请求已排队'};
              setTimeout(()=>{state.state='running';state.message='正在执行';},20);
              setTimeout(()=>{state.state='succeeded';state.message='操作完成';if(action==='install-version'){state.current_version=version;state.relation='up_to_date';state.installable=false;}},70);
              return{id,action,version};
            }
            if(failNextGet){failNextGet=false;throw Error('连接中断');}
            return structuredClone(state);
          };
          window.ui=createOperationsUi({can:()=>true,notify:(message,error)=>{window.notice=message;window.noticeError=error;},request,reload:()=>{window.reloads+=1;},pollInterval:10});
          ui.bind();await ui.refresh();window.ready=true;
        </script></body>`);
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      const file = path.join('apps/web/public', url.pathname);
      try { return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png' }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    });

    await page.goto('http://fixture.local/admin');
    await page.waitForFunction(() => window.ready);
    await page.locator('#toggle-version-lock').click();
    await page.waitForFunction(() => document.querySelector('#toggle-version-lock').textContent === '解除版本锁定');
    assert.equal(await page.locator('#install-update').isDisabled(), true);
    assert.equal(await page.locator('#repair-current').isEnabled(), true);
    assert.equal(await page.locator('#check-update').isEnabled(), true);
    await page.locator('#toggle-version-lock').click();
    await page.waitForFunction(() => !document.querySelector('#install-update').disabled);

    await page.locator('#install-update').click();
    await page.waitForFunction(() => window.reloads === 1);
    assert.equal(await page.locator('#update-current-version').innerText(), 'v1.2.53');
    assert.match(await page.evaluate(() => window.notice), /自动刷新页面/);

    await page.evaluate(() => { state.state='idle';state.request_id=null;state.requested_action=null;state.message='已就绪';failNextGet=true; });
    await page.locator('#repair-current').click();
    await page.waitForFunction(() => window.reloads === 2);
    assert.match(await page.evaluate(() => window.notice), /修复完成/);

    const card = page.locator('.online-update-card').filter({ has: page.locator('#toggle-version-lock') });
    await fs.mkdir('.codex-tmp', { recursive: true });
    await card.screenshot({ path: '.codex-tmp/version-lock-live-refresh.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    assert.ok(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.deepEqual(errors, []);
    console.log('Platform update live refresh passed: lock controls, queued/running polling, transient reconnect, install/repair completion reload and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
