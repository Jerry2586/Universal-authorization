export function createProductRepositoryPort(repository) {
  return Object.freeze({
    sourceVersionById: repository.sourceVersionById,
    setVersionPlans: repository.setVersionPlans,
    sourceVersionByProductVersion: repository.sourceVersionByProductVersion,
    createSourceVersion: repository.createSourceVersion,
    publishSourceVersion: repository.publishSourceVersion,
    withdrawSourceVersion: repository.withdrawSourceVersion,
    audit: repository.audit,
  });
}
