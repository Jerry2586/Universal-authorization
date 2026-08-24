import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, fetchAllPages, queryString, setCsrfToken } from './client';

function envelope<T>(data: T, success = true, code = 'OK', message = 'ok') {
  return { request_id: 'req-test', success, code, message, server_time: new Date().toISOString(), data };
}

describe('API 客户端', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setCsrfToken('');
  });

  it('只序列化有效筛选参数', () => {
    expect(queryString({ limit: 50, status: 'ACTIVE', empty: '', skip: undefined })).toBe('?limit=50&status=ACTIVE');
  });

  it('连续读取全部真实分页直到最后一页', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      const items = offset === 0 ? Array.from({ length: 100 }, (_, index) => ({ id: index })) : [{ id: 100 }];
      return new Response(JSON.stringify(envelope({ items, limit: 100, offset })), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchAllPages<{ id: number }>('/admin/v1/products', { status: 'ACTIVE' });

    expect(result).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('offset=100');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('status=ACTIVE');
  });

  it('把服务器错误包转换为可显示的 ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(envelope(null, false, 'FORBIDDEN', '没有操作权限')), { status: 403, headers: { 'content-type': 'application/json' } }));

    await expect(api('/admin/v1/products')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: '没有操作权限', requestId: 'req-test' });
  });

  it('写请求自动附带当前 CSRF 令牌', async () => {
    setCsrfToken('csrf-real');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(envelope({ saved: true })), { status: 200, headers: { 'content-type': 'application/json' } }));

    await api('/admin/v1/products', { method: 'POST', body: '{}' });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-csrf-token')).toBe('csrf-real');
    expect(headers.get('content-type')).toBe('application/json');
  });
});
