import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const cookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: cookieGet }),
}));

const getValidAccessTokenMock = vi.fn();
vi.mock('@/lib/session/session', () => ({
  getValidAccessToken: (sid: unknown) => getValidAccessTokenMock(sid),
}));

const apiFetchMock = vi.fn();
vi.mock('./client', () => ({
  apiFetch: (url: string, init: unknown) => apiFetchMock(url, init),
}));

vi.mock('@/lib/config', () => ({
  config: { api: { baseUrl: 'http://api:8080', cmsBasePath: '/api', timeoutMs: 20000 } },
}));

import { cmsRequest } from './cms';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  cookieGet.mockReset().mockReturnValue({ value: 'sid-123' });
  getValidAccessTokenMock.mockReset().mockResolvedValue('access-token-abc');
  apiFetchMock.mockReset();
});

describe('cmsRequest', () => {
  it('should attach the bearer token and call the cms base url with the path', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { ok: 1 } }));
    await cmsRequest('/cms/deposit-records');
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe('http://api:8080/api/cms/deposit-records');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-abc');
  });

  it('should append search params to the url', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: [] }));
    const sp = new URLSearchParams();
    sp.set('page', '2');
    sp.append('status', 'pending');
    await cmsRequest('/cms/deposit-records', { searchParams: sp });
    expect(apiFetchMock.mock.calls[0][0]).toBe(
      'http://api:8080/api/cms/deposit-records?page=2&status=pending'
    );
  });

  it('should unwrap the envelope data and map meta to camelCase', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: [{ id: 'a' }],
        meta: { page: 1, page_size: 20, total: 137 },
      })
    );
    const { data, meta } = await cmsRequest('/cms/deposit-records');
    expect(data).toEqual([{ id: 'a' }]);
    expect(meta).toEqual({ page: 1, pageSize: 20, total: 137 });
  });

  it('should send a JSON body with Content-Type on POST', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: {} }));
    await cmsRequest('/cms/deposit-records', { method: 'POST', body: { amount: 100 } });
    const init = apiFetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ amount: 100 }));
  });

  it('should throw ApiError(401) when there is no valid access token', async () => {
    getValidAccessTokenMock.mockResolvedValue(null);
    await expect(cmsRequest('/cms/deposit-records')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('should map a non-2xx response to ApiError with a normalized code', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(403, { success: false, error: 'forbidden', message: '無權' })
    );
    await expect(cmsRequest('/cms/deposit-records')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: '無權',
    });
  });

  it('should carry Retry-After seconds on 429', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(429, { success: false, error: 'too_many_requests' }, { 'retry-after': '7' })
    );
    try {
      await cmsRequest('/cms/deposit-records');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(429);
      expect((err as ApiError).retryAfter).toBe(7);
    }
  });
});
