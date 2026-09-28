import { $ } from './core.js';
import { fileSize } from './ui.js';

function detectedVersionFromFilename(name) {
  if (!/appgog/i.test(name ?? '')) return null;
  return String(name).replace(/\.zip$/i, '').match(/(?:^|[-_\s])v?(\d+\.\d+\.\d+)(?:$|[-_\s])/i)?.[1] ?? null;
}

export function createAdminReleaseUpload(shell) {
  const { state, uploadZip, notify, refresh } = shell;

  let publishing = false;
  function showStatus(message, failed = false) {
    const status = $('release-publish-status');
    status.textContent = message; status.hidden = false; status.classList.toggle('error', failed);
  }

  function setSourceFile(file) {
    if (publishing) return;
    const input = $('source-zip');
    const zone = $('source-upload');
    if (!input || !zone) return;
    if (!file) {
      state.sourceFile = null;
      input.value = '';
      zone.classList.remove('has-file', 'upload-valid', 'upload-error');
      $('source-file-meta').hidden = true;
      $('source-upload-progress').hidden = true;
      $('source-upload-title').textContent = '点击选择或拖拽主题 ZIP 到这里';
      $('source-file-status').textContent = '最大 128 MB；上传后自动识别版本号和版本名称';
      return;
    }
    if (!/\.zip$/i.test(file.name) || (file.type && !['application/zip', 'application/x-zip-compressed'].includes(file.type))) {
      setSourceFile(null);
      zone.classList.add('upload-error');
      $('source-file-status').textContent = '文件类型错误：只能上传 ZIP 安装包';
      throw new Error('只能上传 ZIP 安装包');
    }
    if (file.size > 128 * 1024 * 1024) {
      setSourceFile(null);
      zone.classList.add('upload-error');
      $('source-file-status').textContent = '文件超过 128 MB 限制';
      throw new Error('主题 ZIP 不能超过 128 MB');
    }
    state.sourceFile = file;
    zone.classList.add('has-file', 'upload-valid');
    zone.classList.remove('upload-error');
    $('source-file-name').textContent = file.name;
    $('source-file-size').textContent = fileSize(file.size);
    $('source-file-meta').hidden = false;
    $('source-upload-title').textContent = '主题 ZIP 已选择';
    const detected = detectedVersionFromFilename(file.name);
    const form = $('version-form');
    if (detected && form) {
      form.elements.version.value = detected;
      form.elements.display_name.value = `APPGOG ${detected}`;
      $('source-file-status').textContent = `已从文件名识别版本 ${detected}；服务端还会读取 config.json 最终校验`;
    } else {
      $('source-file-status').textContent = '未从文件名识别版本，请手动填写；服务端会优先读取 config.json 校验';
    }
  }

  function bindDropZone() {
    const zone = $('source-upload');
    const input = $('source-zip');
    if (!zone || !input) return;
    zone.addEventListener('click', (event) => { if (!event.target.closest('#source-file-remove')) input.click(); });
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      try { setSourceFile(input.files?.[0] ?? null); } catch (error) { notify(error.message, true); }
    });
    for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, (event) => {
      event.preventDefault(); zone.classList.add('is-dragging');
    });
    for (const eventName of ['dragleave', 'drop']) zone.addEventListener(eventName, (event) => {
      event.preventDefault(); zone.classList.remove('is-dragging');
    });
    zone.addEventListener('drop', (event) => {
      try { setSourceFile(event.dataTransfer?.files?.[0] ?? null); } catch (error) { notify(error.message, true); }
    });
    $('source-file-remove')?.addEventListener('click', (event) => { event.stopPropagation(); setSourceFile(null); });
  }

  function bind() {
    bindDropZone();
    $('version-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (publishing) return;
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      const label = submit.querySelector('span');
      submit.disabled = true;
      showStatus('正在检查发布信息…');
      try {
        const fields = new FormData(form);
        if (!fields.get('product_code')) throw new Error('请选择有效产品；没有产品时请先创建产品');
        const file = state.sourceFile ?? fields.get('source_zip');
        if (!(file instanceof File) || !file.size) throw new Error('请选择主题 ZIP');
        const planCodes = fields.getAll('plan_codes');
        if (!planCodes.length) throw new Error('请选择至少一个可用套餐');
        const params = new URLSearchParams({
          product_code: String(fields.get('product_code') || ''), source_filename: file.name,
          version: String(fields.get('version')), display_name: String(fields.get('display_name') || ''),
          release_notes: String(fields.get('release_notes') || ''), channel: String(fields.get('channel') || 'stable'),
          release_kind: String(fields.get('release_kind') || 'feature'),
        });
        for (const code of planCodes) params.append('plan_code',code);
        const progressWrap = $('source-upload-progress');
        const progressFill = $('source-upload-progress-fill');
        const progressText = $('source-upload-progress-text');
        publishing = true;
        form.setAttribute('aria-busy', 'true');
        label.textContent = '正在上传并检查…';
        progressWrap.hidden = false;
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        showStatus('正在上传，请等待安全检查完成。');
        $('source-file-status').textContent = '正在上传并执行 ZIP 安全检查…';
        const result = await uploadZip(`/web/admin/versions/upload?${params}`, file, (percent) => {
          progressFill.style.width = `${percent}%`;
          progressText.textContent = percent === 100 ? '安全检查中…' : `${percent}%`;
          if (percent === 100) showStatus('上传已完成，服务器正在安全检查，请稍候。');
        });
        progressFill.style.width = '100%';
        progressText.textContent = '校验通过';
        form.reset();
        publishing = false;
        setSourceFile(null);
        for (const id of ['version-search', 'version-product-filter', 'version-status-filter']) { if ($(id)) $(id).value = ''; }
        showStatus(`${result.display_name || result.version} 已发布，版本目录已请求刷新。`);
        notify(`${result.display_name || result.version} 安全检查通过，版本已发布`);
        await refresh();
      } catch (error) { showStatus(error.message, true); notify(error.message, true); }
      finally { publishing = false; form.removeAttribute('aria-busy'); submit.disabled = false; label.textContent = '安全检查并发布版本'; }
    });
  }

  return Object.freeze({ bind, setSourceFile });
}
