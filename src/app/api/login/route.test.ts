import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/login', () => {
  class LoginError extends Error {
    constructor(
      public backendError: string,
      message: string,
      public retryAfterSec?: number,
      public status?: number
    ) {
      super(message);
      this.name = 'LoginError';
    }
  }
  class UpstreamError extends Error {
    constructor(
      public code: string,
      message: string,
      public upstreamStatus?: number,
      public timeout = false
    ) {
      super(message);
      this.name = 'UpstreamError';
    }
  }
  return {
    login: vi.fn().mockResolvedValue({
      userId: 'user-1',
      sessionId: 'a'.repeat(64),
      absoluteExpiresAt: Date.now() + 3600_000,
    }),
    LoginError,
    UpstreamError,
  };
});

vi.mock('@/lib/session/cookie', () => ({
  SESSION_COOKIE_NAME: 'sid',
  getCookieOptions: vi.fn(() => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 3600,
  })),
}));

vi.mock('@/lib/config', () => ({
  config: {
    session: { ttlSeconds: 28800 },
  },
}));

vi.mock('@/lib/logger/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const cookieSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    set: cookieSet,
  })),
}));

import { POST } from './route';

function buildPost(body: object): NextRequest {
  return new NextRequest(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/login response shape (spec 02 §1 + §8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should expose request_id via X-Request-ID response header (not in body)', async () => {
    const req = buildPost({ username: 'alice', password: 'pw1234567890' });
    const res = await POST(req);

    expect(res.headers.get('X-Request-ID')).toBeTruthy();

    const body = await res.json();
    expect(body).not.toHaveProperty('requestId');
    expect(body).not.toHaveProperty('request_id');
  });

  it('should set Retry-After header on 429 account_locked (spec §6.3)', async () => {
    const { login, LoginError } = await import('@/lib/auth/login');
    vi.mocked(login).mockRejectedValueOnce(
      new (LoginError as unknown as new (b: string, m: string, ttl?: number) => Error)(
        'account_locked',
        'locked',
        600
      )
    );

    const req = buildPost({ username: 'alice', password: 'pw1234567890' });
    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
  });

  it('should pass through an in-contract upstream 400 as 400 (LoginError.status), not 502', async () => {
    const { login, LoginError } = await import('@/lib/auth/login');
    vi.mocked(login).mockRejectedValueOnce(
      new (LoginError as unknown as new (
        b: string,
        m: string,
        t: number | undefined,
        s: number
      ) => Error)('invalid input', 'Invalid login request', undefined, 400)
    );

    const req = buildPost({ username: 'alice', password: 'pw1234567890' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid input');
  });

  it('should return 502 upstream_failure when login throws UpstreamError (e.g. backend 404), NOT 500', async () => {
    const { login, UpstreamError } = await import('@/lib/auth/login');
    vi.mocked(login).mockRejectedValueOnce(
      new (UpstreamError as unknown as new (
        c: string,
        m: string,
        s?: number
      ) => Error)('upstream_status', 'Backend returned 404', 404)
    );

    const req = buildPost({ username: 'alice', password: 'pw1234567890' });
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream_failure');
    // 不洩漏上游細節
    expect(JSON.stringify(body)).not.toContain('404');
  });

  it('should return 504 upstream_timeout when login throws a timeout UpstreamError', async () => {
    const { login, UpstreamError } = await import('@/lib/auth/login');
    vi.mocked(login).mockRejectedValueOnce(
      new (UpstreamError as unknown as new (
        c: string,
        m: string,
        s: number | undefined,
        t: boolean
      ) => Error)('upstream_timeout', 'timed out', undefined, true)
    );

    const req = buildPost({ username: 'alice', password: 'pw1234567890' });
    const res = await POST(req);

    expect(res.status).toBe(504);
    expect((await res.json()).error).toBe('upstream_timeout');
  });
});
