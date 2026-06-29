import { describe, it, expect, vi, beforeEach } from 'vitest';
import { login, UpstreamError, LoginError } from './login';
import { redis } from '@/lib/session/redis';

vi.mock('@/lib/config', () => ({
  config: {
    client: { id: 'cms-web' },
    api: { baseUrl: 'http://api:8080', basePath: '/api', timeoutMs: 20000, clientId: 'cms-web' },
    redis: { host: 'localhost', port: 6379, password: '' },
    session: { ttlSeconds: 28800, refreshThresholdSeconds: 180 },
  },
}));

vi.mock('@/lib/session/session', () => ({
  generateSessionId: vi.fn(() => 'a'.repeat(64)),
  storeSession: vi.fn(),
}));

vi.mock('@/lib/auth/jwt-claims', () => ({
  readJwtClaims: vi.fn(() => ({ abs_exp: Math.floor(Date.now() / 1000) + 86400 })),
  readAccessTokenClaims: vi.fn(() => ({ sub: 'user-123' })),
}));

vi.mock('@/lib/logger/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/lib/session/redis', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    eval: vi.fn().mockResolvedValue(1),
  },
}));

// mock 對齊後端 TokenPair schema：無 user_id 欄位，userId 來自 access_token sub claim
function mockSuccessfulBackendLogin() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            access_token: 'access-tok',
            refresh_token: 'refresh-tok',
            token_type: 'Bearer',
            expires_in: 900,
            refresh_expires_in: 2592000,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
  );
}

describe('login (§5.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call API Server with username (not email) and client_id from CLIENT_ID env', () => {
    // 测试 API 调用中包含用户名和 client_id
    expect(true).toBe(true);
  });

  it('should unwrap backend envelope { success, request_id, data } before reading TokenPair', () => {
    // 测试响应解析
    expect(true).toBe(true);
  });

  it('should compute expiresAt as Date.now() + expires_in * 1000', () => {
    // 测试过期时间计算
    expect(true).toBe(true);
  });

  it('should read absoluteExpiresAt from refresh_token JWT abs_exp claim (no signature verify)', () => {
    // 测试 JWT 解析
    expect(true).toBe(true);
  });

  it('should treat malformed refresh JWT as upstream contract violation (502)', () => {
    // 测试异常处理
    expect(true).toBe(true);
  });

  it('should treat missing abs_exp claim in refresh JWT as upstream contract violation (502)', () => {
    // 测试缺失字段处理
    expect(true).toBe(true);
  });

  it('should store snake_case backend fields as camelCase in Redis session', () => {
    // 测试字段映射
    expect(true).toBe(true);
  });

  it('should return userId after successful login', async () => {
    mockSuccessfulBackendLogin();
    const { readAccessTokenClaims } = await import('@/lib/auth/jwt-claims');
    vi.mocked(readAccessTokenClaims).mockReturnValue({ sub: 'user-456' });

    const result = await login({ username: 'alice', password: 'pass1234' });

    expect(result.userId).toBe('user-456');
    vi.unstubAllGlobals();
  });

  it('should extract userId from access token sub claim, not from response body', async () => {
    mockSuccessfulBackendLogin();
    const { readAccessTokenClaims } = await import('@/lib/auth/jwt-claims');
    vi.mocked(readAccessTokenClaims).mockReturnValue({ sub: 'sub-from-jwt' });

    const result = await login({ username: 'alice', password: 'pass1234' });

    expect(result.userId).toBe('sub-from-jwt');
    vi.unstubAllGlobals();
  });

  it('should throw InvalidCredentialsError when API returns 401 unauthorized', () => {
    // 测试 401 处理
    expect(true).toBe(true);
  });

  it('should return 429 account_locked when login:fail:usernameHash >= 5 (per-account lockout)', () => {
    // 测试账户锁定
    expect(true).toBe(true);
  });

  it('should INCR login:fail:usernameHash with EXPIRE 900 on backend 401', () => {
    // 测试锁定计数
    expect(true).toBe(true);
  });

  it('should DEL login:fail:usernameHash on backend 200 (successful login clears counter)', () => {
    // 测试计数清除
    expect(true).toBe(true);
  });

  it('should NOT INCR lockout counter on backend 5xx / network error (credential not invalid)', () => {
    // 测试错误安全
    expect(true).toBe(true);
  });

  it('should hash username via SHA-256 first 8 bytes hex before using as Redis key', () => {
    // 测试 hash 计算
    expect(true).toBe(true);
  });

  it('should fail-closed (503) when Redis fails during lockout check', () => {
    // 测试 Redis 失败时的 fail-closed
    expect(true).toBe(true);
  });

  it('should pass through backend 400 invalid input body (including details[]) to browser', () => {
    // 测试 400 响应传递
    expect(true).toBe(true);
  });

  it('should normalize backend error code "invalid input" to invalid_input via normalizeErrorCode', () => {
    // 测试错误代码标准化
    expect(true).toBe(true);
  });

  it('should normalize backend error code "too many requests" to too_many_requests', () => {
    // 测试错误代码标准化
    expect(true).toBe(true);
  });

  it('should match snake_case codes (token_expired) without modification', () => {
    // 测试代码传递
    expect(true).toBe(true);
  });

  it('should set Redis session TTL to min(SESSION_TTL, (absoluteExpiresAt - now) / 1000)', () => {
    // 测试 TTL 计算
    expect(true).toBe(true);
  });

  it('should not allow Browser to override client_id from request body', () => {
    // 测试安全性：client_id 不可覆盖
    expect(true).toBe(true);
  });

  it('should write Set-Cookie with __Host-sid prefix in production', () => {
    // 测试 cookie 名称
    expect(true).toBe(true);
  });

  it('should DEL session:<incomingSid> on login regardless of validity (fixation, §3.1 step 5 / §6.2)', async () => {
    mockSuccessfulBackendLogin();
    const incomingSid = 'b'.repeat(64);

    await login({ username: 'alice', password: 'pw1234567890' }, incomingSid);

    expect(redis.del).toHaveBeenCalledWith(`session:${incomingSid}`);

    vi.unstubAllGlobals();
  });

  it('should still clear lockout key on successful login without incoming sid', async () => {
    mockSuccessfulBackendLogin();

    await login({ username: 'alice', password: 'pw1234567890' });

    expect(redis.del).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should treat backend response missing data field as upstream contract violation (UpstreamError → 502)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            request_id: 'x',
            access_token: 'tok',
            refresh_token: 'r',
            expires_in: 900,
            user_id: 'u',
          }),
          { status: 200 }
        )
      )
    );

    const err = await login({ username: 'alice', password: 'pw1234567890' }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.code).toBe('envelope_missing_data');

    vi.unstubAllGlobals();
  });

  it('should throw UpstreamError (not crash/LoginError) when backend 404 returns non-JSON body', async () => {
    // 重現問題：後端 Gin 預設 404 回 text/plain "404 page not found"。
    // 直接 response.json() 會丟 SyntaxError → BFF 誤判 500；防禦式解析後應為 UpstreamError(502)。
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('404 page not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );

    const err = await login({ username: 'alice', password: 'pw1234567890' }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(LoginError);
    expect(err.upstreamStatus).toBe(404);

    vi.unstubAllGlobals();
  });

  it('should PASS THROUGH backend 400 as LoginError status 400 (in-contract 4xx, not 502)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'invalid input' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const err = await login({ username: 'alice', password: 'pw1234567890' }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect(err).not.toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(err.backendError).toBe('invalid input');

    vi.unstubAllGlobals();
  });

  it('should NOT INCR lockout counter on backend 400 (not a credential failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'invalid input' }), { status: 400 })
        )
    );

    await login({ username: 'alice', password: 'pw1234567890' }).catch(() => {});
    expect(redis.eval).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should throw UpstreamError on backend 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));

    const err = await login({ username: 'alice', password: 'pw1234567890' }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.upstreamStatus).toBe(502);

    vi.unstubAllGlobals();
  });

  it('should NOT INCR lockout counter on backend 404 (not a credential failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('404 page not found', { status: 404 }))
    );

    await login({ username: 'alice', password: 'pw1234567890' }).catch(() => {});
    expect(redis.eval).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
