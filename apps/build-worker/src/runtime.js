import { createHash } from 'node:crypto';

function publicKeyDer(pem) {
  return pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, '');
}

// This function is serialized into the installed theme. Keep it self-contained: it has no Node dependencies.
export function browserLicenseRuntime(config) {
  const root = document.documentElement;
  root.classList.add('__appgog_locked');
  const storageKey = `appgog_license_${config.i}`;
  const installKey = `appgog_install_${config.p}`;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
  let installationId = localStorage.getItem(installKey);
  if (!installationId) {
    installationId = crypto.randomUUID ? crypto.randomUUID() : `ins_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(installKey, installationId);
  }

  const now = () => Math.floor(Date.now() / 1000);
  const bytes = (base64) => {
    let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  };
  const parsed = (base64) => JSON.parse(new TextDecoder().decode(bytes(base64)));
  const domain = () => location.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  const origin = (value) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return url.origin.toLowerCase();
    } catch { return ''; }
  };
  const packageProof = () => config.o.map((index) => atob(config.s[index])).join('');
  const store = (value) => { saved = value; localStorage.setItem(storageKey, JSON.stringify(value)); };
  const publicKey = crypto.subtle.importKey('spki', bytes(config.k), { name: 'Ed25519' }, false, ['verify']);

  async function signedPayload(token) {
    try {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const header = parsed(parts[0]);
      if (header.alg !== 'EdDSA' || header.typ !== 'APPGOG-ACT' || header.v !== 1) return null;
      const key = await publicKey;
      if (!await crypto.subtle.verify('Ed25519', key, bytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
      return parsed(parts[1]);
    } catch { return null; }
  }

  async function activationPayload(token, backendOrigin) {
    const payload = await signedPayload(token);
    if (!payload || payload.typ !== 'activation' || payload.product !== config.p
      || payload.build_id !== config.b || payload.package_id !== config.i
      || payload.domain !== domain() || payload.installation_id !== installationId
      || !backendOrigin || payload.backend_origin !== origin(backendOrigin)
      || !Number.isSafeInteger(payload.exp) || payload.exp <= 0
      || !Number.isSafeInteger(payload.offline_until) || payload.offline_until < payload.exp) return null;
    return payload;
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
    if (payload.exp > now() + 300) return 'active';
    try {
      const response = await post('/api/v1/activations/refresh', {
        activation_id: saved.activation_id,
        refresh_secret: saved.refresh_secret,
        domain: domain(), installation_id: installationId, backend_url: saved.backend_origin,
      });
      const refreshed = await activationPayload(response.activation_token, saved.backend_origin);
      if (!refreshed || refreshed.exp <= now()) return 'locked';
      store({ ...saved, activation_token: response.activation_token });
      return 'active';
    } catch (error) {
      if (error.denied) {
        // Persist explicit rejection so a later network outage cannot reactivate this cached token.
        store({ ...saved, denied: true, activation_token: null, refresh_secret: null });
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
      // Optional endpoint. A missing feed must never affect the activation state.
      const response = await fetch(`${config.u}/api/v1/releases/latest?product=${encodeURIComponent(config.p)}`);
      if (!response.ok) return;
      const result = await response.json();
      const feed = await signedPayload(result.release_token);
      const latest = result.latest;
      if (!feed || !['release', 'release-feed'].includes(feed.typ) || feed.product !== config.p
        || !Number.isSafeInteger(feed.exp) || feed.exp <= now() || !latest
        || typeof latest.version !== 'string' || feed.version !== latest.version
        || (feed.display_name ?? null) !== (latest.display_name ?? null)
        || (feed.release_notes ?? null) !== (latest.release_notes ?? null)
        || (feed.published_at ?? null) !== (latest.published_at ?? null)
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
    root.classList.remove('__appgog_locked');
    document.getElementById('__appgog_gate')?.remove();
    globalThis.APPGOGLicense.status = state;
    if (state === 'offline') showOffline();
    void checkUpdates();
  }

  function showGate() {
    if (document.getElementById('__appgog_gate')) return;
    const style = document.createElement('style');
    style.textContent = 'html.__appgog_locked body>*:not(#__appgog_gate){visibility:hidden!important}#__appgog_gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#f4f7fb;color:#172033;font-family:system-ui,-apple-system,sans-serif;padding:24px}#__appgog_gate *{box-sizing:border-box}#__appgog_card{width:min(520px,100%);background:#fff;border:1px solid #dfe6f0;border-radius:18px;padding:32px;box-shadow:0 20px 60px #20345c1a}#__appgog_card h1{font-size:27px;margin:0 0 9px}#__appgog_card p{color:#6c7890;line-height:1.7;margin:0 0 22px}#__appgog_card label{display:grid;gap:8px;margin:15px 0;font-size:12px;font-weight:700}#__appgog_card input{height:45px;border:1px solid #d6deea;border-radius:9px;padding:0 13px;font:inherit}#__appgog_card button{height:46px;width:100%;border:0;border-radius:9px;background:#376ce4;color:#fff;font-weight:750;margin-top:8px}#__appgog_error{color:#b83f52!important;margin:13px 0 0!important;font-size:12px}#__appgog_meta{font-size:11px;color:#98a3b4;margin-top:20px}';
    document.head.append(style);
    const gate = document.createElement('div'); gate.id = '__appgog_gate';
    const card = document.createElement('div'); card.id = '__appgog_card';
    const title = document.createElement('h1'); title.textContent = 'APPGOG 授权激活';
    const description = document.createElement('p');
    description.textContent = '输入本次安装 Key 与购买时获得的固定授权 Key，绑定当前域名与安装环境。';
    const form = document.createElement('form');
    const installLabel = document.createElement('label'); installLabel.textContent = '一次性安装 Key';
    const installInput = document.createElement('input'); installInput.required = true; installInput.autocomplete = 'off'; installInput.placeholder = 'INS-XXXX-XXXX-XXXX'; installInput.type = 'password'; installLabel.append(installInput);
    const fixedLabel = document.createElement('label'); fixedLabel.textContent = '固定授权 Key';
    const fixedInput = document.createElement('input'); fixedInput.required = true; fixedInput.autocomplete = 'off'; fixedInput.placeholder = 'APPGOG-XXXX-XXXX-XXXX-XXXX'; fixedInput.type = 'password'; fixedLabel.append(fixedInput);
    const backendLabel = document.createElement('label'); backendLabel.textContent = 'Xboard 后台地址';
    const backendInput = document.createElement('input'); backendInput.required = true; backendInput.type = 'url'; backendInput.value = location.origin; backendLabel.append(backendInput);
    const button = document.createElement('button'); button.type = 'submit'; button.textContent = '验证并激活';
    const error = document.createElement('p'); error.id = '__appgog_error';
    const metadata = document.createElement('div'); metadata.id = '__appgog_meta'; metadata.textContent = `授权域名：${domain()} · 版本：${config.v}`;
    form.append(installLabel, fixedLabel, backendLabel, button, error);
    card.append(title, description, form, metadata); gate.append(card); document.body.append(gate);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); button.disabled = true; button.textContent = '正在验证…'; error.textContent = '';
      try {
        const backendOrigin = origin(backendInput.value.trim());
        if (!backendOrigin) throw new Error('Xboard 后台地址无效');
        const result = await post('/api/v1/activations', {
          install_key: installInput.value.trim(), license_key: fixedInput.value.trim(),
          build_id: config.b, package_proof: packageProof(), domain: domain(),
          backend_url: backendOrigin, installation_id: installationId,
        });
        const payload = await activationPayload(result.activation_token, backendOrigin);
        if (!payload || payload.exp <= now()) throw new Error('激活凭证本地验证失败');
        store({ activation_id: result.activation_id, activation_token: result.activation_token,
          refresh_secret: result.refresh_secret, backend_origin: backendOrigin });
        fixedInput.value = ''; installInput.value = '';
        location.reload();
      } catch (failure) {
        error.textContent = failure.message || '激活失败'; button.disabled = false; button.textContent = '验证并激活';
      }
    });
  }

  globalThis.APPGOGLicense = {
    product: config.p, version: config.v, buildId: config.b, packageId: config.i,
    installationId, status: 'checking', checkUpdates,
  };
  const start = () => { void checkStoredActivation().then((state) => state === 'locked' ? showGate() : unlock(state)).catch(showGate); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

export function createBrowserLicenseRuntime({ injection, publicKeyPem }) {
  const runtimeConfig = {
    p: injection.product,
    v: injection.version,
    b: injection.build_id,
    i: injection.package_id,
    u: injection.license_server,
    k: publicKeyDer(publicKeyPem),
    s: injection.package_proof_parts.map((part) => Buffer.from(part, 'utf8').toString('base64')),
    o: injection.package_proof_order,
  };
  const encoded = Buffer.from(JSON.stringify(runtimeConfig), 'utf8').toString('base64');
  const namespace = `a${createHash('sha256').update(injection.package_id).digest('hex').slice(0, 11)}`;
  return `;/* APPGOG ${namespace} */(${browserLicenseRuntime.toString()})(JSON.parse(atob(${JSON.stringify(encoded)})));`;
}
