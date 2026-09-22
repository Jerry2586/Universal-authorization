import { createServer } from 'node:http';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createHttpHandler } from './http.js';
import { ensureSigningKeys } from './key-store.js';
import { startEmbeddedWorker } from '../../build-worker/src/embedded-worker.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
const { privateKey, publicKey } = ensureSigningKeys(config.privateKeyPath, config.publicKeyPath);
const { service, sessions, portal, artifactStore, buildEngine } = bootstrap({ database, config, privateKey, publicKey });
const server = createServer(createHttpHandler({ service, sessions, portal, artifactStore, config, publicKey }));
const embeddedWorker = config.surface === 'combined' && config.embeddedWorker
  ? startEmbeddedWorker({ portal, buildEngine, artifactStore })
  : null;

server.listen(config.port, () => {
  console.log(`APPGOG License Center (${config.surface}) listening on port ${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  embeddedWorker?.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
