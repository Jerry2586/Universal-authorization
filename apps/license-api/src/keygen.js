import { loadConfig } from './config.js';
import { ensureSigningKeys } from './key-store.js';

const config = loadConfig();
ensureSigningKeys(config.privateKeyPath, config.publicKeyPath);
console.log(`Ed25519 密钥已准备：${config.publicKeyPath}`);
