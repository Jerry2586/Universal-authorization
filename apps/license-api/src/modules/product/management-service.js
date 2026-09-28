import { invariant } from '../../../../../packages/core/src/errors.js';

export function normalizeProductCode(value) {
  invariant(typeof value === 'string', 'PRODUCT_CODE_INVALID', '产品标识必须是英文小写字母、数字或短横线');
  const code = value.trim().toLowerCase();
  invariant(/^[a-z][a-z0-9-]{0,63}$/.test(code), 'PRODUCT_CODE_INVALID', '产品标识以字母开头，限 64 位英文小写字母、数字或短横线');
  return code;
}

export function createProductManagementService({ repository, atomic, clock = () => new Date() }) {
  function nameOf(value) {
    invariant(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80,
      'PRODUCT_NAME_INVALID', '产品名称需要 1 至 80 个字符');
    return value.trim();
  }
  function audit(product, action, actorId, before = null) {
    repository.audit({ actorType: 'admin', actorId, action, subjectType: 'product', subjectId: product.id,
      metadata: { code: product.code, name: product.name, status: product.status, before }, now: clock().toISOString() });
  }
  return Object.freeze({
    listProducts: () => repository.listProducts(),
    createManagedProduct({ code, name, actorId }) {
      code = normalizeProductCode(code); name = nameOf(name);
      return atomic(() => {
        invariant(!repository.productByCode(code), 'PRODUCT_EXISTS', '产品标识已经存在', 409);
        const product = repository.createProduct({ code, name, now: clock().toISOString() });
        audit(product, 'product.created', actorId);
        return product;
      });
    },
    updateManagedProduct({ code, name, status, actorId }) {
      code = normalizeProductCode(code); name = nameOf(name);
      invariant(['active', 'archived'].includes(status), 'PRODUCT_STATUS_INVALID', '产品状态只能为启用或归档');
      return atomic(() => {
        const before = repository.productByCode(code);
        invariant(before, 'PRODUCT_NOT_FOUND', '产品不存在', 404);
        const product = repository.updateProduct({ code, name, status });
        audit(product, 'product.updated', actorId, { name: before.name, status: before.status });
        return product;
      });
    },
  });
}
