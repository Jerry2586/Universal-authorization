export function createActivationSqliteRepository(queries) {
  return Object.freeze({
    createInstallReceipt(values) {
      queries.insertInstallReceipt.run(
        values.id, values.licenseId, values.buildId, values.receiptSecretHash,
        values.domain, values.backendOrigin, values.installationId, values.generation, values.now,
      );
      return queries.installReceiptById.get(values.id);
    },
    installReceiptById: (id) => queries.installReceiptById.get(id),
    activateInstallReceipt: (id, now) => queries.activateInstallReceipt.run(now, id).changes === 1,
    markBuildUnlocked: (id) => queries.markBuildUnlocked.run(id).changes === 1,
    supersedeActivations: (licenseId, domain, backendOrigin, installationId, now) => (
      queries.supersedeActivations.run(now, licenseId, domain, backendOrigin, installationId)
    ),
    fenceActivationsByInstallation: (licenseId, installationId, now) => (
      queries.fenceActivationsByInstallation.run(now, licenseId, installationId).changes
    ),
    createActivation(values) {
      queries.insertActivation.run(
        values.id, values.licenseId, values.buildId, values.domain, values.backendOrigin,
        values.installationId, values.generation, values.refreshSecretHash, values.now, values.now,
        values.identityMode ?? 'legacy', values.installationPublicKeyFingerprint ?? null,
      );
      return queries.activationById.get(values.id);
    },
    activationById: (id) => queries.activationById.get(id),
    updateActivationSeen: (id, now) => queries.updateActivationSeen.run(now, id),
    activeActivationForEnvironment: (licenseId, domain, backendOrigin, installationId) => (
      queries.activeActivationForEnvironment.get(licenseId, domain, backendOrigin, installationId)
    ),
    countActiveActivationsForLicense: (licenseId) => queries.countActiveActivationsForLicense.get(licenseId).count,
    createInstallationChallenge(values) {
      queries.insertInstallationChallenge.run(
        values.id, values.purpose, values.installationId, values.publicKeyFingerprint,
        values.contextHash, values.nonce, values.expiresAt, values.now,
      );
      return queries.installationChallengeById.get(values.id);
    },
    installationChallengeById: (id) => queries.installationChallengeById.get(id),
    consumeInstallationChallenge(id, now) {
      return queries.consumeInstallationChallenge.run(now, id, now).changes === 1;
    },
    registerInstallationIdentity(values) {
      queries.upsertInstallationIdentity.run(
        values.installationId, values.licenseId, values.publicKeyPem, values.publicKeyFingerprint,
        values.status ?? 'active', values.now, values.now,
      );
      return queries.installationIdentityById.get(values.installationId);
    },
    installationIdentityById: (id) => queries.installationIdentityById.get(id),
    touchInstallationIdentity: (id, now) => queries.touchInstallationIdentity.run(now, id).changes === 1,
    fenceInstallationIdentity: (id, now) => queries.fenceInstallationIdentity.run(now, id).changes === 1,
    activateInstallationIdentity: (id, now) => queries.activateInstallationIdentity.run(now, id).changes === 1,
    createProductMigrationGrant(values) {
      queries.insertProductMigrationGrant.run(
        values.id, values.licenseId, values.sourceInstallationId, values.targetPublicKeyFingerprint,
        values.tokenHash, values.expiresAt, values.rollbackUntil, values.now,
      );
      return values.id;
    },
    productMigrationGrantByHash: (hash) => queries.productMigrationGrantByHash.get(hash),
    consumeProductMigrationGrant(id, now) {
      return queries.consumeProductMigrationGrant.run(now, id, now).changes === 1;
    },
    revokeInstallReceiptsByLicense: (licenseId, now) => queries.revokeInstallReceiptsByLicense.run(now, licenseId).changes,
    revokeActivationsByLicense: (licenseId, now) => queries.revokeActivationsByLicense.run(now, licenseId).changes,
    listActivations: (limit = 100) => queries.listActivations.all(limit),
    activeActivationByLicense: (licenseId) => queries.activeActivationByLicense.get(licenseId),
    activeActivationByInstallation: (licenseId, installationId) => queries.activeActivationByInstallation.get(licenseId, installationId),
  });
}
