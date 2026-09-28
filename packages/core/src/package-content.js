import { createHash } from 'node:crypto';
import { stableJson } from './encoding.js';
import { invariant } from './errors.js';
import { verifyCompactToken } from './signing.js';

// Signed after the final files are assembled. Only the signature itself is excluded.
// The separate package-manifest token declares that this seal is mandatory for new builds.
export function packageContentDigest(manifest) {
  const { content_signature, ...content } = manifest;
  return createHash('sha256').update(stableJson(content)).digest('hex');
}

export function packageContentClaims(manifest, issuer) {
  return {
    typ: 'package-content-v1', iss: issuer,
    build_id: manifest.build_id, package_id: manifest.package_id,
    content_sha256: packageContentDigest(manifest),
  };
}

export function verifyPackageContent(manifest, publicKey, issuer) {
  invariant(typeof manifest.content_signature === 'string', 'PACKAGE_CONTENT_SIGNATURE_MISSING', '安装包缺少授权中心内容签名', 409);
  const signed = verifyCompactToken(manifest.content_signature, publicKey);
  const expected = packageContentClaims(manifest, issuer);
  invariant(Object.entries(expected).every(([key, value]) => signed[key] === value),
    'PACKAGE_CONTENT_SIGNATURE_INVALID', '安装包文件清单或保护信息已被修改', 409);
  return signed;
}
