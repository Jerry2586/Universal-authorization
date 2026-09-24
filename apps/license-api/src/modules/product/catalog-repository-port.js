export function createProductCatalogRepositoryPort(repository) {
  return Object.freeze({
    productByCode: repository.productByCode,
    createProduct: repository.createProduct,
    listActiveSourceVersions: repository.listActiveSourceVersions,
  });
}
