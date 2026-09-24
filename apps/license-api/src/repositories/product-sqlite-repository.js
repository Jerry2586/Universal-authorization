import { newId } from '../../../../packages/core/src/identifiers.js';

export function createProductSqliteRepository(queries) {
  return Object.freeze({
    createProduct({ code, name, now }) {
      const id = newId('prd');
      queries.insertProduct.run(id, code, name, now);
      return queries.productByCode.get(code);
    },
    productByCode: (code) => queries.productByCode.get(code),
    createSourceVersion(values) {
      const id = values.id ?? newId('src');
      queries.insertSourceVersion.run(
        id, values.productId, values.version, values.displayName, values.sourceKind,
        values.sourceRef ?? null, values.status ?? 'active', values.releaseNotes ?? '', values.channel ?? 'stable',
        values.releaseKind ?? 'feature', values.minXboardVersion ?? null, values.minUpgradeVersion ?? null,
        values.rollbackAllowed === false ? 0 : 1, values.rollbackTo ?? null,
        (values.status ?? 'active') === 'active' ? values.now : null, values.now,
      );
      return queries.sourceVersionById.get(id);
    },
    sourceVersionById: (id) => queries.sourceVersionById.get(id),
    sourceVersionByProductVersion: (productCode, version) => queries.sourceVersionByProductVersion.get(productCode, version),
    publishSourceVersion(values) {
      const changed = queries.publishSourceVersion.run(
        values.displayName, values.sourceKind, values.sourceRef, values.releaseNotes ?? '', values.channel ?? 'stable',
        values.releaseKind ?? 'feature', values.minXboardVersion ?? null, values.minUpgradeVersion ?? null,
        values.rollbackAllowed === false ? 0 : 1, values.rollbackTo ?? null, values.now, values.id,
      ).changes;
      return changed === 1 ? queries.sourceVersionById.get(values.id) : null;
    },
    listActiveSourceVersions: (productCode) => queries.listActiveSourceVersions.all(productCode),
    listSourceVersions: (productCode) => queries.listSourceVersions.all(productCode),
    withdrawSourceVersion(id, reason) {
      return queries.withdrawSourceVersion.run(reason, id).changes === 1 ? queries.sourceVersionById.get(id) : null;
    },
  });
}
