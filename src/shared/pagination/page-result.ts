export interface PageResult<T> {
  items: readonly T[];
  total: number;
}
