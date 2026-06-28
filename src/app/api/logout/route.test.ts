import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/logout', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/session/cookie', () => ({
  SESSION_COOKIE_NAME: 'sid',
  getCookieOptions: vi.fn(() => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })),
}));

vi.mock('@/lib/logger/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const cookieDelete = vi.fn();
const cookieSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(() => ({ value: 'old-sid' })),
    delete: cookieDelete,
    set: cookieSet,
  })),
}));

import { POST } from './route';

describe('POST /api/logout response shape (spec 02 §1 + §8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should expose request_id via X-Request-ID response header (not in body)', async () => {
    const res = await POST();

    expect(res.headers.get('X-Request-ID')).toBeTruthy();

    const body = await res.json();
    expect(body).not.toHaveProperty('requestId');
    expect(body).not.toHaveProperty('request_id');
  });

  it('should clear cookie via set with maxAge=0 and full attributes (spec §8 — __Host-sid needs matching attrs)', async () => {
    await POST();

    expect(cookieDelete).not.toHaveBeenCalled();
    expect(cookieSet).toHaveBeenCalled();
    const [name, value, options] = cookieSet.mock.calls[0];
    expect(name).toBe('sid');
    expect(value).toBe('');
    expect(options.maxAge).toBe(0);
  });
});
