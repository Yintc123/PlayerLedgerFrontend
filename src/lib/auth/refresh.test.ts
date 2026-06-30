import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshTokens, TokenRefreshError, UpstreamError } from './refresh';

vi.mock('@/lib/config', () => ({
  config: {
    api: { baseUrl: 'http://api:8080', basePath: '/api', timeoutMs: 20000 },
  },
}));

vi.mock('@/lib/logger/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = {
  success: true,
  request_id: 'r1',
  data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 },
};

describe('refreshTokens (§5.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should POST to /auth/refresh with body { refresh_token } (snake_case)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, okBody));
    vi.stubGlobal('fetch', fetchSpy);

    await refreshTokens('rt-1');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://api:8080/api/auth/refresh');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'rt-1' });
  });

  it('should unwrap envelope and return camelCase TokenPair { accessToken, refreshToken, expiresAt }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, okBody)));

    const pair = await refreshTokens('rt-1');

    expect(pair.accessToken).toBe('new-access');
    expect(pair.refreshToken).toBe('new-refresh');
    expect(typeof pair.expiresAt).toBe('number');
  });

  it('should NOT return abs_exp from refresh response (rotation does not extend abs_exp)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, okBody)));

    const pair = await refreshTokens('rt-1');

    expect(pair).not.toHaveProperty('absoluteExpiresAt');
    expect(pair).not.toHaveProperty('abs_exp');
  });

  it('should throw TokenRefreshError when API returns 401 (any backend error code)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: 'token_expired' }))
    );

    await expect(refreshTokens('rt-1')).rejects.toBeInstanceOf(TokenRefreshError);
  });

  it('should preserve backend error code on the thrown error for log purposes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: 'replay_detected' }))
    );

    await expect(refreshTokens('rt-1')).rejects.toMatchObject({ backendError: 'replay_detected' });
  });

  it('should throw a terminal TokenRefreshError on 400 invalid_client (delete session, not preserve) — spec §7', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_client' }))
    );

    const err = await refreshTokens('rt-1').catch((e) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect(err.backendError).toBe('invalid_client');
  });

  it('should throw UpstreamError when API returns 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' })));

    await expect(refreshTokens('rt-1')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('should throw UpstreamError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(refreshTokens('rt-1')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('should NOT auto-retry refresh on any failure (replay protection)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'token_expired' }));
    vi.stubGlobal('fetch', fetchSpy);

    await refreshTokens('rt-1').catch(() => {});

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
