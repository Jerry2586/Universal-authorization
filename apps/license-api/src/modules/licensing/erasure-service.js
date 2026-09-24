import { invariant } from '../../../../../packages/core/src/errors.js';
import { transaction } from '../../database.js';

export function createLicenseErasureService({
  database, repository, artifactStore, clock = () => new Date(), packageVersion = 'development',
}) {
  function processCleanupTasks(limit = 100) {
    const tasks = repository.listPendingCleanupTasks(limit);
    const operations = new Set();
    let completed = 0;
    let failed = 0;
    for (const task of tasks) {
      operations.add(task.operation_id);
      const now = clock().toISOString();
      try {
        artifactStore.remove(task.storage_ref);
        if (repository.completeCleanupTask(task.id, now)) completed += 1;
      } catch (error) {
        repository.failCleanupTask(task.id, String(error?.message ?? error).slice(0, 1000), now);
        failed += 1;
      }
    }
    for (const operationId of operations) {
      if (repository.pendingCleanupCount(operationId) === 0) repository.completeErasureCleanup(operationId);
    }
    return { processed: tasks.length, completed, failed, pending: Math.max(0, tasks.length - completed) };
  }

  function processErasureJob(job) {
    let refs = [];
    try { refs = JSON.parse(job.file_refs_json ?? '[]'); } catch { refs = []; }
    const failedFiles = [];
    let filesDeleted = 0;
    for (const storageRef of [...new Set(Array.isArray(refs) ? refs : [])]) {
      try {
        artifactStore.remove(storageRef);
        filesDeleted += 1;
      } catch (error) {
        failedFiles.push({ storageRef, error: String(error?.message ?? error).slice(0, 1000) });
      }
    }
    const now = clock().toISOString();
    const recordsDeleted = transaction(database, () => {
      const deleted = repository.deleteLicenseGraph(job.license_id);
      repository.finishLicenseErasure({
        operationId: job.id, executionVersion: packageVersion, recordsDeleted: deleted,
        filesDeleted, failedFiles, now,
      });
      return deleted;
    });
    return {
      operation_id: job.id, deleted: true, records_deleted: recordsDeleted,
      files_deleted: filesDeleted, cleanup_pending: failedFiles.length,
    };
  }

  return Object.freeze({
    deleteLicensePermanently({ licenseId, actorId }) {
      const license = repository.licenseById(licenseId);
      invariant(license, 'LICENSE_NOT_FOUND', '授权不存在', 404);
      invariant(!repository.erasureJobByLicense(licenseId), 'LICENSE_ERASURE_RUNNING', '授权正在永久删除', 409);
      const job = transaction(database, () => repository.beginLicenseErasure({
        licenseId, requestedBy: actorId, now: clock().toISOString(),
      }));
      return processErasureJob(job);
    },

    resumePendingErasures() {
      const erasures = [];
      for (const job of repository.listPendingErasureJobs()) {
        try { erasures.push(processErasureJob(job)); } catch (error) {
          repository.updateErasureJob(job.id, 'files_pending', String(error?.message ?? error).slice(0, 2000));
        }
      }
      return { erasures, cleanup: processCleanupTasks() };
    },

    retryPendingErasureCleanup() {
      return processCleanupTasks();
    },
  });
}
