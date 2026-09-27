// Actual plan-management page/module with isolated data and a recording API.
const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.APPGOG_BROWSER_CHANNEL?{channel:process.env.APPGOG_BROWSER_CHANNEL}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/admin'){
    let html=await fs.readFile('apps/web/public/admin.html','utf8');
    html=html.replace('<script src="/assets/admin-portal.js" type="module"></script>','').replace('</body>',`<script type="module">
     import{createPlanUi}from'/assets/portal/plans.js';import{createDialog}from'/assets/portal/dialog.js';
     window.plans=[{code:'studio',name:'工作室套餐',access_tier:'paid',status:'active',capabilities:['settings:read'],limits:{max_builds_per_day:5,max_activations:1}}];window.writes=[];window.manage=true;window.fail=false;
     const ui=createPlanUi({can:()=>manage,dialog:createDialog,notify:()=>{},request:async(url,options)=>{writes.push({url,...options});if(fail)throw Error('删除失败');plans=[];return{deleted:true};},refresh:async()=>ui.render(plans)});ui.bind();window.render=()=>ui.render(plans);
     document.querySelector('#login-view').hidden=true;document.querySelector('#dashboard-view').hidden=false;document.querySelectorAll('.page-view').forEach(n=>n.classList.toggle('active',n.dataset.page==='plans'));render();window.ready=true;
    </script></body>`);
    return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
   }
   const file=path.join('apps/web/public',url.pathname);try{return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/png'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('https://fixture.local/admin');await page.waitForFunction(()=>window.ready);
  await page.getByRole('button',{name:'删除',exact:true}).click();
  assert.match(await page.getByRole('dialog').innerText(),/已经签发的授权、额度和权益保持不变/);
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>writes.length),0);
  await page.getByRole('button',{name:'删除',exact:true}).click();await page.evaluate(()=>fail=true);
  await page.getByRole('button',{name:'删除套餐',exact:true}).click();
  assert.equal(await page.getByRole('dialog').isVisible(),true);assert.equal(await page.getByRole('button',{name:'删除套餐',exact:true}).isEnabled(),true);
  await page.evaluate(()=>fail=false);await page.getByRole('button',{name:'删除套餐',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.match(await page.locator('#plan-list').innerText(),/暂无符合/);
  assert.deepEqual(await page.evaluate(()=>writes.at(-1)),{url:'/web/admin/plans/studio',method:'DELETE'});
  await page.evaluate(()=>{manage=false;plans=[{code:'read-only',name:'只读套餐',access_tier:'free',status:'active',capabilities:[],limits:{max_builds_per_day:1,max_activations:1}}];render();});
  assert.equal(await page.getByRole('button',{name:'删除',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log('Plan deletion UI: confirmation, cancellation, error recovery, exact DELETE request, removal and read-only permission passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
