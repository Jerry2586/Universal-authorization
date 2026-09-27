const {chromium}=require(process.env.APPGOG_PLAYWRIGHT_PATH||'playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.APPGOG_BROWSER_CHANNEL?{channel:process.env.APPGOG_BROWSER_CHANNEL}:{})});try{
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.pathname==='/admin'){
let html=await fs.readFile('apps/web/public/admin.html','utf8');html=html.replace('<script src="/assets/admin-portal.js" type="module"></script>','').replace('</body>',`<script type="module">
import{createOperationsUi}from'/assets/portal/operations.js';
document.querySelector('#login-view').hidden=true;document.querySelector('#dashboard-view').hidden=false;document.querySelectorAll('.page-view').forEach(n=>n.classList.toggle('active',n.dataset.page==='cms'));
window.state={available:true,state:'idle',current_version:'1.2.45',latest_version:'1.2.46',check_status:'succeeded',freshness:'fresh',relation:'update_available',installable:true,version_lock:{locked:false,version:null,valid:true}};window.calls=[];window.fail=false;
window.ui=createOperationsUi({can:()=>true,notify:message=>window.notice=message,request:async(url,opts)=>{if(url.includes('/bridge'))return{current_version:'1.1.4',message:'组件已就绪',repairable:true};if(fail)throw Error('连接中断');if(opts){calls.push({url,...opts});if(url.endsWith('/lock')){state.version_lock={locked:opts.body.locked,version:'1.2.45',valid:true};state.installable=!opts.body.locked;}}return structuredClone(state);}});ui.bind();await ui.refresh();window.ready=true;
</script></body>`);return route.fulfill({contentType:'text/html; charset=utf-8',body:html});}
const file=path.join('apps/web/public',u.pathname);try{return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/png'});}catch{return route.fulfill({status:404,body:''});}});
await page.goto('http://fixture.local/admin');await page.waitForFunction(()=>window.ready);
await page.locator('#toggle-version-lock').click();await page.waitForFunction(()=>document.querySelector('#toggle-version-lock').textContent==='解除版本锁定');
assert.equal(await page.locator('#install-update').isDisabled(),true);assert.equal(await page.locator('#repair-current').isEnabled(),true);assert.equal(await page.locator('#check-update').isEnabled(),true);
await page.locator('#repair-current').click();await page.waitForFunction(()=>calls.some(x=>x.body.action==='repair-current'));
const card=page.locator('.online-update-card').filter({has:page.locator('#toggle-version-lock')});await card.screenshot({path:'.codex-tmp/version-lock45.png'});
await page.locator('#toggle-version-lock').click();await page.waitForFunction(()=>!document.querySelector('#install-update').disabled);
await page.evaluate(()=>{state.state='running';return ui.refresh();});assert.equal(await page.locator('#toggle-version-lock').isDisabled(),true);
await page.evaluate(()=>{state.state='idle';fail=true;return ui.refresh();});assert.equal(await page.locator('#install-update').isDisabled(),true);assert.equal(await page.locator('#toggle-version-lock').isDisabled(),true);
await page.evaluate(()=>{fail=false;return ui.refresh();});await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();assert.ok(await card.evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert.deepEqual(errors,[]);console.log('Platform version lock UI passed: lock/unlock, repair/check enabled, upgrade blocked, busy/error states, mobile layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
