export function createOperationsRepositoryPort(repository) {
  return Object.freeze({
    setting: repository.setting,
    listSettings: repository.listSettings,
    setSetting: repository.setSetting,
    dashboardStats: repository.dashboardStats,
    createServiceNode: repository.createServiceNode,
    serviceNodeById: repository.serviceNodeById,
    serviceNodeByCredentialHash: repository.serviceNodeByCredentialHash,
    listServiceNodes: repository.listServiceNodes,
    touchServiceNode: repository.touchServiceNode,
    changeServiceNodeStatus: repository.changeServiceNodeStatus,
    rotateServiceNodeCredential: repository.rotateServiceNodeCredential,
    audit: repository.audit,
  });
}
