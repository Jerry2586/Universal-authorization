import { createServer } from 'node:http';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createHttpHandler } from './http.js';
import { ensureSigningKeyring } from './key-store.js';
import { startEmbeddedWorker } from '../../build-worker/src/embedded-worker.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
const keyring = ensureSigningKeyring(config);
const { service, sessions, portal, updates, migrations, artifactStore, buildEngine } = bootstrap({ database, config, keyring });
const publicKeys = {
  activation: keyring.activation.publicKey,
  package: keyring.package.publicKey,
  notification: keyring.notification.publicKey,
};
const server = createServer(createHttpHandler({
  service, sessions, portal, updates, migrations, artifactStore, config, publicKeys, publicKey: publicKeys.activation,
}));
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
