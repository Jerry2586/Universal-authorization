import { createHash } from 'node:crypto';
import { readZip } from './zip.js';
import { invariant } from './errors.js';
import { signCompactToken, verifyCompactToken } from './signing.js';
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
export function signBridgeDelivery(snapshot, buildId, issuer, privateKey, now = Date.now()) {
  return { buffer: snapshot.buffer.toString('base64'), token: signCompactToken({
    typ: 'bridge-delivery', iss: issuer, build_id: buildId, version: snapshot.version,
    sha256: digest(snapshot.buffer), exp: Math.floor(now / 1000) + 3600,
  }, privateKey) };
}
export function verifyBridgeDelivery(delivery, buildId, issuer, publicKey, now = Date.now()) {
  invariant(delivery && typeof delivery.buffer === 'string' && delivery.buffer.length <= 14 * 1024 * 1024,
    'BRIDGE_DELIVERY_REQUIRED', '构建任务缺少有效授权桥组件，请更新中心后重试', 503);
  const payload = verifyCompactToken(delivery.token, publicKey);
  const buffer = Buffer.from(delivery.buffer, 'base64');
  invariant(payload.typ === 'bridge-delivery' && payload.iss === issuer && payload.build_id === buildId
    && Number.isFinite(payload.exp) && payload.exp > now / 1000 && payload.exp <= now / 1000 + 3600
    && payload.sha256 === digest(buffer), 'BRIDGE_DELIVERY_INVALID', '授权桥任务签名、身份或有效期不匹配', 503);
  const files = readZip(buffer, { maxEntries: 300, maxSingleFileBytes: 5 * 1024 * 1024, maxUncompressedBytes: 30 * 1024 * 1024 });
  let descriptor;
  try { descriptor = JSON.parse(files.get('AppgogLicenseBridge/config.json')); } catch {}
  invariant(descriptor?.code === 'appgog_license_bridge' && descriptor.version === payload.version
    && files.has('AppgogLicenseBridge/Plugin.php'), 'BRIDGE_DELIVERY_INVALID', '授权桥组件格式无效', 503);
  return { buffer, descriptor, version: descriptor.version };
}
