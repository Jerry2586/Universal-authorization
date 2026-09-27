// Real build center HTML/CSS/module with synthetic customer data; never touches production.
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
      if (url.pathname === '/build') {
        let html = await fs.readFile('apps/web/public/build.html', 'utf8');
        html = html.replace(/<script src="\/assets\/[^\"]+" type="module"><\/script>/g, '');
        html = html.replace('</body>', `<script type="module">
          import {createCustomerPage} from '/assets/portal/customer-page.js';
          window.state={data:{license:{bound_domain:'example.com',status:'active',max_builds_per_day:5,max_builds_total:10,total_builds_used:1,builds_used_last_24_hours:1},versions:[{version:'1.19.11',display_name:'APPGOG 1.19.11',is_current:true,is_latest:true,is_latest_eligible:true,eligible:true,channel:'stable',release_kind:'bugfix',access_tier:'free',published_at:'2026-09-27T01:39:24Z',release_notes:'修复本地弹窗与在线激活顺序、组件失效拦截及后台内嵌授权栏目。'}],builds:[],tickets:[]}};
          window.writes=[];window.historyRequests=[];
          const history=Array.from({length:25},(_,i)=>({id:'job-'+i,version:'1.19.11',domain:'example.com',status:i===1?'cancelled':'succeeded',progress:100,created_at:'2026-09-27T01:39:24Z',activation_label:i===2?'已激活':'未激活',can_download:false,quota_refunded_at:i===1?'2026-09-27T02:00:00Z':null}));
          const request=async(url,options)=>{if(url.includes('/builds?')){historyRequests.push(url);const u=new URL(url,location.origin),from=u.searchParams.get('cursor')?20:0;return{items:history.slice(from,from+20),has_more:from===0,next_cursor:from===0?'next':null};}writes.push({url,...options});return{id:'new'};};
          function selectView(view){document.querySelectorAll('.page-view').forEach(n=>n.classList.toggle('active',n.dataset.page===view));window.history.replaceState(null,'','#'+view);}
          const shell={state,can:()=>true,request,notify:()=>{},refresh:async()=>ui.render(state.data),selectView,showSecret:()=>{},dialog:()=>{},actions:()=>{}};
          const ui=createCustomerPage(shell);ui.bind();window.rerender=()=>ui.render(state.data);
          document.querySelector('#login-view').hidden=true;document.querySelector('#dashboard-view').hidden=false;
          document.querySelectorAll('[data-view],[data-go-view]').forEach(n=>n.addEventListener('click',()=>selectView(n.dataset.view||n.dataset.goView)));
          selectView('builds');rerender();window.ready=true;
        </script></body>`);
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      const file = path.join('apps/web/public', url.pathname);
      try { return route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png' }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('https://fixture.local/build'); await page.waitForFunction(() => window.ready);
    const card = page.locator('.build-version-catalog'), row = page.locator('.version-delivery-card');
    assert.equal(await page.locator('.delivery-version-badge').innerText(), '最新 · 当前版本');
    assert.equal(await page.locator('.delivery-version-number').isVisible(), false);
    const sizes = await row.evaluate(n => ({ row:n.getBoundingClientRect().width, parent:n.parentElement.getBoundingClientRect().width }));
    assert.ok(sizes.row < sizes.parent * .6, 'Desktop versions use two equal columns');
    assert.equal(await page.locator('.page-view:visible').count(), 1, 'Only selected page is visible');
    assert.equal(await page.locator('.workspace-content > .page-view').count(), await page.locator('.page-view').count(), 'All pages are siblings, not misnested by the delivery disclosure');
    await page.locator('[data-view=overview]').click();
    assert.equal(await page.locator('#version-catalog').isVisible(), false);
    assert.equal(await page.locator('#recent-build-list').isVisible(), true);
    await page.locator('[data-view=builds]').click();
    assert.equal(await page.locator('#recent-build-list').isVisible(), false);
    await page.evaluate(()=>{state.data.versions.push({...state.data.versions[0],version:'1.19.6',display_name:'APPGOG 1.19.6',is_latest:false,is_latest_eligible:false});state.data.versions[0].is_current=false;rerender();});
    const boxes=await row.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};}));
    assert.ok(Math.abs(boxes[0].y-boxes[1].y)<2 && Math.abs(boxes[0].w-boxes[1].w)<2, 'Latest/current aligned side by side');
    await fs.mkdir('.codex-tmp', { recursive:true });
    await card.screenshot({path:'.codex-tmp/build-two-cards45.png'});
    await page.getByRole('button',{name:'打包此版本',exact:true}).click();
    assert.equal(await page.evaluate(()=>writes[0].body.intent),'update');
    await page.evaluate(()=>{writes=[];state.data.versions=[state.data.versions[1]];state.data.versions[0].version='1.19.11';rerender();});
    await fs.mkdir('.codex-tmp', { recursive:true });
    await card.screenshot({path:'.codex-tmp/version-card45.png'});
    await page.getByRole('button', {name:'重新打包', exact:true}).click();
    assert.equal(await page.evaluate(()=>writes[0].body.intent),'reinstall');
    assert.equal(await page.evaluate(()=>writes[0].body.version),'1.19.11');
    await page.locator('[data-view=history]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#build-history-list tr').length===20);
    assert.match(await page.locator('#build-history-list').innerText(), /已返还 1 次/);
    await page.locator('#history-more').click();
    await page.waitForFunction(()=>document.querySelectorAll('#build-history-list tr').length===25);
    assert.equal(await page.locator('#history-more').isVisible(),false);
    await page.locator('[data-page=history]').screenshot({path:'.codex-tmp/build-history45.png'});
    await page.locator('[data-view=builds]').click();
    await page.evaluate(()=>{state.data.versions[0].display_name='APPGOG very long product name '.repeat(12);state.data.versions[0].release_notes='很长的更新说明'.repeat(100);rerender();});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await card.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    await card.screenshot({path:'.codex-tmp/version-card45-mobile.png'});
    await page.evaluate(()=>{state.data.versions[0].eligible=false;rerender();});
    assert.equal(await page.getByRole('button',{name:'暂不可打包'}).isDisabled(),true);
    assert.deepEqual(errors,[]);
    console.log('Version catalog and history: two aligned cards, isolated page navigation, compact badges, intent, pagination, refund display, mobile overflow and permission disabled passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
