const { chromium } = require(process.env.APPGOG_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.APPGOG_BROWSER_CHANNEL ? { channel: process.env.APPGOG_BROWSER_CHANNEL } : {}) });
  try {
    const script = await fs.readFile(process.env.APPGOG_ADMIN_ENTRY_SCRIPT || 'apps/build-worker/xboard-bridge/AppgogLicenseBridge/assets/admin-entry.js', 'utf8');
    for (const transport of ['fetch', 'xhr']) for (const version of ['v1', 'v2']) for (const enriched of [true, false]) {
      const context = await browser.newContext(); const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      let releaseOld; const oldPending = new Promise(resolve => { releaseOld = resolve; });
      let lists = 0, uploaded = false, rejectUpload = true, editorRequests = 0, enableRequests = 0;
      const marker = name => ({ name, appgog_activation: { schema: 1 } });
      await page.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/theme/getThemes')) {
          const snapshot = uploaded;
          if (++lists === 1) await oldPending;
          return route.fulfill({ json: { data: { themes: { Existing: marker('Existing'), ...(snapshot ? { APPGOG: enriched ? marker('APPGOG') : { name: 'APPGOG' } } : {}) } } } });
        }
        if (path.endsWith('/admin-context')) return route.fulfill({ json: { themes: [marker('Existing'), ...(uploaded ? [marker('APPGOG')] : [])] } });
        if (path.endsWith('/theme/upload')) {
          if (rejectUpload) return route.fulfill({ json: { status: 'fail', message: 'rejected', appgog_activation: { schema: 1, themes: [marker('APPGOG')] } } });
          uploaded = true;
          return route.fulfill({ json: { status: 'success', data: true, ...(enriched ? { appgog_activation: { schema: 1, themes: [marker('APPGOG')] } } : {}) } });
        }
        if (path.endsWith('/config/save')) { enableRequests++; return route.fulfill({ json: {} }); }
        if (path.endsWith('/editor.html')) { editorRequests++; return route.fulfill({ body: '<html><body>local activation fixture</body></html>', contentType: 'text/html; charset=utf-8' }); }
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><main id=cards></main><script>
          window.settings={secure_path:'secure'};
          localStorage.setItem('XBOARD_ACCESS_TOKEN',JSON.stringify({value:'fixture'}));
          window.addCard=name=>{const card=document.createElement('article');card.id=name;card.innerHTML='<button class=delete>删除</button><div><h3>'+name+'</h3></div><footer><button class=settings>主题设置</button><button class=activate>激活主题</button></footer>';cards.append(card);};
          addCard('Xboard');addCard('Existing');
          window.upload=async(transport,version)=>{const url='/api/'+version+'/secure/theme/upload';if(transport==='fetch')return(await fetch(url,{method:'POST'})).json();return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST',url);x.responseType='json';x.onload=()=>resolve(x.response);x.onerror=reject;x.send();});};
        </script><script>${script}</script></body>` });
      });
      try {
        await page.goto('https://fixture.local/secure#/config/theme');
        await page.waitForFunction(() => typeof upload === 'function');
        await page.evaluate(async ({ transport, version }) => { await upload(transport, version); addCard('APPGOG'); }, { transport, version });
        assert.equal(await page.locator('#APPGOG [data-appgog-theme-action]').count(), 0, 'failed upload must not publish markers');
        rejectUpload = false;
        await page.evaluate(({ transport, version }) => upload(transport, version), { transport, version });
        if (enriched) await page.locator('#APPGOG [data-appgog-theme-action]').waitFor();
        releaseOld();
        await page.locator('#APPGOG [data-appgog-theme-action]').waitFor();
        await page.waitForFunction(() => document.querySelector('#Existing [data-appgog-theme-action]'));
        assert.equal(await page.locator('#APPGOG button:visible').count(), 2, await page.locator('#APPGOG').innerHTML());
        assert.equal(await page.locator('#APPGOG .settings').isVisible(), false);
        assert.equal(await page.locator('#APPGOG .activate').isVisible(), false);
        assert.equal(await page.locator('#Xboard button:visible').count(), 3);
        assert.equal(editorRequests, 0, 'upload must not open editor');
        assert.equal(enableRequests, 0, 'upload must not enable unlicensed theme');
        assert.equal(await page.locator('dialog').count(), 0);
        await page.locator('#APPGOG [data-appgog-theme-action]').click();
        await page.locator('dialog[open]').waitFor();
        await page.waitForFunction(() => document.querySelector('dialog iframe')?.contentDocument?.body?.textContent.includes('local activation fixture'));
        assert.equal(editorRequests, 1);
        assert.equal(enableRequests, 0);
        assert.deepEqual(errors, []);
        console.log(`Fresh upload ${transport}/${version}, response markers=${enriched}: passed`);
      } finally { releaseOld(); await context.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
