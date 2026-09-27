import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeFromSignedRelease } from './bridge-release-source.js';
import { invariant } from '../../core/src/errors.js';

import { compareBridgeVersion } from '../../core/src/bridge-version.js';

/** Fixed private component directory. Store signed evidence, never execute downloaded code. */
export function createBridgeDistribution({ root, bundled, publicKey }) {
  const directory = join(root, 'bridge-distribution');
  const active = join(directory, 'active.json');
  const recovery = join(directory, 'active.recovery.json');
  const baseline = bundled();
  let cached = null;
  function pointerAt(path) {
    const pointer = JSON.parse(readFileSync(path, 'utf8'));
    invariant(/^\d+\.\d+\.\d+$/.test(pointer.version) && /^\d+\.\d+\.\d+$/.test(pointer.release_version)
      && /^[a-f0-9-]{36}$/.test(pointer.id), 'BRIDGE_COMPONENT_INVALID', '授权桥组件索引无效', 503);
    return pointer;
  }
  function selection() {
    if (!existsSync(active) && !existsSync(recovery)) return { version: baseline.version, release_version: baseline.release_version, bundled: true };
    let pointer;
    try { pointer = pointerAt(active); }
    catch {
      try { pointer = { ...pointerAt(recovery), recovery: true }; }
      catch { invariant(false, 'BRIDGE_COMPONENT_INVALID', '授权桥组件索引损坏，请从备份恢复组件目录', 503); }
    }
    const relation = compareBridgeVersion(baseline.version, pointer.version);
    return relation > 0 || relation === 0 && compareBridgeVersion(baseline.release_version, pointer.release_version) > 0
      ? { version: baseline.version, release_version: baseline.release_version, bundled: true } : pointer;
  }
  function atomicPointer(path, value) {
    const temporary = join(directory, randomUUID() + '.json');
    writeFileSync(temporary, value, { mode: 0o600 });
    renameSync(temporary, path);
  }
  function snapshot() {
    const selected = selection();
    if (selected.bundled) return bundled();
    invariant(!selected.recovery, 'BRIDGE_COMPONENT_INVALID', '授权桥组件索引需要修复，已找到恢复记录', 503);
    try {
      const folder = join(directory, selected.id);
      const names = ['manifest.json', 'manifest.sig', 'platform.zip'];
      const fingerprint = JSON.stringify([selected.id, ...names.map(name => {
        const stat = statSync(join(folder, name), { bigint: true });
        invariant(stat.isFile() && stat.size <= 64n * 1024n * 1024n, 'BRIDGE_COMPONENT_INVALID', '授权桥文件无效', 503);
        return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
      })]);
      if (cached?.fingerprint === fingerprint) return { ...cached.snapshot, buffer: Buffer.from(cached.snapshot.buffer) };
      const artifact = bridgeFromSignedRelease(readFileSync(join(folder, 'manifest.json')), readFileSync(join(folder, 'manifest.sig')),
        readFileSync(join(folder, 'platform.zip')), { publicKey, version: selected.release_version });
      invariant(artifact.version === selected.version, 'BRIDGE_COMPONENT_INVALID', '授权桥组件版本不一致', 503);
      const snapshot = { version: artifact.version, release_version: artifact.release_version, descriptor: Object.freeze(artifact.descriptor), buffer: artifact.buffer };
      cached = { fingerprint, snapshot };
      return { ...snapshot, buffer: Buffer.from(snapshot.buffer) };
    } catch { invariant(false, 'BRIDGE_COMPONENT_INVALID', '授权桥组件校验失败，请修复后再打包', 503); }
  }
  function install(candidate, { repair = false } = {}) {
    const current = selection();
    const proof = candidate.evidence;
    invariant(proof, 'BRIDGE_COMPONENT_UNSIGNED', '授权桥缺少正式签名证据', 503);
    const verified = bridgeFromSignedRelease(proof.manifest, proof.signature, proof.zip, { publicKey, version: candidate.release_version });
    invariant(verified.version === candidate.version, 'BRIDGE_COMPONENT_INVALID', '授权桥组件版本不一致', 503);
    invariant(repair ? verified.version === current.version && verified.release_version === current.release_version
      : compareBridgeVersion(verified.version, current.version) > 0 && compareBridgeVersion(verified.release_version, current.release_version) >= 0,
      'BRIDGE_COMPONENT_DOWNGRADE', '授权桥版本已变化或尝试降级，请重新检查', 409);
    const id = randomUUID(), folder = join(directory, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'manifest.json'), proof.manifest, { mode: 0o600 });
    writeFileSync(join(folder, 'manifest.sig'), proof.signature, { mode: 0o600 });
    writeFileSync(join(folder, 'platform.zip'), proof.zip, { mode: 0o600 });
    // Read persisted bytes before selecting them; a failed write leaves the healthy pointer untouched.
    bridgeFromSignedRelease(readFileSync(join(folder, 'manifest.json')), readFileSync(join(folder, 'manifest.sig')),
      readFileSync(join(folder, 'platform.zip')), { publicKey, version: verified.release_version });
    const pointer = JSON.stringify({ id, version: verified.version, release_version: verified.release_version });
    const previous = existsSync(active) ? readFileSync(active) : null;
    const previousRecovery = existsSync(recovery) ? readFileSync(recovery) : null;
    atomicPointer(recovery, pointer);
    try { atomicPointer(active, pointer); return snapshot(); }
    catch (error) {
      // Preserve explicit repair metadata even when there was no managed component before.
      if (previous) atomicPointer(active, previous); else rmSync(active, { force: true });
      if (previousRecovery) atomicPointer(recovery, previousRecovery); else rmSync(recovery, { force: true });
      throw error;
    }

  }
  return { snapshot, selection, install };
}
