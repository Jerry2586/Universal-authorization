import { $ } from './core.js';
import { date } from './ui.js';

export function createAnnouncementUi({ request, notify, refresh }) {
  function preview(publishedAt = null) {
    const form = $('announcement-form');
    if (!form) return;
    const title = String(form.elements.title?.value ?? '').trim();
    const body = String(form.elements.body?.value ?? '').trim();
    const enabled = form.elements.enabled?.checked === true && Boolean(title || body);
    if ($('announcement-title-count')) $('announcement-title-count').textContent = `${form.elements.title?.value.length ?? 0} / 200`;
    if ($('announcement-body-count')) $('announcement-body-count').textContent = `${form.elements.body?.value.length ?? 0} / 4000`;
    if ($('announcement-preview-title')) $('announcement-preview-title').textContent = title || '公告标题';
    if ($('announcement-preview-body')) $('announcement-preview-body').textContent = body || '公告内容会显示在这里。';
    if ($('announcement-preview-time')) $('announcement-preview-time').textContent = publishedAt ? `发布于 ${date(publishedAt)}` : '尚未发布';
    if ($('announcement-preview-state')) $('announcement-preview-state').textContent = enabled ? '客户可见' : '当前未启用';
    if ($('announcement-published-time')) $('announcement-published-time').textContent = publishedAt ? `最近发布：${date(publishedAt)}` : '尚未发布';
    $('announcement-preview-card')?.classList.toggle('is-disabled', !enabled);
    $('announcement-preview-dot')?.classList.toggle('is-live', enabled);
  }

  function render(cms) {
    const form = $('announcement-form');
    if (form) {
      form.elements.title.value = cms.announcement_title ?? '';
      form.elements.body.value = cms.announcement_body ?? '';
      form.elements.enabled.checked = cms.announcement_enabled === true;
      preview(cms.announcement_published_at);
    }
    if ($('announcement-state')) {
      $('announcement-state').textContent = cms.announcement_enabled ? '已启用' : '未启用';
      $('announcement-state').classList.toggle('status-success', cms.announcement_enabled === true);
    }
  }

  function bind() {
    const form = $('announcement-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const fields = new FormData(form);
        await request('/web/admin/announcement', { method: 'POST', body: {
          title: String(fields.get('title') || '').trim(),
          body: String(fields.get('body') || '').trim(),
          enabled: fields.has('enabled'),
        } });
        notify('客户公告已保存');
        await refresh();
      } catch (error) { notify(error.message, true); }
      finally { submit.disabled = false; }
    });
    form?.addEventListener('input', () => preview());
    form?.addEventListener('change', () => preview());
  }

  return { bind, render };
}
