export interface KeyValueCache {
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  getAndDelete(key: string): Promise<string | null>;
  incrementWithTtl(key: string, ttlSeconds: number): Promise<number>;
}
