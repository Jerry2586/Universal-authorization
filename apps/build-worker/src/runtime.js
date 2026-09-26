import { createHash } from 'node:crypto';

function publicKeyDer(pem) {
  return pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, '');
}

// This function is serialized into the installed theme. Keep it self-contained: it has no Node dependencies.
export function browserLicenseRuntime(config) {
  const root = document.documentElement;
  root.classList.remove('__appgog_unlocked');
  root.classList.add('__appgog_locked');
  const runtimeSource = document.currentScript?.src || location.href;
  const storageKey = `appgog_license_${config.i}`;
  const legacyInstallKey = `appgog_install_${config.p}`;
  let saved;
  let integrityFailure = null;
  let bridgeFailure = null;
  let activePayload = null;
  let installationId = null;
  let installationPublicKey = null;
  let xboardAdminPath = null;
  let activationAdminRequired = false;
  let setupMessage = '正在检查授权组件…';
  function progress(message) {
    setupMessage = message;
    root.style?.setProperty?.('--appgog-loading-message', JSON.stringify(message));
    const element = document.getElementById('__appgog_setup_progress');
    if (element) element.textContent = message;
  }
  function connectionPath() {
    try { return JSON.parse(localStorage.getItem('appgog_studio_connection_v1') || 'null')?.admin_path; } catch { return null; }
  }
  function rememberAdminPath(value) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value || '')) return;
    xboardAdminPath = value;
    localStorage.setItem('appgog_xboard_admin_path', value);
    localStorage.setItem('appgog_studio_connection_v1', JSON.stringify({admin_path:value, api_version:'v2'}));
    store({ ...(saved || {}), xboard_admin_path: value });
  }
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }

  const now = () => Math.floor(Date.now() / 1000);
  const bytes = (base64) => {
    let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  };
  const parsed = (base64) => JSON.parse(new TextDecoder().decode(bytes(base64)));
  const domain = () => {
    const host = location.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
    return host.startsWith('www.') && host.slice(4).includes('.') ? host.slice(4) : host;
  };
  const origin = (value) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return url.origin.toLowerCase();
    } catch { return ''; }
  };
  const packageProof = () => config.o.map((index) => atob(config.s[index])).join('');
  const hex = (value) => [...new Uint8Array(value)].map((item) => item.toString(16).padStart(2, '0')).join('');
  const joined = (...arrays) => {
    const length = arrays.reduce((sum, item) => sum + item.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const item of arrays) { output.set(item, offset); offset += item.length; }
    return output;
  };
  const store = (value) => { saved = value; localStorage.setItem(storageKey, JSON.stringify(value)); };
  const adminToken = () => {
    try {
      const record = JSON.parse(localStorage.getItem('XBOARD_ACCESS_TOKEN') || 'null');
      return typeof record?.value === 'string' && record.value.length > 12 ? record.value : '';
    } catch { return ''; }
  };
  const bridgeUrl = (path) => new URL(`/api/v1/appgog-license-bridge${path}`, location.origin).toString();
  const versionParts = (value) => String(value || '').split('.').map((part) => Number(part));
  const versionLessThan = (left, right) => {
    const a = versionParts(left), b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0);
    }
    return false;
  };

  function adminPathCandidates() {
    const values = [saved?.xboard_admin_path, globalThis.settings?.secure_path,
      localStorage.getItem('appgog_xboard_admin_path'), connectionPath()];
    try {
      values.unshift(new URL(location.href).searchParams.get('appgog_admin_path'));
      if (globalThis.parent !== globalThis && globalThis.parent?.location?.origin === location.origin) values.unshift(globalThis.parent.settings?.secure_path);
    } catch { /* Cross-origin parents are never read. */ }
    try {
      const referrer = new URL(document.referrer);
      if (referrer.origin === location.origin) values.push(referrer.pathname.split('/').filter(Boolean)[0]);
    } catch { /* No same-origin referrer. */ }
    values.push('admin');
    return [...new Set(values.filter((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value || '')))];
  }

  async function responseJson(response, fallback) {
    let value = null;
    try {
      value = await response.json();
    } catch { /* Error classification below must still use the HTTP status. */ }
    if (!response.ok) {
      const error = new Error(value?.message || value?.error?.message || fallback);
      if (response.status >= 500) error.unavailable = true;
      else error.denied = true;
      throw error;
    }
    if (value === null) throw new Error(fallback);
    return value;
  }

  async function bridgeRequest(path, body = null, requireAdmin = false) {
    const headers = { accept: 'application/json' };
    if (body !== null) headers['content-type'] = 'application/json';
    if (requireAdmin) {
      const token = adminToken();
      if (!token) throw new Error('请先登录 Xboard 管理后台，再打开当前主题完成授权组件安装');
      headers.authorization = token;
    }
    let response;
    try {
      response = await fetch(bridgeUrl(path), {
        method: body === null ? 'GET' : 'POST', headers,
        body: body === null ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store',
      });
    } catch {
      throw Object.assign(new Error('APPGOG 授权桥暂时无法连接'), { unavailable: true });
    }
    return responseJson(response, 'APPGOG 授权桥请求失败');
  }

  async function xboardAdminRequest(path, options = {}) {
    const token = adminToken();
    if (!token) throw new Error('请先登录 Xboard 管理后台，再打开当前主题完成授权组件安装');
    const headers = { accept: 'application/json', authorization: token, ...(options.headers || {}) };
    const response = await fetch(`/api/v2/${xboardAdminPath}${path}`, { ...options, headers, credentials: 'same-origin' });
    return responseJson(response, 'Xboard 插件接口调用失败');
  }
  const activationPublicKey = crypto.subtle.importKey('spki', bytes(config.a || config.k), { name: 'Ed25519' }, false, ['verify']);
  const packagePublicKey = crypto.subtle.importKey('spki', bytes(config.q || config.k), { name: 'Ed25519' }, false, ['verify']);
  const notificationPublicKey = crypto.subtle.importKey('spki', bytes(config.n || config.k), { name: 'Ed25519' }, false, ['verify']);
  const legacyCapabilities = [
    'settings:read', 'settings:write', 'theme:enable',
    'xboard:connect', 'protected:read', 'updates:read',
  ];

  function hasCapability(capability) {
    if (!activePayload || typeof capability !== 'string' || !capability) return false;
    const capabilities = activePayload.capabilities === undefined ? legacyCapabilities : activePayload.capabilities;
    return Array.isArray(capabilities) && capabilities.includes(capability);
  }

  function requireCapability(capability) {
    if (hasCapability(capability)) return true;
    const error = new Error('当前授权不允许执行此操作');
    error.code = 'APPGOG_CAPABILITY_DENIED';
    throw error;
  }

  async function signedPayload(token, keyPromise) {
    try {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const header = parsed(parts[0]);
      if (header.alg !== 'EdDSA' || header.typ !== 'APPGOG-ACT' || header.v !== 1) return null;
      const key = await keyPromise;
      if (!await crypto.subtle.verify('Ed25519', key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
      return parsed(parts[1]);
    } catch { return null; }
  }

  async function activationPayload(token, backendOrigin) {
    const payload = await signedPayload(token, activationPublicKey);
    if (!payload || payload.typ !== 'activation' || payload.product !== config.p
      || payload.build_id !== config.b || payload.package_id !== config.i
      || payload.domain !== domain() || payload.installation_id !== installationId
      || !backendOrigin || payload.backend_origin !== origin(backendOrigin)
      || !Number.isSafeInteger(payload.exp) || payload.exp <= 0
      || !Number.isSafeInteger(payload.offline_until) || payload.offline_until < payload.exp) return null;
    return payload;
  }

  async function protectedIdentityValid() {
    if (!config.x) return true;
    try {
      const response = await fetch(new URL(config.x, runtimeSource), { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return false;
      const raw = new Uint8Array(await response.arrayBuffer());
      if (hex(await crypto.subtle.digest('SHA-256', raw)) !== config.h) return false;
      const envelope = JSON.parse(new TextDecoder().decode(raw));
      if (envelope.v !== 1 || envelope.a !== 'AES-256-GCM') return false;
      const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(packageProof()));
      const key = await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: bytes(envelope.i),
        additionalData: new TextEncoder().encode('APPGOG-PROTECTED-IDENTITY-v1'),
      }, key, joined(bytes(envelope.c), bytes(envelope.t)));
      const identity = JSON.parse(new TextDecoder().decode(plaintext));
      return identity.product === config.p && identity.version === config.v && identity.build_id === config.b
        && identity.package_id === config.i && identity.domain === domain() && identity.watermark === config.w;
    } catch { return false; }
  }

  async function packageIdentityValid() {
    const payload = await signedPayload(config.m, packagePublicKey);
    if (!payload || payload.typ !== 'package-manifest' || payload.product !== config.p
      || payload.build_id !== config.b || payload.package_id !== config.i || payload.version !== config.v) {
      return { ok: false, reason: 'signed-package' };
    }
    const currentDomain = domain();
    if (payload.domain !== currentDomain) {
      return { ok: false, reason: 'domain', expected: payload.domain, actual: currentDomain };
    }
    if (!await protectedIdentityValid()) return { ok: false, reason: 'protected-identity' };
    return { ok: true };
  }

  async function bridgeHealth() {
    try {
      const token = adminToken();
      const response = await fetch(bridgeUrl('/health'), {
        headers: token ? { authorization: token } : {}, credentials: 'same-origin', cache: 'no-store',
      });
      if (response.status === 429) throw new Error('授权桥请求过于频繁，请稍后刷新重试');
      if (response.status >= 500) throw new Error('授权桥服务暂时不可用，请稍后刷新重试');
      if (!response.ok) return null;
      const health = await response.json();
      return health?.ok && health?.code === config.gc ? health : null;
    } catch (error) {
      throw new Error(error?.message || '授权桥暂时无法连接，请稍后刷新重试');
    }
  }

  async function findAdminPath() {
    if (adminToken()) {
      try {
        const context = await bridgeRequest('/admin-context', null, true);
        if (/^[A-Za-z0-9_-]{1,128}$/.test(context.admin_path || '')) rememberAdminPath(context.admin_path);
      } catch { /* Older bridge versions still use verified candidate discovery. */ }
    }
    for (const candidate of adminPathCandidates()) {
      xboardAdminPath = candidate;
      try {
        const result = await xboardAdminRequest('/plugin/getPlugins');
        if (Array.isArray(result?.data)) { rememberAdminPath(candidate); return result.data; }
      } catch { /* Try the next safe candidate. */ }
    }
    xboardAdminPath = null;
    throw new Error('无法识别 Xboard 管理路径；请从已登录的管理后台进入当前主题');
  }

  async function uploadBridgePackage() {
    const response = await fetch(new URL(config.j, runtimeSource), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('客户包内缺少 APPGOG 授权桥插件');
    const raw = new Uint8Array(await response.arrayBuffer());
    if (hex(await crypto.subtle.digest('SHA-256', raw)) !== config.y) throw new Error('APPGOG 授权桥插件摘要校验失败');
    const form = new FormData();
    form.append('file', new Blob([raw], { type: 'application/zip' }), `appgog-license-bridge-${config.gv}.zip`);
    await xboardAdminRequest('/plugin/upload', { method: 'POST', body: form });
  }

  async function ensureBridge() {
    if (!config.gc) {
      installationId = localStorage.getItem(legacyInstallKey);
      if (!installationId) {
        installationId = crypto.randomUUID ? crypto.randomUUID() : `ins_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(legacyInstallKey, installationId);
      }
      return;
    }
    progress('正在检查授权组件…');
    let health = await bridgeHealth();
    let plugins = null;
    if (!health || versionLessThan(health.version, config.gv)) {
      progress('正在连接 Xboard 插件中心…');
      plugins = await findAdminPath();
      let plugin = plugins.find((item) => item.code === config.gc);
      if (!plugin || versionLessThan(plugin.version, config.gv)) {
        progress('正在校验并上传授权插件…');
        await uploadBridgePackage();
        plugins = await xboardAdminRequest('/plugin/getPlugins');
        if (!Array.isArray(plugins?.data)) throw new Error('Xboard 插件列表响应无效，请刷新管理后台后重试');
        plugin = plugins.data.find((item) => item.code === config.gc);
      }
      if (!plugin) throw new Error('Xboard 未识别 APPGOG 授权桥插件包');
      if (!plugin.is_installed) {
        progress('正在安装授权插件…');
        await xboardAdminRequest('/plugin/install', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: config.gc }),
        });
      }
      if (!plugin.is_enabled) {
        progress('正在启用授权插件…');
        await xboardAdminRequest('/plugin/enable', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: config.gc }),
        });
      }
      // Explicit authenticated post-commit reload avoids relying only on termination callbacks.
      if (!versionLessThan(config.gv, '1.0.7')) await bridgeRequest('/runtime/reload', {}, true);
      // Only poll reads while the upgraded PHP workers reload; never replay upload/install.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        health = await bridgeHealth();
        if (health && !versionLessThan(health.version, config.gv)) break;
        if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 750));
      }
      if (!health || versionLessThan(health.version, config.gv)) throw new Error('APPGOG 授权桥版本尚未生效，请重载 Xboard 应用服务后重试；安装身份与授权数据会保留');
    }
    progress('正在验证插件与安装身份…');
    if (!xboardAdminPath && adminToken()) {
      try { await findAdminPath(); } catch { /* Existing bridge can still report its identity. */ }
    }
    let identity = health.identity;
    installationId = identity?.installation_id;
    installationPublicKey = identity?.installation_public_key;
    if (!installationId || !installationPublicKey) throw new Error('APPGOG 授权桥没有返回有效的服务器安装身份');
    if (adminToken()) {
      const registered = await bridgeRequest('/register', {
        product: config.p, build_id: config.b, package_id: config.i, package_proof: packageProof(),
        domain: domain(), theme_name: config.gt, license_server: config.u,
      }, true);
      identity = registered?.installation_id ? registered : identity;
      installationId = identity?.installation_id;
      installationPublicKey = identity?.installation_public_key;
    }
    let runtime = null;
    try {
      runtime = await bridgeRequest('/state/runtime', {
        package_id: config.i, package_proof: packageProof(),
      });
    } catch (error) {
      if (adminToken() || error.unavailable) throw error;
      activationAdminRequired = true;
    }
    if (runtime?.state) store({ ...(saved || {}), ...runtime.state });
    // Activated pages use the public signed runtime state; secrets stay in the bridge.
    if (adminToken() && !saved?.activation_id) {
      const remote = await bridgeRequest('/state/read', {
        package_id: config.i, package_proof: packageProof(),
      }, true);
      if (remote?.state) store({ ...(saved || {}), ...remote.state });
    }
    if (saved && (!adminToken() || saved.activation_id)) {
      const { refresh_secret, install_receipt_secret, install_window_token, ...runtimeSafeState } = saved;
      store(runtimeSafeState);
    }
    activationAdminRequired = activationAdminRequired || (!adminToken() && !saved?.activation_id);
    store({ ...(saved || {}), bridge_registered: true, bridge_version: health.version,
      installation_id: installationId, xboard_admin_path: xboardAdminPath || saved?.xboard_admin_path });
    globalThis.APPGOGThemeBridge = Object.freeze({
      version: health.version,
      installationId,
      deactivateAndRemoveTheme: () => bridgeRequest('/deactivate-theme', {
        package_id: config.i, package_proof: packageProof(),
      }, true),
    });
  }

  async function persistBridgeState(state = saved) {
    if (!adminToken()) return;
    await bridgeRequest('/state/write', {
      package_id: config.i, package_proof: packageProof(), state: state || {},
    }, true);
  }

  async function installationProof(purpose, context) {
    const challenge = await post('/api/v1/installation-challenges', {
      purpose, installation_public_key: installationPublicKey, context,
    });
    return bridgeRequest('/sign-challenge', {
      package_id: config.i, package_proof: packageProof(), challenge,
    }, true);
  }

  async function post(path, body) {
    let response;
    try {
      response = await fetch(config.u + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { throw Object.assign(new Error('授权服务器暂时无法连接'), { unavailable: true }); }
    if (response.status >= 500) throw Object.assign(new Error('授权服务器暂时不可用'), { unavailable: true });
    if (!response.ok) {
      let reason;
      try { reason = (await response.json()).error?.message; } catch { /* No response body. */ }
      throw Object.assign(new Error(reason || '授权服务器拒绝此授权'), { denied: true });
    }
    return response.json();
  }

  async function checkStoredActivation() {
    if (!saved || saved.denied) return 'locked';
    const payload = await activationPayload(saved.activation_token, saved.backend_origin);
    if (!payload) return 'locked';
    activePayload = payload;
    if (payload.exp > now() + 300) return 'active';
    try {
      const response = config.gc
        ? await bridgeRequest('/refresh', { package_id: config.i, package_proof: packageProof() })
        : await post('/api/v1/activations/refresh', {
          activation_id: saved.activation_id, refresh_secret: saved.refresh_secret,
          domain: domain(), installation_id: installationId, backend_url: saved.backend_origin,
        });
      const refreshed = await activationPayload(response.activation_token, saved.backend_origin);
      if (!refreshed || refreshed.exp <= now()) return 'locked';
      activePayload = refreshed;
      store({ ...saved, activation_token: response.activation_token });
      await persistBridgeState();
      return 'active';
    } catch (error) {
      if (error.denied) {
        // Persist explicit rejection so a later network outage cannot reactivate this cached token.
        store({ ...saved, denied: true, activation_token: null, refresh_secret: null });
        await persistBridgeState();
        return 'locked';
      }
      if (error.unavailable && payload.offline_until > now()) return 'offline';
      return 'locked';
    }
  }

  function showOffline() {
    const banner = document.createElement('aside');
    banner.id = '__appgog_offline';
    banner.setAttribute('role', 'status');
    banner.textContent = '授权服务暂时离线；已通过本地签名验证，主题可继续使用。网络恢复后会自动刷新。';
    banner.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;padding:12px 16px;border-radius:10px;background:#1e3153;color:#fff;font:13px system-ui;box-shadow:0 8px 28px #0002;max-width:360px';
    document.body.append(banner);
  }

  function newerVersion(latest, current) {
    const pattern = /^\d+(?:\.\d+){1,3}$/;
    if (!pattern.test(latest) || !pattern.test(current)) return false;
    const a = latest.split('.').map(Number), b = current.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  }

  async function checkUpdates() {
    try {
      if (!hasCapability('updates:read')) return;
      // Optional endpoint. A missing feed must never affect the activation state.
      const response = await fetch(`${config.u}/api/v1/releases/latest?product=${encodeURIComponent(config.p)}`);
      if (!response.ok) return;
      const result = await response.json();
      const feed = await signedPayload(result.release_token, notificationPublicKey);
      const latest = result.latest;
      if (!feed || !['release', 'release-feed'].includes(feed.typ) || feed.product !== config.p
        || !Number.isSafeInteger(feed.exp) || feed.exp <= now() || !latest
        || typeof latest.version !== 'string' || feed.version !== latest.version
        || (feed.display_name ?? null) !== (latest.display_name ?? null)
        || (feed.release_notes ?? null) !== (latest.release_notes ?? null)
        || (feed.published_at ?? null) !== (latest.published_at ?? null)
        || (feed.channel ?? null) !== (latest.channel ?? null)
        || (feed.release_kind ?? null) !== (latest.release_kind ?? null)
        || !newerVersion(feed.version, config.v)) return;
      const notice = document.createElement('aside');
      notice.id = '__appgog_update';
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483646;padding:14px 18px;border-radius:10px;background:#fff;color:#14233d;font:14px system-ui;box-shadow:0 8px 30px #0002;border:1px solid #dbe4f1';
      notice.textContent = `APPGOG 新版本 ${feed.version} 已发布，请到打包中心重新构建更新包。`;
      // The navigation URL is used only when the signed token binds the exact response value.
      if (typeof result.build_center_url === 'string' && feed.build_center_url === result.build_center_url) {
        const url = new URL(result.build_center_url);
        if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
          const link = document.createElement('a');
          link.href = url.href;
          link.rel = 'noopener noreferrer';
          link.textContent = '前往打包中心';
          link.style.cssText = 'display:block;margin-top:8px;color:#3266df';
          notice.append(link);
        }
      }
      document.body.append(notice);
    } catch { /* Feed failure is not an activation failure. */ }
  }

  function unlock(state) {
    root.classList.add('__appgog_unlocked');
    root.classList.remove('__appgog_locked');
    document.getElementById('__appgog_gate')?.remove();
    globalThis.APPGOGLicense.status = state;
    if (state === 'offline') showOffline();
    installActivationEntry();
    void checkUpdates();
  }

  function installActivationEntry() {
    // The protected editor owns the entry. No customer homepage button is injected.
    const pathInput = document.getElementById('loginPath');
    if (pathInput && xboardAdminPath) {
      pathInput.value = xboardAdminPath;
      const versionInput = document.getElementById('loginVersion');
      if (versionInput) versionInput.value = 'v2';
      const connection = document.querySelector?.('.ed-login-connection');
      if (connection) { connection.hidden = true; connection.open = false; }
    }
    const nav = document.getElementById('editorTabs');
    if (!nav || document.getElementById('__appgog_activation_entry')) return;
    const entry = document.createElement('button'); entry.type = 'button';
    entry.id = '__appgog_activation_entry'; entry.textContent = '◇ 授权与激活';
    entry.addEventListener('click', () => {
      const existing = document.getElementById('__appgog_activation_detail');
      if (existing) return;
      const panel = document.createElement('dialog'); panel.id = '__appgog_activation_detail';
      panel.style.cssText = 'border:1px solid #e5e7ef;border-radius:20px;padding:32px;max-width:520px;width:calc(100% - 48px);color:#25304a;background:#fff';
      const title = document.createElement('h2'); title.textContent = 'APPGOG 授权与激活';
      const detail = document.createElement('p'); detail.textContent = '状态：' + (globalThis.APPGOGLicense.status === 'offline' ? '已激活（离线宽限期）' : '已激活') + ' · 版本：' + config.v;
      const binding = document.createElement('p'); binding.textContent = '绑定域名：' + domain();
      const expiry = document.createElement('p'); expiry.textContent = '本次签名凭证有效至：' + new Date(activePayload.exp * 1000).toLocaleString();
      const close = document.createElement('button'); close.textContent = '关闭'; close.type = 'button'; close.addEventListener('click', () => panel.close());
      panel.addEventListener('close', () => panel.remove());
      panel.append(title, detail, binding, expiry, close); document.body.append(panel); panel.showModal();
    });
    nav.append(entry);
  }

  function showGate() {
    if (document.getElementById('__appgog_gate')) return;
    const style = document.createElement('style');
    style.textContent = 'html.__appgog_locked body>*:not(#__appgog_gate){visibility:hidden!important}#__appgog_gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;overflow:auto;background:#f6f7fb;color:#202333;font-family:system-ui,-apple-system,sans-serif;padding:24px}#__appgog_gate *{box-sizing:border-box}#__appgog_card{width:min(480px,100%);margin:auto;background:#fff;border:1px solid #e5e7ef;border-radius:20px;padding:32px;box-shadow:0 12px 40px #2023440a}#__appgog_brand{display:flex;align-items:center;gap:12px;margin-bottom:26px;font-size:15px;font-weight:750;letter-spacing:.08em}#__appgog_brand b{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#6554c0;color:#fff;font-size:22px;letter-spacing:-.05em}#__appgog_brand span{display:grid;gap:3px}#__appgog_brand small{font-size:11px;font-weight:400;letter-spacing:0;color:#767b8d}#__appgog_card h1{font-size:24px;line-height:1.3;margin:0 0 12px;letter-spacing:-.025em}#__appgog_card p{color:#72788a;font-size:13px;line-height:1.8;margin:0 0 22px}#__appgog_card label{display:grid;gap:8px;margin:18px 0;font-size:12px;font-weight:650;color:#454b60}#__appgog_card input{width:100%;min-width:0;height:46px;border:1px solid #dfe2eb;background:#fafbfe;color:#202333;border-radius:9px;padding:0 12px;font:inherit;outline:none}#__appgog_card input:focus{border-color:#8572ce;box-shadow:0 0 0 3px #6554c012}#__appgog_card button{min-height:46px;width:100%;padding:10px;border:1px solid #5e4db5;border-radius:9px;background:#6554c0;color:#fff;font-weight:650;margin-top:8px;cursor:pointer}#__appgog_card button:hover{background:#5746b0}#__appgog_card button:focus-visible{outline:3px solid #c6bce8;outline-offset:3px}#__appgog_card button:disabled{opacity:.55;cursor:not-allowed}#__appgog_error{color:#b42338!important;margin:13px 0 0!important;font-size:12px}#__appgog_meta{font-size:11px;line-height:1.8;overflow-wrap:anywhere;color:#8990a2;margin-top:24px;padding-top:16px;border-top:1px solid #edf0f5}#__appgog_timer{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #f0dfb8;background:#fffaf0;border-radius:9px;color:#946619;font-size:12px;margin:0 0 20px}@media(max-width:480px){#__appgog_gate{padding:16px}#__appgog_card{padding:24px 20px;border-radius:16px}#__appgog_card h1{font-size:22px}}';
    document.head.append(style);
    const gate = document.createElement('div'); gate.id = '__appgog_gate';
    const card = document.createElement('div'); card.id = '__appgog_card';
    gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', '__appgog_title');
    const brand = document.createElement('div'); brand.id = '__appgog_brand';
    const mark = document.createElement('b'); mark.textContent = 'A'; mark.setAttribute('aria-hidden', 'true');
    const brandName = document.createElement('span'); brandName.textContent = 'APPGOG';
    const welcome = document.createElement('small'); welcome.textContent = '欢迎使用 APPGOG · 安全激活'; brandName.append(welcome); brand.append(mark, brandName); card.append(brand);
    const hasInstallReceipt = Boolean(saved?.install_receipt_id && saved?.install_receipt_secret && saved?.backend_origin);
    const hasInstallWindow = Boolean(saved?.install_window_id && saved?.install_window_token && saved?.install_window_expires_at);
    const installWindowExpired = hasInstallWindow && Math.floor(new Date(saved.install_window_expires_at).getTime() / 1000) <= now();
    const title = document.createElement('h1'); title.id = '__appgog_title';
    const domainMismatch = integrityFailure?.reason === 'domain';
    title.textContent = domainMismatch ? 'APPGOG 授权域名不匹配'
      : (integrityFailure ? 'APPGOG 安装包完整性验证失败'
      : (bridgeFailure ? 'APPGOG 授权组件未就绪'
      : (activationAdminRequired ? '请登录 Xboard 管理后台'
      : (hasInstallReceipt ? '在线激活 APPGOG' : (hasInstallWindow ? '输入一次性安装 Key' : '激活 APPGOG')))));
    const description = document.createElement('p');
    description.textContent = domainMismatch
      ? `当前安装域名 ${integrityFailure.actual} 与打包绑定域名 ${integrityFailure.expected} 不一致。请先在打包中心完成域名换绑，再重新构建并安装客户专属 ZIP。`
      : integrityFailure
      ? '当前文件不属于授权服务器签发的同一 Build/Package，或已被跨包替换。请重新下载并安装完整 ZIP。'
      : bridgeFailure
      ? bridgeFailure
      : activationAdminRequired
      ? '首次安装与激活只能在已登录的 Xboard 管理员环境中完成。授权完成后，普通访客无需登录即可正常使用主题。'
      : hasInstallReceipt
      ? '安装包已解锁。输入长期固定 License Key，完成域名、服务器身份与套餐能力绑定。'
      : hasInstallWindow
      ? (installWindowExpired
        ? '60 分钟安装激活窗口已经结束。系统将请求 Xboard 服务端安全切回原主题并移除当前未激活主题。'
        : '倒计时不会因刷新、退出登录或输错 Key 重置。验证成功后一次性 Key 立即作废。')
      : '点击后才开始 60 分钟安装激活窗口。开始前不会计时，也不会要求输入 Key。';
    const form = document.createElement('form');
    const installLabel = document.createElement('label'); installLabel.textContent = '一次性安装 Key';
    const installInput = document.createElement('input'); installInput.required = true; installInput.autocomplete = 'off'; installInput.placeholder = 'INS-XXXX-XXXX-XXXX'; installInput.type = 'password'; installLabel.append(installInput);
    const fixedLabel = document.createElement('label'); fixedLabel.textContent = '固定授权 Key';
    const fixedInput = document.createElement('input'); fixedInput.required = true; fixedInput.autocomplete = 'off'; fixedInput.placeholder = 'APPGOG-XXXX-XXXX-XXXX-XXXX'; fixedInput.type = 'password'; fixedLabel.append(fixedInput);
    const backendLabel = document.createElement('label'); backendLabel.textContent = 'Xboard 后台地址';
    const backendInput = document.createElement('input'); backendInput.required = true; backendInput.type = 'url'; backendInput.value = location.origin; backendLabel.append(backendInput);
    const button = document.createElement('button'); button.type = 'submit';
    button.textContent = hasInstallReceipt ? '正式激活 APPGOG'
      : (hasInstallWindow ? (installWindowExpired ? '执行安全清理' : '验证并解锁安装包') : '开始激活');
    const error = document.createElement('p'); error.id = '__appgog_error'; error.setAttribute('role', 'alert');
    const metadata = document.createElement('div'); metadata.id = '__appgog_meta'; metadata.textContent = `授权域名：${domain()} · 版本：${config.v} · Build：${config.b.slice(0, 18)}`;
    let countdownTimer = null;
    if (hasInstallWindow && !hasInstallReceipt) {
      const timer = document.createElement('div'); timer.id = '__appgog_timer';
      const label = document.createElement('span'); label.textContent = installWindowExpired ? '激活窗口已结束' : '剩余激活时间';
      const value = document.createElement('strong'); timer.append(label, value); card.append(timer);
      const renderCountdown = () => {
        const left = Math.max(0, Math.floor(new Date(saved.install_window_expires_at).getTime() / 1000) - now());
        value.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
        if (left === 0 && countdownTimer) { clearInterval(countdownTimer); location.reload(); }
      };
      renderCountdown();
      if (!installWindowExpired) countdownTimer = setInterval(renderCountdown, 1000);
    }
    if (!integrityFailure && (bridgeFailure || activationAdminRequired)) {
      const pathLabel = document.createElement('label'); pathLabel.textContent = 'Xboard 后台地址（仅首次无法识别时填写）';
      const pathInput = document.createElement('input'); pathInput.type = 'text'; pathInput.autocomplete = 'off';
      pathInput.placeholder = '/后台安全路径'; pathInput.value = xboardAdminPath || saved?.xboard_admin_path || connectionPath() || '';
      pathLabel.append(pathInput);
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新检查并准备插件';
      const login = document.createElement('button'); login.type = 'button'; login.textContent = '前往 Xboard 后台登录';
      const selectedPath = () => {
        const value = pathInput.value.trim();
        if (!value) throw new Error('请填写本站 Xboard 后台路径');
        const url = new URL(value.startsWith('/') || /^https?:/.test(value) ? value : '/' + value, location.origin);
        const path = url.pathname.replace(/^\/+|\/+$/g, '');
        if (url.origin !== location.origin || url.username || url.password || !/^[A-Za-z0-9_-]{1,128}$/.test(path)) throw new Error('请输入本站有效后台路径');
        return path;
      };
      retry.addEventListener('click', async () => {
        retry.disabled = true; error.textContent = '';
        try {
          if (pathInput.value.trim()) rememberAdminPath(selectedPath());
          progress('正在重试，请稍候…');
          await ensureBridge(); bridgeFailure = null; location.reload();
        } catch (failure) { error.textContent = failure.message; }
        finally { retry.disabled = false; }
      });
      login.addEventListener('click', () => {
        try { const path = selectedPath(); rememberAdminPath(path); location.assign('/' + path); }
        catch (failure) { error.textContent = failure.message; }
      });
      const status = document.createElement('p'); status.id = '__appgog_setup_progress'; status.setAttribute('role','status'); status.textContent = setupMessage;
      form.append(pathLabel, retry, login, status);
    }
    if (integrityFailure || bridgeFailure || activationAdminRequired) {
      button.disabled = true;
      button.textContent = integrityFailure ? '请重新安装完整授权包'
        : (bridgeFailure ? '授权组件未就绪' : '请先登录 Xboard 管理后台');
      form.append(button, error);
    } else if (hasInstallReceipt) form.append(fixedLabel, button, error);
    else if (!hasInstallWindow || installWindowExpired) form.append(button, error);
    else form.append(installLabel, button, error);
    card.append(title, description, form, metadata); gate.append(card); document.body.append(gate);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); button.disabled = true; button.textContent = '正在验证…'; error.textContent = '';
      try {
        if (!hasInstallReceipt && !hasInstallWindow) {
          const tokenBytes = new Uint8Array(32); crypto.getRandomValues(tokenBytes);
          const installWindowToken = saved?.install_window_token || `IWT_${[...tokenBytes].map((item) => item.toString(16).padStart(2, '0')).join('')}`;
          store({ ...(saved || {}), install_window_token: installWindowToken });
          const windowProof = await installationProof('install_window', {
            build_id: config.b, domain: domain(), install_window_token: installWindowToken,
          });
          const started = await post('/api/v1/install-windows/start', {
            build_id: config.b, package_proof: packageProof(), domain: domain(),
            installation_id: installationId, install_window_token: installWindowToken,
            installation_public_key: windowProof.installation_public_key,
            challenge_id: windowProof.challenge_id, challenge_signature: windowProof.challenge_signature,
          });
          store({ ...(saved || {}), install_window_token: installWindowToken,
            install_window_id: started.install_window_id, install_window_expires_at: started.expires_at });
          await persistBridgeState();
          location.reload();
          return;
        }
        if (!hasInstallReceipt && installWindowExpired) {
          const expired = await post('/api/v1/install-windows/expire', {
            install_window_id: saved.install_window_id, install_window_token: saved.install_window_token,
          });
          if (!expired.cleanup_required) throw new Error('服务器尚未确认激活窗口结束');
          const bridge = globalThis.APPGOGThemeBridge;
          if (!bridge || typeof bridge.deactivateAndRemoveTheme !== 'function') {
            throw new Error('Xboard 服务端桥未安装，主题已锁定；请由管理员安全切回原主题后删除当前主题');
          }
          await bridge.deactivateAndRemoveTheme();
          return;
        }
        if (!hasInstallReceipt) {
          const backendOrigin = origin(backendInput.value.trim());
          if (!backendOrigin) throw new Error('Xboard 后台地址无效');
          const receipt = await post('/api/v2/install-unlocks', {
            install_key: installInput.value.trim(), build_id: config.b,
            package_proof: packageProof(), domain: domain(),
            backend_url: backendOrigin, installation_id: installationId,
            install_window_id: saved.install_window_id, install_window_token: saved.install_window_token,
          });
          const backendPath = new URL(backendInput.value.trim()).pathname.split('/').filter(Boolean)[0];
          store({ ...(saved || {}), install_receipt_id: receipt.install_receipt_id,
            install_receipt_secret: receipt.install_receipt_secret, backend_origin: backendOrigin,
            xboard_admin_path: backendOrigin === location.origin && /^[A-Za-z0-9_-]{1,128}$/.test(backendPath || '')
              ? backendPath : xboardAdminPath || saved?.xboard_admin_path });
          await persistBridgeState();
          installInput.value = '';
          const editor = new URL('/theme/' + encodeURIComponent(config.gt || 'APPGOG') + '/editor.html', location.origin);
          if (xboardAdminPath) editor.searchParams.set('appgog_admin_path', xboardAdminPath);
          location.assign(editor.href);
          return;
        }
        const proof = config.gc ? await installationProof('activation', {
          install_receipt_id: saved.install_receipt_id, build_id: config.b,
          domain: domain(), backend_origin: saved.backend_origin,
        }) : null;
        const result = await post('/api/v1/activations', {
          license_key: fixedInput.value.trim(), install_receipt_id: saved.install_receipt_id,
          install_receipt_secret: saved.install_receipt_secret,
          build_id: config.b, package_proof: packageProof(), domain: domain(),
          backend_url: saved.backend_origin, installation_id: installationId,
          ...(proof ? {
            installation_public_key: proof.installation_public_key,
            challenge_id: proof.challenge_id, challenge_signature: proof.challenge_signature,
          } : {}),
        });
        const payload = await activationPayload(result.activation_token, saved.backend_origin);
        if (!payload || payload.exp <= now()) throw new Error('激活凭证本地验证失败');
        activePayload = payload;
        const activatedState = { activation_id: result.activation_id, activation_token: result.activation_token,
          refresh_secret: result.refresh_secret, backend_origin: saved.backend_origin, denied: false };
        await persistBridgeState(activatedState);
        const { refresh_secret, install_receipt_secret, install_window_token, ...safeState } = saved || {};
        store(config.gc
          ? { ...safeState, activation_id: result.activation_id, activation_token: result.activation_token,
            backend_origin: saved.backend_origin, denied: false }
          : activatedState);
        fixedInput.value = '';
        location.reload();
      } catch (failure) {
        error.textContent = failure.message || (hasInstallReceipt ? '激活失败' : '安装解锁失败');
        button.disabled = false;
        button.textContent = hasInstallReceipt ? '正式激活 APPGOG'
          : (hasInstallWindow ? (installWindowExpired ? '执行安全清理' : '验证并解锁安装包') : '开始激活');
      }
    });
  }

  globalThis.APPGOGLicense = {
    product: config.p, version: config.v, buildId: config.b, packageId: config.i,
    installationId, status: 'checking', checkUpdates, hasCapability, requireCapability,
  };
  const start = () => { void packageIdentityValid().then(async (result) => {
    if (!result.ok) { integrityFailure = result; showGate(); return; }
    try {
      await ensureBridge();
      globalThis.APPGOGLicense.installationId = installationId;
      const windowExpired = saved?.install_window_id && !saved?.activation_id
        && Math.floor(new Date(saved.install_window_expires_at).getTime() / 1000) <= now();
      if (config.gc && windowExpired) {
        await globalThis.APPGOGThemeBridge.deactivateAndRemoveTheme();
        return;
      }
    } catch (error) {
      bridgeFailure = error?.message || 'APPGOG 授权桥安装或健康检查失败';
      showGate();
      return;
    }
    const state = await checkStoredActivation();
    if (state === 'locked') showGate(); else unlock(state);
  }).catch(() => { integrityFailure = { reason: 'runtime' }; showGate(); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function randomizedIdentifiers(source, packageId) {
  const names = [
    'integrityFailure', 'activePayload', 'signedPayload', 'activationPayload', 'protectedIdentityValid',
    'packageIdentityValid', 'checkStoredActivation', 'releasePayload', 'offlineValid',
    'hasCapability', 'requireCapability',
  ];
  let output = source;
  for (const [index, name] of names.entries()) {
    const suffix = createHash('sha256').update(`${packageId}:${index}:${name}`).digest('hex').slice(0, 10);
    output = output.replace(new RegExp(`\\b${name}\\b`, 'g'), `_p${suffix}`);
  }
  return output;
}

export function createBrowserLicenseRuntime({
  injection,
  publicKeyPem,
  activationPublicKeyPem = publicKeyPem,
  packagePublicKeyPem = publicKeyPem,
  notificationPublicKeyPem = publicKeyPem,
  protectedIdentity = null,
  xboardBridge = null,
}) {
  const runtimeConfig = {
    p: injection.product,
    v: injection.version,
    b: injection.build_id,
    i: injection.package_id,
    u: injection.license_server,
    k: publicKeyDer(publicKeyPem),
    a: publicKeyDer(activationPublicKeyPem),
    q: publicKeyDer(packagePublicKeyPem),
    n: publicKeyDer(notificationPublicKeyPem),
    s: injection.package_proof_parts.map((part) => Buffer.from(part, 'utf8').toString('base64')),
    o: injection.package_proof_order,
    m: injection.package_manifest_token,
    w: injection.watermark,
    ...(protectedIdentity ? { x: protectedIdentity.ref, h: protectedIdentity.sha256 } : {}),
    ...(xboardBridge ? {
      gc: xboardBridge.code, gv: xboardBridge.version, gt: xboardBridge.themeName,
      j: xboardBridge.ref, y: xboardBridge.sha256,
    } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(runtimeConfig), 'utf8').toString('base64');
  const namespace = `a${createHash('sha256').update(injection.package_id).digest('hex').slice(0, 11)}`;
  const runtime = randomizedIdentifiers(browserLicenseRuntime.toString(), injection.package_id);
  return `;/* APPGOG ${namespace} */(${runtime})(JSON.parse(atob(${JSON.stringify(encoded)})));`;
}
