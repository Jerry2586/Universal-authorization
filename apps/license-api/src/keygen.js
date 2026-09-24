import { loadConfig } from './config.js';
import { ensureSigningKeyring } from './key-store.js';

const config = loadConfig();
ensureSigningKeyring(config);
console.log(`Ed25519 密钥已准备：${config.activationPublicKeyPath} / ${config.packagePublicKeyPath} / ${config.notificationPublicKeyPath}`);
