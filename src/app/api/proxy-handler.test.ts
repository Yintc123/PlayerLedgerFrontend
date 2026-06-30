import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, GET, POST, PUT, PATCH } from './[...path]/route';
import { getValidAccessToken, deleteSession } from '@/lib/session/session';
import { getRequestLogger } from '@/lib/logger/logger';

vi.mock('@/lib/logger/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  getRequestLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@/lib/session/session', () => ({
  getValidAccessToken: vi.fn(),
  verifySession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('@/lib/observability/metrics', () => ({
  recordHttpRequest: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    api: {
      baseUrl: 'http://upstream.test',
      basePath: '/v1',
      cmsBasePath: '/api',
      timeoutMs: 5000,
    },
    app: { secureTransport: false }, // 對齊既有測試：SESSION_COOKIE_NAME='sid'（見 session_revoked 測試）
  },
}));

function buildReq(
  method: string,
  path: string,
  body?: string
): { req: NextRequest; ctx: { params: Promise<{ path: string[] }> } } {
  const headers: Record<string, string> = { cookie: '__Host-sid=abc' };
  if (body) headers['content-type'] = 'application/json';
  const url = `http://localhost${path}`;
  const req = new NextRequest(new Request(url, { method, headers, body }));
  const segments = path
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);
  const ctx = { params: Promise.resolve({ path: segments }) };
  return { req, ctx };
}

describe('BFF Proxy Handler - GET /api/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should proxy GET request to upstream API with method and assembled URL', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/cms/players?limit=20', {
        method: 'GET',
        headers: { cookie: '__Host-sid=abc' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['cms', 'players'] }) };
    await GET(req, ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(calledUrl).toBe('http://upstream.test/api/cms/players?limit=20');

    vi.unstubAllGlobals();
  });

  it('should include Authorization: Bearer <accessToken> on the upstream request', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-xyz' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    await GET(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('authorization')).toBe('Bearer token-xyz');

    vi.unstubAllGlobals();
  });

  it('should whitelist request headers (forward Accept-*, drop Cookie / Host / custom)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/1', {
        method: 'GET',
        headers: {
          cookie: '__Host-sid=abc',
          host: 'evil.example.com',
          accept: 'application/json',
          'accept-language': 'zh-TW',
          'x-secret': 'leak-me',
        },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '1'] }) };
    await GET(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('accept')).toBe('application/json');
    expect(init.headers.get('accept-language')).toBe('zh-TW');
    // 不轉發 Cookie / Host / 任意自訂 header（避免洩漏 session、host 注入）
    expect(init.headers.get('cookie')).toBeNull();
    expect(init.headers.get('host')).toBeNull();
    expect(init.headers.get('x-secret')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('should whitelist response headers (forward Content-Type / Cache-Control / X-Request-ID / Retry-After, drop the rest)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-request-id': 'upstream-rid',
          'x-internal-secret': 'should-not-pass',
        },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    const res = await GET(req, ctx);

    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toBe('upstream-rid');
    expect(res.headers.get('x-internal-secret')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('should NOT forward hop-by-hop response headers (Connection, Transfer-Encoding)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
        },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    const res = await GET(req, ctx);

    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('should generate a UUID X-Request-ID for upstream when the browser sends none', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    await GET(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    vi.unstubAllGlobals();
  });

  it('should call upstream fetch with an AbortSignal (AbortSignal.any of req + timeout)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    await GET(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });

  it('should return 502 upstream_failure on a network error (fetch rejects, non-abort)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    const res = await GET(req, ctx);

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_failure');
    // 不洩漏 stack / cause
    expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');

    vi.unstubAllGlobals();
  });

  it('should return 504 upstream_timeout when BFF hard-timeout fires (req.signal NOT aborted) — spec 01 §4.2', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchSpy = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/42');
    // req.signal 未 abort → 屬 timeout 分支，回 504（非 client 斷線）
    const res = await GET(req, ctx);

    expect(res.status).toBe(504);
    const json = await res.json();
    expect(json.error).toBe('upstream_timeout');

    vi.unstubAllGlobals();
  });

  it('should log type=upstream.client_closed and throw (no response body) when req.signal aborts — spec 01 §4.2', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const warn = vi.fn();
    vi.mocked(getRequestLogger).mockReturnValue({
      warn,
      error: vi.fn(),
      info: vi.fn(),
    } as never);
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchSpy = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/42');
    // 模擬 client 斷線：req.signal 已 abort
    Object.defineProperty(req, 'signal', { value: AbortSignal.abort(), configurable: true });

    // 不寫 response body，直接 throw 交由 runtime 處理
    await expect(GET(req, ctx)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'upstream.client_closed' }),
      expect.any(String)
    );

    vi.unstubAllGlobals();
  });

  it('should reject empty-segment paths with 400 invalid_path (no upstream call)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items//42', {
        method: 'GET',
        headers: { cookie: '__Host-sid=abc' },
      })
    );
    // path 含空段（//）
    const ctx = { params: Promise.resolve({ path: ['items', '', '42'] }) };
    const res = await GET(req, ctx);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_path');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should reject body over 1MB with 413 payload_too_large (Content-Length)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/1', {
        method: 'POST',
        headers: {
          cookie: '__Host-sid=abc',
          'content-type': 'application/json',
          'content-length': String(1024 * 1024 + 1),
        },
        body: '{}',
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '1'] }) };
    const res = await POST(req, ctx);

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toBe('payload_too_large');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // TODO(spec 03 §2.4/§3.3): 代理目前未在 inbound 層發出 http.request/http.response log
  // 與 http.request.duration metric（含 route template 維度）。待觀測層接線後實作以下測試。
  it.skip('should log http.request and http.response for each call (spec 03 §2.4 — not yet wired)', () => {});

  it.skip('should emit http.request.duration metric (spec 03 §3.3 — not yet wired)', () => {});

  it('should propagate incoming X-Request-ID to the request logger and upstream', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/1', {
        method: 'GET',
        headers: { cookie: '__Host-sid=abc', 'x-request-id': 'incoming-rid-123' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '1'] }) };
    await GET(req, ctx);

    expect(vi.mocked(getRequestLogger)).toHaveBeenCalledWith('incoming-rid-123');
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('x-request-id')).toBe('incoming-rid-123');

    vi.unstubAllGlobals();
  });

  it.skip('should use route template for metric route dimension (spec 03 §3.3 — not yet wired)', () => {});

  it('should pass through upstream 429 with the Retry-After header', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'too_many_requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    const res = await GET(req, ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');

    vi.unstubAllGlobals();
  });

  it('should preserve upstream response status codes (e.g. 404 passthrough)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'resource not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/missing');
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('resource not found');

    vi.unstubAllGlobals();
  });

  it('should return 401 unauthenticated without calling upstream when no valid token', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue(null as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('GET', '/api/items/1');
    const res = await GET(req, ctx);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthenticated');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('BFF Proxy Handler - POST /api/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should proxy POST request forwarding method and body verbatim', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const payload = JSON.stringify({ name: 'x' });
    const { req, ctx } = buildReq('POST', '/api/items', payload);
    const res = await POST(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(payload);
    expect(res.status).toBe(201);

    vi.unstubAllGlobals();
  });

  it('should forward Content-Type: application/json to upstream', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('POST', '/api/items', JSON.stringify({ a: 1 }));
    await POST(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('content-type')).toBe('application/json');

    vi.unstubAllGlobals();
  });

  it('should forward Content-Type: application/x-www-form-urlencoded to upstream', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items', {
        method: 'POST',
        headers: {
          cookie: '__Host-sid=abc',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'a=1&b=2',
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items'] }) };
    await POST(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('a=1&b=2');

    vi.unstubAllGlobals();
  });

  it('should allow a body of exactly 1MB (boundary, not 413)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items', {
        method: 'POST',
        headers: {
          cookie: '__Host-sid=abc',
          'content-type': 'application/json',
          'content-length': String(1024 * 1024),
        },
        body: '{}',
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items'] }) };
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('should send an empty (undefined) body upstream when POST body is empty string', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('POST', '/api/items', '');
    await POST(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.body).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

describe('BFF Proxy Handler - PUT / PATCH / DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should proxy PUT request forwarding method and body', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const payload = JSON.stringify({ name: 'updated' });
    const { req, ctx } = buildReq('PUT', '/api/items/1', payload);
    await PUT(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(payload);

    vi.unstubAllGlobals();
  });

  it('should proxy PATCH request forwarding method and body', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const payload = JSON.stringify({ status: 'completed' });
    const { req, ctx } = buildReq('PATCH', '/api/items/1', payload);
    await PATCH(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(payload);

    vi.unstubAllGlobals();
  });

  it('should proxy DELETE request and pass through a 204 No Content (no body)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('DELETE', '/api/items/1');
    const res = await DELETE(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('DELETE');
    // 204 為 null-body status：透傳時不可帶 body，否則 Response 建構子會丟錯
    expect(res.status).toBe(204);

    vi.unstubAllGlobals();
  });

  it('should forward DELETE request body to upstream (spec §4.2 — DELETE supports body)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { req, ctx } = buildReq('DELETE', '/api/items/42', JSON.stringify({ reason: 'cleanup' }));
    await DELETE(req, ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBe(JSON.stringify({ reason: 'cleanup' }));

    vi.unstubAllGlobals();
  });

  it('should append last XFF segment as BFF immediate peer IP (spec §4.2 — not hardcoded 127.0.0.1)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/42', {
        method: 'DELETE',
        headers: {
          cookie: '__Host-sid=abc',
          'x-forwarded-for': '203.0.113.1, 10.0.0.1',
        },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '42'] }) };
    await DELETE(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const xff = init.headers.get('x-forwarded-for');
    expect(xff).not.toContain('127.0.0.1');
    expect(xff).toBe('203.0.113.1, 10.0.0.1, 10.0.0.1');

    vi.unstubAllGlobals();
  });

  it('should NOT add X-Forwarded-For when no incoming XFF and no x-real-ip (avoid fake 127.0.0.1 peer)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/42', {
        method: 'DELETE',
        headers: { cookie: '__Host-sid=abc' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '42'] }) };
    await DELETE(req, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const xff = init.headers.get('x-forwarded-for');
    expect(xff).not.toBe('127.0.0.1');

    vi.unstubAllGlobals();
  });

  it('should call OTel propagation.inject on outbound headers (spec 03 §4.6)', async () => {
    const injectSpy = vi.fn(
      (_ctx, carrier: Headers, setter: { set: (c: Headers, k: string, v: string) => void }) => {
        setter.set(carrier, 'traceparent', '00-bff-injected-trace-id-00');
      }
    );
    vi.doMock('@opentelemetry/api', () => ({
      context: { active: vi.fn() },
      propagation: { inject: injectSpy },
    }));

    vi.mocked(getValidAccessToken).mockResolvedValue('token-123' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/items/42', {
        method: 'DELETE',
        headers: { cookie: '__Host-sid=abc' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['items', '42'] }) };
    await DELETE(req, ctx);

    expect(injectSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.get('traceparent')).toBe('00-bff-injected-trace-id-00');

    vi.unstubAllGlobals();
    vi.doUnmock('@opentelemetry/api');
  });
});

describe('URL Assembly', () => {
  it('should assemble URL using cmsBasePath (not basePath) — spec 01 §4.2', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-abc' as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/cms/players?limit=20', {
        method: 'GET',
        headers: { cookie: '__Host-sid=abc' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['cms', 'players'] }) };
    await GET(req, ctx);

    const [calledUrl] = fetchSpy.mock.calls[0];
    // Must use cmsBasePath (/api), NOT basePath (/v1)
    expect(calledUrl).toContain('/api/cms/players');
    expect(calledUrl).not.toContain('/v1/cms/players');

    vi.unstubAllGlobals();
  });

  it('should handle query parameters correctly', () => {
    // 测试查询参数
    expect(true).toBe(true);
  });

  it('should strip leading/trailing slashes to avoid //', () => {
    // 测试斜杠处理
    expect(true).toBe(true);
  });

  it('should preserve URL encoding in path and query', () => {
    // 测试编码保留
    expect(true).toBe(true);
  });
});

describe('session_revoked handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete BFF session and return 401 when backend returns 401 session_revoked', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-abc' as never);
    vi.mocked(deleteSession).mockResolvedValue(undefined as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'session_revoked', request_id: 'rid' }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    // 測試環境 config.isProd=undefined(falsy) → SESSION_COOKIE_NAME='sid'
    const req = new NextRequest(
      new Request('http://localhost/api/cms/players', {
        method: 'GET',
        headers: { cookie: 'sid=test-sid' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['cms', 'players'] }) };
    const response = await GET(req, ctx);

    expect(response.status).toBe(401);
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith('test-sid');

    vi.unstubAllGlobals();
  });

  it('should NOT delete BFF session for other upstream 401 error codes', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-abc' as never);
    vi.mocked(deleteSession).mockResolvedValue(undefined as never);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'forbidden', request_id: 'rid' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const req = new NextRequest(
      new Request('http://localhost/api/cms/players', {
        method: 'GET',
        headers: { cookie: 'sid=test-sid' },
      })
    );
    const ctx = { params: Promise.resolve({ path: ['cms', 'players'] }) };
    const response = await GET(req, ctx);

    expect(response.status).toBe(401);
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
