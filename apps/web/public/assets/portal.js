const actor = document.body.dataset.portal;

if (actor === 'admin') import('./admin-portal.js');
else if (actor === 'customer') import('./customer-portal.js');
else throw new Error(`不支持的门户身份：${actor}`);
