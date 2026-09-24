import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

export function ensureSigningKeys(privatePath, publicPath, { allowCreateInProduction = false, label = 'Activation' } = {}) {
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    if (process.env.NODE_ENV === 'production' && !allowCreateInProduction) {
      throw new Error(`生产 ${label} 签名密钥缺失：禁止自动生成新密钥，否则既有凭证将失效`);
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

export function ensureSigningKeyring(config) {
  const activation = ensureSigningKeys(
    config.activationPrivateKeyPath ?? config.privateKeyPath,
    config.activationPublicKeyPath ?? config.publicKeyPath,
    { label: 'Activation' },
  );
  const packageKeys = ensureSigningKeys(
    config.packagePrivateKeyPath,
    config.packagePublicKeyPath,
    { allowCreateInProduction: true, label: 'Package' },
  );
  const notification = ensureSigningKeys(
    config.notificationPrivateKeyPath,
    config.notificationPublicKeyPath,
    { allowCreateInProduction: true, label: 'Notification' },
  );
  return { activation, package: packageKeys, notification };
}
