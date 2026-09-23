import { invariant } from '../../core/src/errors.js';
import { verifyActivation } from './verifier.js';

function bearerToken(headers = {}) {
  const value = headers.authorization ?? headers.Authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

export function requireActivation({
  token,
  headers,
  publicKey,
  product = 'appgog',
  domain,
  backendUrl,
  installationId,
  buildId,
  packageId,
  capability,
  now = new Date(),
  allowOffline = false,
}) {
  const activationToken = token ?? bearerToken(headers);
  invariant(activationToken, 'APPGOG_NOT_ACTIVATED', 'APPGOG 尚未正式激活', 401);
  const payload = verifyActivation({
    token: activationToken, publicKey, product, domain, backendUrl,
    installationId, buildId, packageId, now, allowOffline,
  });
  if (capability) {
    invariant(Array.isArray(payload.capabilities) && payload.capabilities.includes(capability),
      'APPGOG_CAPABILITY_DENIED', '当前授权不允许执行此操作', 403);
  }
  return payload;
}

export function activationGuard(options) {
  return (request = {}) => requireActivation({ ...options, headers: request.headers, token: request.activationToken });
}
