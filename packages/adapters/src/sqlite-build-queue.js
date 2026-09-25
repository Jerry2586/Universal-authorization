import { BUILD_JOB_STATUS } from '../../contracts/src/build-job.js';
import { BuildQueue } from '../../ports/src/build-queue.js';

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteBuildQueue extends BuildQueue {
  constructor({ database, repository, clock = () => new Date() }) {
    super();
    this.database = database;
    this.repository = repository;
    this.clock = clock;
  }

  enqueue(job) {
    return this.repository.createBuildJob(job);
  }

  leaseNext(workerId, leaseSeconds = 300) {
    return transaction(this.database, () => {
      const candidate = this.repository.nextQueuedJob();
      if (!candidate) return null;
      const now = this.clock();
      return this.repository.leaseBuildJob({
        id: candidate.id,
        workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
        message: 'Worker 已领取，准备构建',
        now: now.toISOString(),
      });
    });
  }

  progress(jobId, workerId, progress, message) {
    return this.repository.updateBuildJobProgress({
      id: jobId,
      workerId,
      progress: Math.max(5, Math.min(95, Number(progress) || 5)),
      message,
      now: this.clock().toISOString(),
    });
  }

  complete(jobId, result) {
    return this.repository.completeBuildJob({
      id: jobId,
      workerId: result.workerId,
      buildId: result.buildId,
      artifactRef: result.artifactRef,
      artifactSha256: result.artifactSha256,
      installKeyEncrypted: result.installKeyEncrypted,
      message: result.message ?? '构建完成，可以下载安装',
      now: this.clock().toISOString(),
    });
  }

  fail(jobId, error) {
    return transaction(this.database, () => this.repository.failBuildJob({
      id: jobId,
      workerId: error.workerId,
      errorCode: error.code ?? 'BUILD_FAILED',
      message: error.message ?? '构建失败',
      now: this.clock().toISOString(),
    }));
  }
}

export function isTerminalBuildJob(job) {
  return [BUILD_JOB_STATUS.SUCCEEDED, BUILD_JOB_STATUS.FAILED, BUILD_JOB_STATUS.CANCELLED].includes(job.status);
}
