export const PRODUCT_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export interface Product {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  status: ProductStatus;
  minimumClientVersion?: string;
  recommendedClientVersion?: string;
  forceUpdateVersion?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function isProductEnabled(product: Product): boolean {
  return product.status === 'ACTIVE';
}
