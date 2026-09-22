export class ArtifactStore {
  put(_key, _content) {
    throw new Error('ArtifactStore.put must be implemented');
  }

  read(_key) {
    throw new Error('ArtifactStore.read must be implemented');
  }

  open(_key) {
    throw new Error('ArtifactStore.open must be implemented');
  }

  remove(_key) {
    throw new Error('ArtifactStore.remove must be implemented');
  }
}
