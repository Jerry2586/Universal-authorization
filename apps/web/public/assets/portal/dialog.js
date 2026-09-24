import { button, element } from './ui.js';

function closeDialog(overlay) {
  overlay.dataset.closing = '';
  setTimeout(() => overlay.remove(), 220);
}

export function createDialog(title, description, build) {
  const overlay = element('div', null, 'modal-overlay');
  const card = element('div', null, 'modal-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const heading = element('h2', title);
  heading.id = 'dialog-heading';
  card.setAttribute('aria-labelledby', heading.id);
  card.append(heading, element('p', description));
  build(card, () => closeDialog(overlay));
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeDialog(overlay); });
  const onKey = (event) => { if (event.key === 'Escape') { closeDialog(overlay); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('transitionend', () => { if (!overlay.isConnected) document.removeEventListener('keydown', onKey); });
  document.body.append(overlay);
  card.querySelector('input,button,a')?.focus();
  return { card, close: () => closeDialog(overlay) };
}

export function appendDialogActions({ card, close, label, onConfirm, notify, danger = false }) {
  const row = element('div', null, 'dialog-actions');
  row.append(button('取消', close, 'button button-secondary'));
  const confirm = button(label, async () => {
    confirm.disabled = true;
    try { await onConfirm(); close(); } catch (error) { notify(error.message, true); }
    finally { confirm.disabled = false; }
  }, `button ${danger ? 'button-danger' : 'button-primary'}`);
  row.append(confirm);
  card.append(row);
}

export function showSecretDialog({ title, secret, description, downloadHref, notify }) {
  createDialog(title, description, (card, close) => {
    card.append(element('code', secret, 'key-code'));
    const row = element('div', null, 'dialog-actions');
    row.append(button('复制 Key', async () => {
      try { await navigator.clipboard.writeText(secret); notify('已复制到剪贴板'); }
      catch { notify('复制失败，请手动选择并复制', true); }
    }, 'button button-secondary'));
    if (downloadHref) {
      const link = element('a', '下载主题 ZIP →', 'button button-primary');
      link.href = downloadHref;
      row.append(link);
    }
    row.append(button('关闭', close, 'button button-secondary'));
    card.append(row);
  });
}
