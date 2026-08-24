export const ADMIN_SESSION_COOKIE = 'ua_admin_session';

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export function sessionCookie(value: string, options: { secure: boolean; maxAge: number }): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/admin',
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAge: 0 });
}
