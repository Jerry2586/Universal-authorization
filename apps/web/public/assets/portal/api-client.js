export function createApiClient({ state, onSessionInvalid }) {
  function invalidateSession() {
    state.csrf = null;
    state.session = null;
    onSessionInvalid?.();
  }

  async function parseResponse(response) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      throw new Error(text.trim() || `服务器返回了无法识别的响应 (${response.status})`);
    }
    return response.json();
  }

  async function request(path, { method = 'GET', body, raw = false } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(raw ? { 'content-type': 'application/zip' } : body ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' && state.csrf && !path.endsWith('/login') ? { 'x-csrf-token': state.csrf } : {}),
        },
        ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('无法连接服务器，请检查网络后重试');
    }
    const result = await parseResponse(response);
    if (!response.ok) {
      if (response.status === 401 || (response.status === 403 && result.error?.code === 'SESSION_INVALID')) invalidateSession();
      throw new Error(result.error?.message ?? `请求失败 (${response.status})`);
    }
    return result;
  }

  function uploadZip(path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.responseType = 'json';
      xhr.withCredentials = true;
      xhr.setRequestHeader('content-type', 'application/zip');
      if (state.csrf) xhr.setRequestHeader('x-csrf-token', state.csrf);
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      });
      xhr.addEventListener('load', () => {
        const result = xhr.response ?? (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
        if (xhr.status >= 200 && xhr.status < 300) return resolve(result);
        if (xhr.status === 401 || (xhr.status === 403 && result.error?.code === 'SESSION_INVALID')) invalidateSession();
        reject(new Error(result.error?.message ?? `上传失败 (${xhr.status})`));
      });
      xhr.addEventListener('error', () => reject(new Error('网络连接中断，主题 ZIP 上传失败')));
      xhr.addEventListener('abort', () => reject(new Error('主题 ZIP 上传已取消')));
      xhr.send(file);
    });
  }

  async function uploadTicketAttachment(path, file) {
    if (!(file instanceof File) || !file.size) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error('附件不能超过 10 MB');
    const separator = path.includes('?') ? '&' : '?';
    let response;
    try {
      response = await fetch(`${path}${separator}filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: {
          'content-type': file.type || (file.name.toLowerCase().endsWith('.log') ? 'text/plain' : 'application/octet-stream'),
          'x-csrf-token': state.csrf,
        },
        body: file,
      });
    } catch {
      throw new Error('无法连接服务器，附件上传失败');
    }
    const result = await parseResponse(response);
    if (!response.ok) {
      if (response.status === 401 || (response.status === 403 && result.error?.code === 'SESSION_INVALID')) invalidateSession();
      throw new Error(result.error?.message ?? `附件上传失败 (${response.status})`);
    }
    return result;
  }

  return { request, uploadZip, uploadTicketAttachment };
}
