import { newId } from '../../../../packages/core/src/identifiers.js';

export function createErasureSqliteRepository(queries) {
  return Object.freeze({
    beginLicenseErasure({ id = newId('ers'), licenseId, requestedBy, now }) {
      const fileRefs = queries.licenseFileRefs.all(licenseId, licenseId, licenseId)
        .map((row) => row.storage_ref)
        .filter(Boolean);
      queries.markLicenseDeleting.run(now, licenseId);
      queries.insertErasureJob.run(id, licenseId, requestedBy, JSON.stringify([...new Set(fileRefs)]), now);
      return queries.erasureJobById.get(id);
    },
    erasureJobByLicense: (licenseId) => queries.erasureJobByLicense.get(licenseId),
    listPendingErasureJobs: () => queries.listPendingErasureJobs.all(),
    updateErasureJob(id, status, errorMessage = null, completedAt = null) {
      queries.updateErasureJob.run(status, errorMessage, completedAt, id);
      return queries.erasureJobById.get(id);
    },
    listPendingCleanupTasks: (limit = 100) => queries.listPendingCleanupTasks.all(limit),
    completeCleanupTask(id, now) {
      return queries.completeCleanupTask.run(now, now, id).changes === 1;
    },
    failCleanupTask(id, errorMessage, now) {
      return queries.failCleanupTask.run(errorMessage, now, id).changes === 1;
    },
    pendingCleanupCount(operationId) {
      return queries.countPendingCleanupTasks.get(operationId).count;
    },
    completeErasureCleanup(operationId) {
      return queries.completeErasureCleanup.run(operationId, operationId).changes === 1;
    },
    deleteLicenseGraph(licenseId) {
      let recordsDeleted = 0;
      const deletions = [
        queries.deleteCustomerSessionsByLicense,
        queries.deleteSupportAttachmentsByLicense,
        queries.deleteSupportMessagesByLicense,
        queries.deleteSupportTicketsByLicense,
        queries.deleteOfflineLicenseFilesByLicense,
        queries.deleteProductMigrationGrantsByLicense,
        queries.deleteActivationsByLicense,
        queries.deleteInstallationChallengesByLicense,
        queries.deleteInstallationIdentitiesByLicense,
        queries.deleteInstallReceiptsByLicense,
        queries.deleteInstallKeysByLicense,
        queries.deleteInstallWindowsByLicense,
        queries.deleteBuildJobsByLicense,
        queries.deleteBuildsByLicense,
        queries.deleteBuildTicketsByLicense,
        queries.deleteDomainMigrationsByLicense,
        queries.deleteLicenseEventsByLicense,
      ];
      for (const statement of deletions) recordsDeleted += statement.run(licenseId).changes;
      recordsDeleted += queries.deleteAuditByLicense.run(licenseId, licenseId).changes;
      recordsDeleted += queries.deleteLicense.run(licenseId).changes;
      return recordsDeleted;
    },
    finishLicenseErasure({ operationId, executionVersion, recordsDeleted, filesDeleted, failedFiles = [], now }) {
      for (const failure of failedFiles) {
        queries.insertCleanupTask.run(newId('fct'), operationId, failure.storageRef, failure.error, now, now);
      }
      queries.insertErasureTombstone.run(
        newId('tmb'), operationId, now, executionVersion, recordsDeleted, filesDeleted,
        failedFiles.length > 0 ? 'completed_with_cleanup_pending' : 'completed',
      );
      queries.deleteErasureJob.run(operationId);
    },
  });
}
