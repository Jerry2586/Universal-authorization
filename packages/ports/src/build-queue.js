export class BuildQueue {
  enqueue(_job) {
    throw new Error('BuildQueue.enqueue must be implemented');
  }

  leaseNext(_workerId, _leaseSeconds) {
    throw new Error('BuildQueue.leaseNext must be implemented');
  }

  complete(_jobId, _result) {
    throw new Error('BuildQueue.complete must be implemented');
  }

  fail(_jobId, _error) {
    throw new Error('BuildQueue.fail must be implemented');
  }
}
