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
    d.style.cssText='width:min(620px,calc(100vw - 32px));height:min(780px,calc(100dvh - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);padding:0;overflow:hidden;box-sizing:border-box;border:1px solid #e5e7ef;border-radius:18px;background:#f6f7fb;font:14px/1.5 system-ui,-apple-system,sans-serif';
    const bar=document.createElement('div');bar.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;height:54px;box-sizing:border-box;padding:12px 20px;background:white;border-bottom:1px solid #e5e7ef';
    const title=document.createElement('strong');title.textContent=theme.name+(prepare?' · 准备授权组件':' · 本地激活');
    const close=document.createElement('button');close.type='button';close.textContent='关闭';close.style.cssText='position:static;flex:none;border:0;background:transparent;color:#667085;padding:6px;font:inherit;cursor:pointer';close.onclick=()=>d.close();bar.append(title,close);
    const frame=document.createElement('iframe');frame.title='APPGOG 本地激活';
    frame.src='/theme/'+encodeURIComponent(theme.name)+'/editor.html?appgog_admin_path='+encodeURIComponent(path)+(prepare?'&appgog_setup=prepare':'&appgog_install=1');
    frame.style.cssText='display:block;width:100%;height:calc(100% - 54px);min-height:0;border:0';d.append(bar,frame);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
  }
  const label=button=>(button.textContent||'').replace(/\s+/g,'').trim();
  const activates=button=>/^(激活|激活主题|启用|启用主题|使用|使用主题|应用主题|Activate|ActivateTheme|Enable|EnableTheme)$/i.test(label(button));
  const current=button=>/^(当前主题|CurrentTheme)$/i.test(label(button));
  const settings=button=>/^(主题设置|设置主题|ThemeSettings)$/i.test(label(button));
  function themeCard(heading){
    let node=heading?.parentElement;
    for(let depth=0;node&&depth<6;depth++,node=node.parentElement){
      if(node===document.body||node.querySelectorAll('h3').length>1)return null;
      const buttons=[...node.querySelectorAll('button')];
      if(buttons.some(button=>!button.dataset.appgogThemeAction&&(activates(button)||settings(button)||current(button))))return node;
    }
    return null;
  }
  function mount(){
    if(!token()||!/theme/i.test(location.hash))return;
    for(const theme of themes){
      const heading=[...document.querySelectorAll('h3')].find(n=>n.textContent.trim()===theme.name);
      const card=themeCard(heading);if(!card)continue;
      card.dataset.appgogProtectedTheme=theme.name;
      const buttons=[...card.querySelectorAll('button')].filter(button=>!button.dataset.appgogThemeAction);
      const actions=buttons.filter(button=>button.dataset.appgogNativeAction||activates(button)||settings(button)||current(button));
      const reference=actions.find(settings)||actions.find(activates)||actions.find(current);if(!reference)continue;
      // Hide host-owned controls without removing/reparenting React's nodes or text.
      for(const native of actions){native.dataset.appgogNativeAction='true';native.hidden=true;native.style.setProperty('display','none','important');}
      const existing=[...card.querySelectorAll('[data-appgog-theme-action]')];
      const button=existing.shift()||document.createElement('button');
      for(const duplicate of existing)duplicate.remove();button.type='button';button.dataset.appgogThemeAction=theme.name;
      if(button.textContent!=='激活 / 授权管理')button.textContent='激活 / 授权管理';button.setAttribute('translate','no');
      button.style.cssText='position:static;inset:auto;display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;width:auto;max-width:100%;min-height:40px;padding:10px 18px;border:1px solid #0f172a;border-radius:10px;background:#0f172a;color:#fff;font:inherit;line-height:1.4;white-space:normal;overflow-wrap:anywhere;cursor:pointer';
      if(button.parentElement!==reference.parentElement)reference.parentElement.append(button);
    }
  }
  // Capture before React/native actions write frontend_theme, including “激活主题”.
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('button');if(!button)return;
    const card=button.closest('[data-appgog-protected-theme]');if(!card)return;
    if(!button.dataset.appgogThemeAction&&!button.dataset.appgogNativeAction&&!activates(button))return;
    const theme=themes.find(t=>t.name===card.dataset.appgogProtectedTheme);if(!theme)return;
    event.preventDefault();event.stopImmediatePropagation();openActivation(theme);
  },true);
  window.addEventListener('message',event=>{
    const d=document.getElementById('__appgog_admin_activation'),frame=d?.querySelector('iframe');
    if(event.origin!==location.origin||event.source!==frame?.contentWindow||event.data?.type!=='appgog-local-activated'||event.data.theme!==d.dataset.theme)return;
    location.assign('/theme/'+encodeURIComponent(d.dataset.theme)+'/editor.html?appgog_admin_path='+encodeURIComponent(path));
  });
  const actionStyle=document.createElement('style');
  actionStyle.dataset.appgogAdminActions='true';
  actionStyle.textContent='[data-appgog-protected-theme] button[data-appgog-native-action]{display:none!important}';
  document.head.append(actionStyle);
  new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
  const uploadDone=()=>{prepareAfterUpload=true;void refreshThemes().catch(()=>{});};
  const originalFetch=window.fetch;
  window.fetch=async function(input,options){const r=await originalFetch.apply(this,arguments);try{const u=new URL(typeof input==='string'?input:input.url,location.origin);if(u.origin===location.origin&&u.pathname==='/api/v2/'+path+'/theme/upload'&&r.ok)uploadDone();}catch{}return r;};
  const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send,requests=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url){requests.set(this,{method,url});return open.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(){try{const u=new URL(requests.get(this)?.url,location.origin);if(u.origin===location.origin&&u.pathname==='/api/v2/'+path+'/theme/upload')this.addEventListener('load',()=>{if(this.status>=200&&this.status<300)uploadDone();},{once:true});}catch{}return send.apply(this,arguments);};
  window.addEventListener('hashchange',()=>{mount();void refreshThemes().catch(()=>{});});void refreshThemes().catch(()=>{});
})();
