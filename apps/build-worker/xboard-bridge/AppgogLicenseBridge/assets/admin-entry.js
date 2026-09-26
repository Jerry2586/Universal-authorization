(() => {
  'use strict';
  const path=window.settings?.secure_path;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(path||''))return;
  localStorage.setItem('appgog_xboard_admin_path',path);
  const token=()=>{try{return JSON.parse(localStorage.getItem('XBOARD_ACCESS_TOKEN')||'null')?.value||'';}catch{return '';}};
  let themes=[],loading=false,prepareAfterUpload=false;
  const valid=name=>/^[A-Za-z0-9_-]{1,100}$/.test(name||'');
  async function refreshThemes(){
    if(!token()||loading)return;loading=true;
    try{
      const r=await fetch('/api/v2/'+path+'/theme/getThemes',{headers:{authorization:token(),accept:'application/json'}});
      if(!r.ok)return;const result=await r.json();
      themes=Object.values(result.data?.themes||{}).filter(t=>t.appgog_activation?.schema===1&&valid(t.name));
      if(!themes.length){const f=await fetch('/api/v1/appgog-license-bridge/admin-context',{headers:{authorization:token()}});if(f.ok)themes=((await f.json()).themes||[]).filter(t=>valid(t.name));}
      mount();if(prepareAfterUpload&&themes.length){prepareAfterUpload=false;openActivation(themes[themes.length-1],true);}
    }finally{loading=false;}
  }
  function openActivation(theme,prepare=false){
    document.getElementById('__appgog_admin_activation')?.remove();
    const d=document.createElement('dialog');d.id='__appgog_admin_activation';d.dataset.theme=theme.name;
    d.style.cssText='width:min(720px,96vw);height:90vh;max-width:96vw;max-height:94vh;padding:0;border:1px solid #e5e7ef;border-radius:20px;background:#f6f7fb';
    const bar=document.createElement('div');bar.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:white';
    const title=document.createElement('strong');title.textContent=theme.name+(prepare?' · 准备授权组件':' · 本地激活');
    const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>d.close();bar.append(title,close);
    const frame=document.createElement('iframe');frame.title='APPGOG 本地激活';
    frame.src='/theme/'+encodeURIComponent(theme.name)+'/editor.html?appgog_admin_path='+encodeURIComponent(path)+(prepare?'&appgog_setup=prepare':'&appgog_install=1');
    frame.style.cssText='width:100%;height:calc(100% - 52px);border:0';d.append(bar,frame);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
  }
  function mount(){
    if(!token()||!/theme/i.test(location.hash))return;
    for(const theme of themes){
      const heading=[...document.querySelectorAll('h3')].find(n=>n.textContent.trim()===theme.name);
      const card=heading?.parentElement?.parentElement;if(!card)continue;
      card.dataset.appgogProtectedTheme=theme.name;
      if(card.querySelector('[data-appgog-theme-action]'))continue;
      const native=card.querySelector('button');if(!native)continue;
      const button=document.createElement('button');button.type='button';button.dataset.appgogThemeAction=theme.name;button.textContent='激活 / 授权管理';button.className=native.className;
      button.onclick=()=>openActivation(theme);native.parentElement.append(button);
    }
  }
  // Stop the native activation BEFORE it writes frontend_theme. HostGuard also
  // rejects direct API calls until both stages have been verified server-side.
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('button');if(!button||button.dataset.appgogThemeAction)return;
    const card=button.closest('[data-appgog-protected-theme]');if(!card)return;
    if(!/^(激活|启用|使用|Activate|Enable)$/i.test(button.textContent.trim()))return;
    const theme=themes.find(t=>t.name===card.dataset.appgogProtectedTheme);if(!theme)return;
    event.preventDefault();event.stopImmediatePropagation();openActivation(theme);
  },true);
  window.addEventListener('message',event=>{
    const d=document.getElementById('__appgog_admin_activation'),frame=d?.querySelector('iframe');
    if(event.origin!==location.origin||event.source!==frame?.contentWindow||event.data?.type!=='appgog-local-activated'||event.data.theme!==d.dataset.theme)return;
    location.assign('/theme/'+encodeURIComponent(d.dataset.theme)+'/editor.html?appgog_admin_path='+encodeURIComponent(path));
  });
  new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
  const uploadDone=()=>{prepareAfterUpload=true;void refreshThemes().catch(()=>{});};
  const originalFetch=window.fetch;
  window.fetch=async function(input,options){const r=await originalFetch.apply(this,arguments);try{const u=new URL(typeof input==='string'?input:input.url,location.origin);if(u.origin===location.origin&&u.pathname==='/api/v2/'+path+'/theme/upload'&&r.ok)uploadDone();}catch{}return r;};
  const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send,requests=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url){requests.set(this,{method,url});return open.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(){try{const u=new URL(requests.get(this)?.url,location.origin);if(u.origin===location.origin&&u.pathname==='/api/v2/'+path+'/theme/upload')this.addEventListener('load',()=>{if(this.status>=200&&this.status<300)uploadDone();},{once:true});}catch{}return send.apply(this,arguments);};
  window.addEventListener('hashchange',()=>{mount();void refreshThemes().catch(()=>{});});void refreshThemes().catch(()=>{});
})();
