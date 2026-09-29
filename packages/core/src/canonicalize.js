import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { invariant } from './errors.js';

export function canonicalizeDomain(input) {
  invariant(typeof input === 'string' && input.trim(), 'DOMAIN_REQUIRED', '必须提供授权域名');
  const value = input.trim();
  let url;
  try {
    url = value.includes('://') ? new URL(value) : new URL(`http://${value.split(/[/?#]/, 1)[0]}`);
  } catch {
    invariant(false, 'DOMAIN_INVALID', '授权域名格式无效');
  }
  invariant(['http:', 'https:'].includes(url.protocol), 'DOMAIN_INVALID', '授权域名只允许 HTTP 或 HTTPS 地址');
  invariant(!url.username && !url.password, 'DOMAIN_INVALID', '授权域名不能包含账号密码');
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/^\.+|\.+$/g, '');
  const validIp = isIP(host) !== 0;
  if (!validIp) host = domainToASCII(host);
  if (!validIp && host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4);
  const labels = host.split('.');
  const validHostname = host.length <= 253 && host.includes('.') && labels.every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  invariant(host && (validIp || validHostname), 'DOMAIN_INVALID', '授权域名格式无效');
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
