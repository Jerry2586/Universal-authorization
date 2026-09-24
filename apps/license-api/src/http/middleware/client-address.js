import { isIP } from 'node:net';

function trustedProxyAddress(address) {
  const value = String(address ?? '').toLowerCase().replace(/^::ffff:/, '');
  if (value === '::1' || value === '127.0.0.1' || value.startsWith('10.') || value.startsWith('192.168.')) return true;
  const match = value.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

export function clientAddress(request) {
  const direct = String(request.socket.remoteAddress ?? 'unknown');
  if (!trustedProxyAddress(direct)) return direct;
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return isIP(forwarded) ? forwarded : direct;
}
