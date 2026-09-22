export class BuildEngine {
  async build(_request) {
    throw new Error('BuildEngine.build must be implemented');
  }
}
