import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/config', () => ({
  config: {
    api: {
      baseUrl: 'http://api.test',
      basePath: '/v1',
      timeoutMs: 5000,
      clientId: 'cms-web',
    },
  },
}));

vi.mock('@/lib/logger/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function buildPost(body: object): NextRequest {
  return new NextRequest(
    new Request('http://localhost/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/register (spec 02 §3.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should forward request to backend /auth/register with BFF-injected client_id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = buildPost({ username: 'newbie', password: 'StrongPass123!' });
    await POST(req);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://api.test/v1/auth/register');
    const body = JSON.parse(init.body);
    expect(body.client_id).toBe('cms-web');

    vi.unstubAllGlobals();
  });

  it('should strip browser-supplied client_id (cannot override BFF policy)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const req = buildPost({
      username: 'newbie',
      password: 'StrongPass123!',
      client_id: 'public-web',
    });
    await POST(req);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.client_id).toBe('cms-web');

    vi.unstubAllGlobals();
  });

  it('should pass through backend 201 status (no body) to browser', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 201 })));

    const req = buildPost({ username: 'newbie', password: 'StrongPass123!' });
    const res = await POST(req);

    expect(res.status).toBe(201);

    vi.unstubAllGlobals();
  });

  it('should pass through backend 409 username_taken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'username_taken' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const req = buildPost({ username: 'taken', password: 'StrongPass123!' });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('username_taken');

    vi.unstubAllGlobals();
  });

  it('should set X-Request-ID response header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 201 })));

    const req = buildPost({ username: 'newbie', password: 'StrongPass123!' });
    const res = await POST(req);

    expect(res.headers.get('X-Request-ID')).toBeTruthy();

    vi.unstubAllGlobals();
  });
});
