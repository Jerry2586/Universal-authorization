export function createProductRepositoryPort(repository) {
  return Object.freeze({
    sourceVersionByProductVersion: repository.sourceVersionByProductVersion,
    createSourceVersion: repository.createSourceVersion,
    publishSourceVersion: repository.publishSourceVersion,
    withdrawSourceVersion: repository.withdrawSourceVersion,
    audit: repository.audit,
  });
}
