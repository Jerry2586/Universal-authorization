import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

console.log('# 把下一行复制到 .env；只用于本地开发，禁止发送给客户端或提交到代码仓库。');
console.log(`LICENSE_SIGNING_PRIVATE_KEY_PEM_BASE64=${Buffer.from(privatePem, 'utf8').toString('base64')}`);
console.log('\n# 客户端用于验签的公钥（可以公开）：');
console.log(publicPem);
