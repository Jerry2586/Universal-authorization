/* Portal appearance only. Never reads session, license or authorization data. */
(() => {
  'use strict';
  const key = 'appgog:portal:appearance';
  const modes = ['light', 'dark', 'system'];
  const labels = { light: '日间主题', dark: '夜间主题', system: '跟随系统' };
  const icons = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    dark: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'
  };
  const svg = mode => '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[mode] + '</svg>';
  const valid = value => modes.includes(value) ? value : 'system';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = valid(localStorage.getItem(key)); } catch { /* Works when storage is unavailable. */ }
  const controls = [];
  function close(control, focus = false) {
    control.menu.hidden = true;
    control.trigger.setAttribute('aria-expanded', 'false');
    if (focus) control.trigger.focus();
  }
  function apply(value, persist = false) {
    preference = valid(value);
    const resolved = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.portalTheme = resolved;
    document.documentElement.dataset.portalAppearance = preference;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === 'dark' ? '#101217' : '#f8fafc';
    if (persist) { try { localStorage.setItem(key, preference); } catch { /* Keep in-memory selection. */ } }
    for (const control of controls) {
      control.trigger.innerHTML = svg(preference);
      control.trigger.setAttribute('aria-label', '切换外观，当前' + labels[preference]);
      control.trigger.title = '切换外观 · ' + labels[preference];
      for (const item of control.items) {
        const selected = item.dataset.appearance === preference;
        item.setAttribute('aria-checked', String(selected));
        item.querySelector('.appearance-check').textContent = selected ? '✓' : '';
      }
    }
  }
  apply(preference);
  system.addEventListener('change', () => { if (preference === 'system') apply(preference); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
  function mount() {
    document.querySelectorAll('[data-theme-control]').forEach((host, index) => {
      const trigger = document.createElement('button');
      trigger.type = 'button'; trigger.className = 'appearance-trigger icon-button';
      trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div'); menu.id = 'portal-appearance-menu-' + index;
      menu.className = 'appearance-menu'; menu.hidden = true;
      menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '选择外观');
      trigger.setAttribute('aria-controls', menu.id);
      const heading = document.createElement('span'); heading.className = 'appearance-heading'; heading.textContent = '外观设置'; menu.append(heading);
      const items = modes.map(mode => {
        const item = document.createElement('button'); item.type = 'button'; item.tabIndex = -1;
        item.setAttribute('role', 'menuitemradio'); item.dataset.appearance = mode;
        item.innerHTML = svg(mode) + '<span>' + labels[mode] + '</span><span class="appearance-check" aria-hidden="true"></span>';
        item.addEventListener('click', () => { apply(mode, true); close(control, true); });
        menu.append(item); return item;
      });
      const control = { host, trigger, menu, items }; controls.push(control);
      const open = () => {
        controls.forEach(other => { if (other !== control) close(other); });
        menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
        items[modes.indexOf(preference)].focus();
      };
      trigger.addEventListener('click', () => menu.hidden ? open() : close(control, true));
      trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
      });
      menu.addEventListener('keydown', event => {
        const current = items.indexOf(document.activeElement);
        let target = null;
        if (event.key === 'ArrowDown') target = (current + 1) % items.length;
        if (event.key === 'ArrowUp') target = (current + items.length - 1) % items.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = items.length - 1;
        if (target !== null) { event.preventDefault(); items[target].focus(); }
        if (event.key === 'Escape') { event.preventDefault(); close(control, true); }
        if (event.key === 'Tab') close(control);
      });
      host.append(trigger, menu);
      host.addEventListener('focusout', event => { if (!host.contains(event.relatedTarget)) close(control); });
    });
    document.addEventListener('pointerdown', event => controls.forEach(control => { if (!control.host.contains(event.target)) close(control); }));
    apply(preference);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
