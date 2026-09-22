import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

export function ensureSigningKeys(privatePath, publicPath) {
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产签名密钥缺失：禁止自动生成新密钥，否则旧激活凭证将失效');
    }
    mkdirSync(dirname(privatePath), { recursive: true });
    mkdirSync(dirname(publicPath), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
  return {
    privateKey: readFileSync(privatePath, 'utf8'),
    publicKey: readFileSync(publicPath, 'utf8'),
  };
}
