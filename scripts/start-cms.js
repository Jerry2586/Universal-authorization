import { spawn } from 'node:child_process';
import { loadLocalEnvironment } from '../packages/core/src/environment.js';

loadLocalEnvironment();
const role = process.env.APPGOG_ROLE ?? 'all-in-one';
const entry = {
  'all-in-one': 'apps/license-api/src/server.js',
  'license-center': 'apps/license-api/src/server.js',
  'build-center': 'apps/build-center/src/server.js',
  worker: 'apps/build-worker/src/server.js',
}[role];
if (!entry) throw new Error(`APPGOG_ROLE 无效：${role}`);

if (role === 'all-in-one') process.env.EMBEDDED_WORKER ??= 'true';
if (role === 'license-center') process.env.EMBEDDED_WORKER ??= 'false';

const child = spawn(process.execPath, [entry], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
const forward = (signal) => { if (child.exitCode === null) child.kill(signal); };
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
