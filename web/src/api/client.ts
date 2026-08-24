export interface ApiEnvelope<T> {
  request_id: string;
  success: boolean;
  code: string;
  message: string;
  server_time: string;
  data: T;
}

export class ApiError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) {
    super(message);
  }
}

let csrfToken = '';
let unauthorizedHandler: (() => void) | undefined;

export function setCsrfToken(value: string): void { csrfToken = value; }
export function setUnauthorizedHandler(handler: () => void): void { unauthorizedHandler = handler; }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  let envelope: ApiEnvelope<T> | undefined;
  try { envelope = await response.json() as ApiEnvelope<T>; } catch { /* non-json response */ }
  if (!response.ok || envelope?.success === false) {
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiError(response.status, envelope?.code ?? 'HTTP_ERROR', envelope?.message ?? `请求失败 (${response.status})`, envelope?.request_id);
  }
  if (envelope === undefined) throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器返回了无法识别的数据');
  return envelope.data;
}

export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function fetchAllPages<T>(path: string, values: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const limit = 100;
  let offset = 0;
  const all: T[] = [];
  for (;;) {
    const page = await api<{ items: T[]; limit: number; offset: number; total?: number }>(`${path}${queryString({ ...values, limit, offset })}`);
    all.push(...page.items);
    if (page.total !== undefined && all.length >= page.total) return all;
    if (page.items.length < limit) return all;
    offset += limit;
  }
}
