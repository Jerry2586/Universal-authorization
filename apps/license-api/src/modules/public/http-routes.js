import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handlePublicHttp({
  method, url, response, portal, service, publicKey, publicKeys, packageVersion, respondJson, corsHeaders,
}) {
  if (method === 'GET' && url.pathname === '/health') {
    respondJson(response, 200, {
      ok: true, service: 'appgog-license-api', version: packageVersion, ...portal.healthStatus(),
    });
    return true;
  }

  if (method === 'GET' && url.pathname === '/api/v1/public-key') {
    const resolvedKeys = publicKeys ?? { activation: publicKey, package: publicKey, notification: publicKey };
    respondJson(response, 200, {
      algorithm: 'Ed25519', public_key: resolvedKeys.activation, public_keys: resolvedKeys,
    });
    return true;
  }

  if (method === 'GET' && url.pathname === '/web/branding') {
    respondJson(response, 200, portal.branding());
    return true;
  }

  if (method === 'GET' && url.pathname === '/api/v1/releases/latest') {
    const product = url.searchParams.get('product') ?? 'appgog';
    invariant(product === 'appgog', 'PRODUCT_NOT_FOUND', '产品不存在', 404);
    respondJson(response, 200, service.releaseAnnouncement(product), corsHeaders);
    return true;
  }

  return false;
}
