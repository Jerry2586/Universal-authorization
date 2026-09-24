export function createPackagingSqliteRepository(queries) {
  return Object.freeze({
    createTicket(values) {
      queries.insertTicket.run(values.id, values.licenseId, values.tokenHash, values.version, values.domain, values.expiresAt, values.now);
      return values.id;
    },
    ticketByHash: (hash) => queries.ticketByHash.get(hash),
    claimTicket: (id, now) => queries.claimTicket.run(now, id).changes === 1,
    consumeTicket: (id, now) => queries.consumeTicket.run(now, id).changes === 1,
    createBuild(values) {
      queries.insertBuild.run(
        values.id, values.licenseId, values.ticketId, values.version, values.domain,
        values.packageId, values.packageSecretHash, values.artifactSha256 ?? null, values.now,
      );
      return queries.buildById.get(values.id);
    },
    buildById: (id) => queries.buildById.get(id),
    markBuildActivated: (id, now) => queries.markBuildActivated.run(now, id),
    createInstallKey(values) {
      queries.insertInstallKey.run(values.id, values.buildId, values.keyPrefix, values.keyHash, values.expiresAt ?? null, values.now);
    },
    installKeyByHash: (hash) => queries.installKeyByHash.get(hash),
    installKeyByBuildId: (buildId) => queries.installKeyByBuildId.get(buildId),
    consumeInstallKey: (id, now) => queries.consumeInstallKey.run(now, id).changes === 1,
    recentBuildCount: (licenseId, since) => queries.countRecentBuilds.get(licenseId, since).count,
    createBuildJob(values) {
      queries.insertBuildJob.run(
        values.id, values.licenseId, values.sourceVersionId ?? null, values.version, values.domain,
        values.intent ?? 'install', values.baseVersion ?? null, values.sourceKind, values.uploadRef ?? null,
        values.message ?? '等待构建 Worker', values.now, values.now,
      );
      return queries.buildJobById.get(values.id);
    },
    buildJobById: (id) => queries.buildJobById.get(id),
    listBuildJobsByLicense: (licenseId, limit = 50) => queries.listBuildJobsByLicense.all(licenseId, limit),
    listBuildJobs: (limit = 100) => queries.listBuildJobs.all(limit),
    nextQueuedJob: () => queries.nextQueuedJob.get(),
    leaseBuildJob(values) {
      const changed = queries.leaseBuildJob.run(values.message, values.workerId, values.leaseExpiresAt, values.now, values.id).changes;
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    assignBuildToJob(id, workerId, buildId) {
      return queries.assignBuildToJob.run(buildId, id, workerId).changes === 1;
    },
    updateBuildJobProgress(values) {
      return queries.updateBuildJobProgress.run(values.progress, values.message, values.now, values.id, values.workerId).changes === 1;
    },
    completeBuildJob(values) {
      const changed = queries.completeBuildJob.run(
        values.message, values.buildId, values.artifactRef, values.artifactSha256,
        values.installKeyEncrypted, values.now, values.now, values.id, values.workerId,
      ).changes;
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    failBuildJob(values) {
      const job = queries.buildJobById.get(values.id);
      const changed = queries.failBuildJob.run(values.message, values.errorCode, values.now, values.now, values.id, values.workerId).changes;
      if (changed === 1 && job?.build_id) {
        queries.revokeBuild.run(job.build_id);
        queries.revokeInstallKeyByBuild.run(job.build_id);
      }
      return changed === 1 ? queries.buildJobById.get(values.id) : null;
    },
    revokeUnactivatedBuild(buildId) {
      queries.revokeBuild.run(buildId);
      queries.revokeInstallKeyByBuild.run(buildId);
    },
  });
}
