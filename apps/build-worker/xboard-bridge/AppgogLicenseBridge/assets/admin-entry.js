(() => {
  'use strict';
  const path = window.settings?.secure_path;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(path || '')) return;
  localStorage.setItem('appgog_xboard_admin_path', path);
  const token = () => { try { return JSON.parse(localStorage.getItem('XBOARD_ACCESS_TOKEN') || 'null')?.value || ''; } catch { return ''; } };
  let themes = [];
  let loading = false;
  async function refreshThemes() {
    if (!token() || loading) return;
    loading = true;
    try {
      const response = await fetch('/api/v2/' + path + '/theme/getThemes', {headers:{authorization:token(),accept:'application/json'},credentials:'same-origin'});
      if (!response.ok) return;
      const result = await response.json();
      themes = Object.values(result.data?.themes || {}).filter(t => t.appgog_activation?.schema === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(t.name));
      if (!themes.length) {
        const fallback = await fetch('/api/v1/appgog-license-bridge/admin-context', {headers:{authorization:token()},credentials:'same-origin'});
        if (fallback.ok) themes = ((await fallback.json()).themes || []).filter(t => /^[A-Za-z0-9_-]{1,100}$/.test(t.name));
      }
      mount();
    } finally { loading = false; }
  }
  function openActivation(theme) {
    document.getElementById('__appgog_admin_activation')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = '__appgog_admin_activation';
    dialog.style.cssText = 'width:min(1100px,96vw);height:90vh;max-width:96vw;max-height:94vh;padding:0;border:1px solid #e5e7ef;border-radius:20px;background:#f6f7fb';
    const bar=document.createElement('div');bar.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:white';
    const title=document.createElement('strong');title.textContent=theme.name+' · 授权与激活';
    const close=document.createElement('button');close.textContent='关闭';close.type='button';close.onclick=()=>dialog.close();bar.append(title,close);
    const frame=document.createElement('iframe');frame.title='APPGOG 授权与激活';
    frame.src='/theme/'+encodeURIComponent(theme.name)+'/editor.html?appgog_admin_path='+encodeURIComponent(path);
    frame.style.cssText='width:100%;height:calc(100% - 52px);border:0';
    dialog.append(bar,frame);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  }
  function mount() {
    if (!token() || !/theme/i.test(location.hash)) {
      document.querySelectorAll('[data-appgog-theme-action]').forEach(el=>el.remove()); return;
    }
    for (const theme of themes) {
      if ([...document.querySelectorAll('[data-appgog-theme-action]')].some(el=>el.dataset.appgogThemeAction===theme.name)) continue;
      const heading=[...document.querySelectorAll('h3')].find(el=>el.textContent.trim()===theme.name);
      const card=heading?.parentElement?.parentElement;
      const native=card?.querySelector('button');
      if (!native) continue;
      const button=document.createElement('button');button.type='button';button.dataset.appgogThemeAction=theme.name;
      button.textContent='授权与激活';button.className=native.className;
      button.style.cssText='color:#7250ce;background:#f5f1ff;border-color:#ded4ff';
      button.onclick=()=>openActivation(theme);native.parentElement.append(button);
    }
  }
  new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});
  // The native activate action switches frontend_theme. Observe successful same-origin saves;
  // never intercept settings writes or send the administrator token to a theme/third-party URL.
  const originalFetch = window.fetch;
  window.fetch = async function(input, options) {
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.origin === location.origin && url.pathname === '/api/v2/' + path + '/config/save' && response.ok) {
        const body = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
        const theme = themes.find(t => t.name === body?.frontend_theme);
        if (theme) { const result = await response.clone().json(); if (result.status === 'success' || result.data === true) openActivation(theme); }
      }
    } catch { /* Native requests must retain their result even if the extension cannot parse them. */ }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url) {
    requests.set(this, {method, url}); return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const record = requests.get(this);
    try {
      const url = new URL(record?.url, location.origin);
      if (url.origin === location.origin && url.pathname === '/api/v2/' + path + '/config/save') {
        const theme = themes.find(t => t.name === (typeof body === 'string' ? JSON.parse(body).frontend_theme : null));
        if (theme) this.addEventListener('load', () => {
          try {
            const result = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            if (this.status >= 200 && this.status < 300 && (result.status === 'success' || result.data === true)) openActivation(theme);
          } catch { /* Do not affect native requests. */ }
        }, {once:true});
      }
    } catch { /* Do not affect native requests. */ }
    return originalSend.apply(this, arguments);
  };
  window.addEventListener('hashchange',()=>{mount();void refreshThemes().catch(()=>{});});
  void refreshThemes().catch(()=>{});
})();
