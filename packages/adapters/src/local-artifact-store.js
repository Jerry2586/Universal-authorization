import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { ArtifactStore } from '../../ports/src/artifact-store.js';
import { invariant } from '../../core/src/errors.js';

export class LocalArtifactStore extends ArtifactStore {
  constructor(root) {
    super();
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  pathFor(key) {
    const path = resolve(this.root, key);
    invariant(path === this.root || path.startsWith(`${this.root}${sep}`), 'ARTIFACT_PATH_INVALID', '文件存储路径无效', 400);
    return path;
  }

  put(key, content) {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return key;
  }

  open(key) {
    return createReadStream(this.pathFor(key));
  }

  read(key) {
    return readFileSync(this.pathFor(key));
  }

  size(key) {
    return statSync(this.pathFor(key)).size;
  }

  remove(key) {
    rmSync(this.pathFor(key), { force: true });
  }
}
