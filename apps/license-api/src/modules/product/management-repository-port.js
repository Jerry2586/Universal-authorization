export function createProductManagementRepositoryPort(repository) {
  return Object.freeze({
    listProducts: repository.listProducts, productByCode: repository.productByCode,
    createProduct: repository.createProduct, updateProduct: repository.updateProduct, audit: repository.audit,
  });
}
