import { newId } from '../../../../packages/core/src/identifiers.js';

export function createOperationsSqliteRepository(queries) {
  return Object.freeze({
    dashboardStats(since) {
      return {
        licenses: queries.countLicenses.get().count,
        activeLicenses: queries.countActiveLicenses.get().count,
        buildsToday: queries.countBuildJobsToday.get(since).count,
        activationsToday: queries.countActivationsToday.get(since).count,
        activeActivations: queries.countActiveActivations.get().count,
        queuedJobs: queries.countQueuedJobs.get().count,
      };
    },
    setting(key) {
      const record = queries.settingByKey.get(key);
      return record ? record.value : null;
    },
    listSettings() {
      return Object.fromEntries(queries.listSettings.all().map((record) => [record.key, record.value]));
    },
    setSetting(key, value, now) {
      queries.upsertSetting.run(key, String(value), now);
      return queries.settingByKey.get(key);
    },
    createServiceNode(values) {
      const id = values.id ?? newId('nod');
      queries.insertServiceNode.run(
        id, values.name, values.role, values.publicUrl ?? null, values.credentialPrefix,
        values.credentialHash, JSON.stringify(values.capabilities ?? []), values.now, values.now,
      );
      return queries.serviceNodeById.get(id);
    },
    serviceNodeById: (id) => queries.serviceNodeById.get(id),
    serviceNodeByCredentialHash: (hash) => queries.serviceNodeByCredentialHash.get(hash),
    listServiceNodes: () => queries.listServiceNodes.all(),
    touchServiceNode(id, now) {
      queries.updateServiceNodeSeen.run(now, now, id);
      return queries.serviceNodeById.get(id);
    },
    changeServiceNodeStatus(id, status, now) {
      return queries.updateServiceNodeStatus.run(status, now, id).changes === 1 ? queries.serviceNodeById.get(id) : null;
    },
    rotateServiceNodeCredential(id, prefix, hash, now) {
      return queries.rotateServiceNodeCredential.run(prefix, hash, now, id).changes === 1 ? queries.serviceNodeById.get(id) : null;
    },
  });
}
