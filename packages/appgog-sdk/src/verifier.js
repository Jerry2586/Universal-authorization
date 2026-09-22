import { canonicalizeBackendOrigin, canonicalizeDomain } from '../../core/src/canonicalize.js';
import { invariant } from '../../core/src/errors.js';
import { verifyCompactToken } from '../../core/src/signing.js';

export function verifyActivation({ token, publicKey, product = 'appgog', domain, backendUrl, installationId, buildId, packageId, now = new Date(), allowOffline = false }) {
  const payload = verifyCompactToken(token, publicKey);
  invariant(payload.typ === 'activation', 'TOKEN_TYPE_INVALID', '不是 APPGOG 激活凭证', 401);
  invariant(payload.product === product, 'PRODUCT_MISMATCH', '激活凭证不属于当前产品', 403);
  invariant(payload.domain === canonicalizeDomain(domain), 'DOMAIN_MISMATCH', '当前域名与激活凭证不一致', 403);
  invariant(payload.backend_origin === canonicalizeBackendOrigin(backendUrl), 'BACKEND_MISMATCH', 'Xboard 后台地址与激活凭证不一致', 403);
  invariant(payload.installation_id === installationId, 'INSTALLATION_MISMATCH', '当前安装环境与激活凭证不一致', 403);
  if (buildId !== undefined) invariant(payload.build_id === buildId, 'BUILD_MISMATCH', '激活凭证不属于当前构建', 403);
  if (packageId !== undefined) invariant(payload.package_id === packageId, 'PACKAGE_MISMATCH', '激活凭证不属于当前安装包', 403);
  const seconds = Math.floor(now.getTime() / 1000);
  invariant(Number.isSafeInteger(payload.exp) && payload.exp > 0, 'TOKEN_INVALID', '激活凭证有效期无效', 401);
  const offlineValid = allowOffline && Number.isSafeInteger(payload.offline_until)
    && payload.offline_until >= payload.exp && payload.offline_until > seconds;
  invariant(payload.exp > seconds || offlineValid, 'TOKEN_EXPIRED', '激活凭证与离线宽限期均已结束，需要联网刷新', 401);
  return payload;
}
