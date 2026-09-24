import { createActivationSqliteRepository } from './repositories/activation-sqlite-repository.js';
import { createAuditSqliteRepository } from './repositories/audit-sqlite-repository.js';
import { createEntitlementSqliteRepository } from './repositories/entitlement-sqlite-repository.js';
import { createErasureSqliteRepository } from './repositories/erasure-sqlite-repository.js';
import { createIdentitySqliteRepository } from './repositories/identity-sqlite-repository.js';
import { createLicensingSqliteRepository } from './repositories/licensing-sqlite-repository.js';
import { createOperationsSqliteRepository } from './repositories/operations-sqlite-repository.js';
import { createPackagingSqliteRepository } from './repositories/packaging-sqlite-repository.js';
import { createProductSqliteRepository } from './repositories/product-sqlite-repository.js';
import { createSqliteStatements } from './repositories/sqlite-statements.js';
import { createSupportSqliteRepository } from './repositories/support-sqlite-repository.js';

export function createRepository(database) {
  const queries = createSqliteStatements(database);
  return Object.freeze({
    ...createProductSqliteRepository(queries),
    ...createEntitlementSqliteRepository(queries),
    ...createLicensingSqliteRepository(queries),
    ...createActivationSqliteRepository(queries),
    ...createPackagingSqliteRepository(queries),
    ...createAuditSqliteRepository(queries),
    ...createIdentitySqliteRepository(queries),
    ...createOperationsSqliteRepository(queries),
    ...createSupportSqliteRepository(queries),
    ...createErasureSqliteRepository(queries),
  });
}
