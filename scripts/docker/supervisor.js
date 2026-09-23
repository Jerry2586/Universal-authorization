import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// All children share one container lifetime: a failed child must not leave a half-working service.
export function supervise({ specs, cwd, env = {}, probe = async () => {}, log = console.log, shutdownMs = 20000, monitorMs = 10000 }) {
  const children = [];
  let stopping = false, exitCode = 0, timer, monitor, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const ended = new WeakSet();
  const alive = child => !ended.has(child) && child.exitCode === null && child.signalCode === null;
  function finish() {
    if (stopping && children.every(child => !alive(child))) {
      clearTimeout(timer); clearInterval(monitor); resolveDone(exitCode);
    }
  }
  function stop(code = 0) {
    if (stopping) return;
    stopping = true; exitCode = code; clearInterval(monitor);
    for (const child of children) if (alive(child)) child.kill('SIGTERM');
    timer = setTimeout(() => {
      for (const child of children) if (alive(child)) child.kill('SIGKILL');
    }, shutdownMs);
    timer.unref(); finish();
  }
  const ready = (async () => {
    for (const spec of specs) {
      if (stopping) throw new Error('startup interrupted');
      const child = spawn(spec.command, spec.args, { cwd, env: { ...env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', line => log('[' + spec.name + '] ' + line));
      }
      child.once('error', error => {
        if (!child.pid) ended.add(child);
        log('[' + spec.name + '] ' + error.message); stop(1); finish();
      });
      child.once('exit', (code, signal) => {
        ended.add(child);
        if (!stopping) { log('[' + spec.name + '] exited: ' + (signal || code)); stop(1); }
        finish();
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      if (spec.ready) await spec.ready(() => stopping);
    }
    if (stopping) throw new Error('startup interrupted');
    let checking = false, failures = 0;
    monitor = setInterval(async () => {
      if (checking || stopping) return;
      checking = true;
      try { await probe(); failures = 0; }
      catch (error) { log('[health] ' + error.message); if (++failures >= 3) stop(1); }
      finally { checking = false; }
    }, monitorMs);
    return children;
  })();
  ready.catch(error => { log('[supervisor] ' + error.message); stop(1); });
  return { ready, done, stop, children };
}
