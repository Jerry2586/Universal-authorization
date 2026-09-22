import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { invariant } from './errors.js';

export function canonicalizeDomain(input) {
  invariant(typeof input === 'string' && input.trim(), 'DOMAIN_REQUIRED', '必须提供授权域名');
  let host = input.trim().toLowerCase();
  if (host.includes('://')) {
    host = new URL(host).hostname;
  } else {
    host = host.split('/')[0].split(':')[0];
  }
  host = domainToASCII(host.replace(/^\.+|\.+$/g, ''));
  invariant(host && (isIP(host) || host.includes('.')), 'DOMAIN_INVALID', '授权域名格式无效');
  return host;
}

export function canonicalizeBackendOrigin(input) {
  invariant(typeof input === 'string' && input.trim(), 'BACKEND_URL_REQUIRED', '必须提供 Xboard 后台地址');
  const url = new URL(input.trim());
  invariant(['http:', 'https:'].includes(url.protocol), 'BACKEND_URL_INVALID', '后台地址只允许 HTTP 或 HTTPS');
  invariant(!url.username && !url.password, 'BACKEND_URL_INVALID', '后台地址不能包含账号密码');
  invariant(url.pathname === '/' || url.pathname === '', 'BACKEND_URL_INVALID', '后台地址只能填写站点根地址');
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin.toLowerCase();
}

export function assertDomainMatches(licensedDomain, currentDomain) {
  invariant(
    canonicalizeDomain(licensedDomain) === canonicalizeDomain(currentDomain),
    'DOMAIN_MISMATCH',
    '当前域名与授权绑定域名不一致',
    403,
  );
}
