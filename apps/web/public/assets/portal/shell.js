import { $, createPermissionCheck, createPortalState } from './core.js';
import { createApiClient } from './api-client.js';
import { appendDialogActions, createDialog, showSecretDialog } from './dialog.js';

export function createPortalShell(actor) {
  const state = createPortalState(actor);
  const can = createPermissionCheck(state);
  let controller = null;

  function notify(message, error = false) {
    const toast = $('message');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.hidden = false;
    clearTimeout(state.notificationTimer);
    state.notificationTimer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function applyBranding(branding = {}) {
    const platformName = String(branding.platform_name || 'APPGOG打包授权系统').trim();
    document.querySelectorAll('[data-brand-name]').forEach((item) => { item.textContent = platformName; });
    document.querySelectorAll('.wordmark span').forEach((item) => { item.textContent = platformName; });
    document.querySelectorAll('.admin-entry-footer span:nth-child(2)').forEach((item) => {
      item.textContent = `${platformName} · ${actor === 'customer' ? '主题交付' : '授权管理平台'}`;
    });
    document.title = `${actor === 'customer' ? '打包中心' : '运营中心'}｜${platformName}`;
  }

  function setView(authenticated) {
    const login = $('login-view');
    const dashboard = $('dashboard-view');
    if (login) login.hidden = authenticated;
    if (dashboard) dashboard.hidden = !authenticated;
    if (!authenticated) {
      document.querySelectorAll('dialog[open]').forEach((dialog) => {
        dialog.close();
        dialog.querySelectorAll('form').forEach((form) => form.reset());
      });
      state.csrf = null;
      state.data = null;
      state.loading = false;
      state.permissions = [];
      state.session = null;
      history.replaceState(null, '', location.pathname);
    }
  }

  function selectView(view) {
    const page = [...document.querySelectorAll('.page-view')].find((item) => item.dataset.page === view);
    const nav = [...document.querySelectorAll('.nav-item')].find((item) => item.dataset.view === view);
    if (!page || nav?.hidden) return;
    for (const item of document.querySelectorAll('.page-view')) item.classList.toggle('active', item === page);
    for (const item of document.querySelectorAll('.nav-item')) {
      const active = item.dataset.view === view;
      item.classList.toggle('active', active);
      if (active && $('page-title')) $('page-title').textContent = item.dataset.title;
      item.setAttribute('aria-current', active ? 'page' : 'false');
    }
    $('dashboard-view')?.classList.remove('nav-open');
    history.replaceState(null, '', `#${view}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  const api = createApiClient({ state, onSessionInvalid: () => setView(false) });

  async function refresh() {
    if (state.loading || !state.csrf || !controller) return;
    state.loading = true;
    try {
      const data = await api.request(`/web/${actor}/overview`);
      state.data = data;
      applyBranding(actor === 'admin' ? data.cms : data);
      controller.render(data);
    } catch (error) { notify(error.message, true); }
    finally { state.loading = false; }
  }

  function actions(card, close, label, onConfirm, danger = false) {
    appendDialogActions({ card, close, label, onConfirm, danger, notify });
  }

  function showSecret(title, secret, description, downloadHref) {
    showSecretDialog({ title, secret, description, downloadHref, notify });
  }

  function bindChrome() {
    document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => selectView(item.dataset.view)));
    document.querySelectorAll('[data-go-view]').forEach((item) => item.addEventListener('click', () => selectView(item.dataset.goView)));
    document.querySelector('.mobile-menu')?.addEventListener('click', () => $('dashboard-view')?.classList.toggle('nav-open'));
    document.addEventListener('click', (event) => {
      const dashboard = $('dashboard-view');
      if (event.target === dashboard && dashboard?.classList.contains('nav-open')) dashboard.classList.remove('nav-open');
    });

    $('login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('[type="submit"]');
      const loginError = $('login-error');
      const submitLabel = $('login-submit-label');
      if (loginError) { loginError.hidden = true; loginError.textContent = ''; }
      if (submitLabel) submitLabel.textContent = actor === 'customer' ? '正在验证…' : '正在登录…';
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      try {
        const fields = new FormData(form);
        const body = actor === 'customer'
          ? { license_key: fields.get('license_key') }
          : { username: fields.get('username'), password: fields.get('password') };
        const result = await api.request(`/web/${actor}/login`, { method: 'POST', body });
        state.csrf = result.csrf_token;
        state.session = result;
        controller.applySession?.(result);
        form.reset();
        setView(true);
        selectView('overview');
        await refresh();
        await controller.afterSession?.(result);
      } catch (error) {
        if (loginError && !$('login-view')?.hidden) { loginError.textContent = error.message; loginError.hidden = false; }
        else notify(error.message, true);
      } finally {
        submit.disabled = false;
        form.removeAttribute('aria-busy');
        if (submitLabel) submitLabel.textContent = actor === 'customer' ? '验证并进入' : '登录后台';
      }
    });

    $('logout')?.addEventListener('click', async () => {
      try { await api.request(`/web/logout?actor=${actor}`, { method: 'POST' }); }
      catch (error) { notify(error.message, true); }
      setView(false);
    });
  }

  async function restoreSession() {
    try {
      const session = await api.request(`/web/session?actor=${actor}`);
      if (session.actor !== actor) return setView(false);
      state.csrf = session.csrf_token;
      state.session = session;
      controller.applySession?.(session);
      setView(true);
      const requested = location.hash.slice(1);
      const initialView = [...document.querySelectorAll('.page-view')].some((item) => item.dataset.page === requested)
        ? requested : 'overview';
      selectView(initialView);
      await refresh();
      await controller.afterSession?.(session);
    } catch { setView(false); }
  }

  async function loadBranding() {
    try { applyBranding(await api.request('/web/branding')); }
    catch { applyBranding(); }
  }

  function mount(pageController) {
    if (document.body.dataset.portal !== actor) throw new Error(`门户入口不匹配：${actor}`);
    controller = pageController;
    bindChrome();
    controller.bind();
    loadBranding();
    restoreSession();
  }

  return Object.freeze({
    actor, state, can, request: api.request, uploadZip: api.uploadZip,
    uploadTicketAttachment: api.uploadTicketAttachment, notify, setView, selectView,
    refresh, dialog: createDialog, actions, showSecret, mount,
  });
}
