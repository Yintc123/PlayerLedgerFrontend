import { createHash } from 'node:crypto';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger/logger';
import { storeSession, generateSessionId, type SessionData } from '@/lib/session/session';
import { redis } from '@/lib/session/redis';
import { readJwtClaims, readAccessTokenClaims } from './jwt-claims';

export type LoginCredentials = {
  username: string;
  password: string;
};

export type LoginResponse = {
  userId: string;
  sessionId: string;
  absoluteExpiresAt: number;
};

export class LoginError extends Error {
  constructor(
    public backendError: string,
    message: string,
    public retryAfterSec?: number,
    /**
     * 明確的對外 HTTP 狀態碼。用於「透傳上游契約內 4xx」（如後端 400 BadRequest）時
     * 精準帶回上游狀態，而非由 route 依 error code 推斷（code 任意時推斷會錯）。
     * 未指定時由 route 依 backendError 推導。
     */
    public status?: number
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

export class InvalidCredentialsError extends LoginError {
  constructor(backendError: string) {
    super(backendError, 'Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * 上游（後端 API）層級失敗：網路錯誤、逾時、非預期 HTTP 狀態（如 404 / 5xx）、
 * 或回應不符契約（envelope / JWT 異常）。**與「帳密錯誤」語意不同**——這類屬 gateway
 * 失敗，BFF 對 Browser 應回 502（逾時 504），不可降級成 500（BFF 自身崩潰）或 401（帳密錯）。
 * 對應 spec 01 §4.2 upstream_failure / upstream_timeout。
 */
export class UpstreamError extends Error {
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

/**
 * 安全解析上游回應 body：上游錯誤（如 Gin 預設 404 `text/plain` "404 page not found"）
 * 不保證是 JSON。直接 `response.json()` 會在非 JSON 時丟 SyntaxError，導致 BFF 誤判 500。
 * 故先讀 text 再嘗試 JSON.parse，失敗回 `{}`，由呼叫端依 HTTP 狀態決定語意。
 */
async function parseJsonSafe(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 登入流程（§3.1）
// incomingSid 為 browser 帶來的既有 sid cookie（若有）— 不論合法與否，登入前都會
// DEL session:<incomingSid>，防 session fixation（§3.1 step 5 / §6.2）。
export async function login(
  credentials: LoginCredentials,
  incomingSid?: string
): Promise<LoginResponse> {
  // 1. 驗證 request body
  if (!credentials.username || credentials.username.length > 128) {
    throw new LoginError('invalid_input', 'Username must be non-empty and ≤ 128 characters');
  }

  if (!credentials.password || credentials.password.length > 256) {
    throw new LoginError('invalid_input', 'Password must be non-empty and ≤ 256 characters');
  }

  // 2. Account lockout check（§6.3）
  const usernameHash = createHash('sha256').update(credentials.username).digest('hex').slice(0, 8);

  const lockoutKey = `login:fail:${usernameHash}`;

  // Redis 故障 → fail-closed 503（spec §3.1 / ADR 011）
  let lockoutCount: string | null;
  try {
    lockoutCount = await redis.get(lockoutKey);
  } catch (err) {
    logger.error(
      { type: 'auth.login.redis_error', error: err instanceof Error ? err.message : String(err) },
      'Redis failure during lockout check; fail-closed'
    );
    throw new LoginError('service_unavailable', 'Service temporarily unavailable');
  }

  if (lockoutCount && parseInt(lockoutCount, 10) >= 5) {
    let ttl = 900;
    try {
      ttl = await redis.ttl(lockoutKey);
    } catch {
      // TTL 查詢失敗不影響主流程，用預設值
    }
    logger.warn(
      {
        type: 'auth.login.locked',
        usernameHash,
        lockoutCount,
        lockoutTtlSec: ttl,
      },
      'Account locked after 5 failed attempts'
    );
    throw new LoginError(
      'account_locked',
      'Account locked due to too many failed login attempts',
      ttl
    );
  }

  // 3. 呼叫後端 /auth/login
  const url = `${config.api.baseUrl}${config.api.basePath}/auth/login`;
  const requestId = crypto.randomUUID();

  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.api.timeoutMs);

    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        client_id: config.api.clientId,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    logger.error(
      {
        type: isTimeout ? 'auth.login.upstream_timeout' : 'auth.login.network_error',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      isTimeout ? 'Login upstream timeout' : 'Login network error'
    );
    throw new UpstreamError(
      isTimeout ? 'upstream_timeout' : 'upstream_unreachable',
      isTimeout ? 'Backend request timed out' : 'Backend unreachable',
      undefined,
      isTimeout
    );
  }

  // 解析回應 body — 防禦式解析（上游錯誤未必是 JSON；見 parseJsonSafe）
  const body = await parseJsonSafe(response);

  // 失敗情況 1：401 (invalid credentials)
  if (response.status === 401) {
    // 原子寫入 lockout 計數 + EXPIRE（spec §3.1）
    // 用 Lua 確保 INCR 與 EXPIRE 是同一 op：避免 Redis crash / failover 在兩者之間
    // 造成計數無 TTL（永久鎖死）
    const luaIncrExpire = `
      local v = redis.call('INCR', KEYS[1])
      if v == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return v
    `;
    let newCount = 1;
    try {
      newCount = (await redis.eval(luaIncrExpire, 1, lockoutKey, '900')) as number;
    } catch (err) {
      // Redis 寫入失敗時不阻斷 401 回應（讀路徑已 fail-closed），記 warn 供觀測
      logger.warn(
        {
          type: 'auth.login.lockout_incr_failed',
          error: err instanceof Error ? err.message : String(err),
          requestId,
        },
        'Failed to increment lockout counter'
      );
    }

    const errorCode = (typeof body.error === 'string' && body.error) || 'invalid_credentials';
    logger.warn(
      {
        type: 'auth.login.failure',
        reason: errorCode,
        usernameHash,
        lockoutCount: newCount,
        requestId,
      },
      'Login failed: invalid credentials'
    );
    throw new InvalidCredentialsError(errorCode);
  }

  // 失敗情況 2：429 限流（後端 rate limit）— 屬可重試的客戶端狀態，透傳 Retry-After
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    logger.warn(
      { type: 'auth.login.rate_limited', requestId, retryAfterSec },
      'Login rate-limited by upstream'
    );
    throw new LoginError(
      'too_many_requests',
      'Too many requests, please retry later',
      Number.isNaN(retryAfterSec as number) ? undefined : retryAfterSec
    );
  }

  // 失敗情況 3：400 BadRequest — 屬 /auth/login 契約內的「客戶端錯誤」（OpenAPI 文件化）。
  // 「契約內透傳」：原樣帶回 400 + 上游 error code，由前端解讀，不藏成 502（spec 02 §3.1）。
  if (response.status === 400) {
    const code = (typeof body.error === 'string' && body.error) || 'invalid_input';
    logger.warn(
      { type: 'auth.login.bad_request', code, requestId },
      'Login bad request (passthrough)'
    );
    throw new LoginError(code, 'Invalid login request', undefined, 400);
  }

  // 失敗情況 4：契約外狀態（403 / 404 / 405 / 5xx ...）→ gateway 失敗，回 502（非 500/401）。
  // 對 login 這種「固定上游目標」的呼叫，契約外狀態只可能代表路由/設定/上游異常，
  // 對瀏覽器無意義也無法處理（spec 02 §3.1「契約內透傳、契約外翻譯」）。
  if (!response.ok) {
    logger.error(
      {
        type: 'auth.login.upstream_failure',
        status: response.status,
        requestId,
      },
      'Login upstream returned out-of-contract status'
    );
    throw new UpstreamError(
      'upstream_status',
      `Backend returned ${response.status}`,
      response.status
    );
  }

  // 成功登入清除計數
  await redis.del(lockoutKey);

  // 4. 建立 session — 後端契約規定 envelope { success, request_id, data }（spec §7 / §8）
  if (!body.data || typeof body.data !== 'object') {
    logger.error(
      { type: 'auth.envelope.parse_error', requestId },
      'Backend response missing envelope data field (upstream contract violation)'
    );
    throw new UpstreamError('envelope_missing_data', 'Backend response missing data field');
  }

  const tokenData = body.data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const expiresInSeconds = tokenData.expires_in;

  if (!accessToken || !refreshToken || !expiresInSeconds) {
    logger.error(
      { type: 'auth.login.invalid_response', requestId },
      'Backend returned invalid login response'
    );
    throw new UpstreamError('invalid_response', 'Backend returned invalid response');
  }

  // userId 從 access token sub claim 取出（RFC 7519；backend schema 無 user_id 欄位）
  let userId: string;
  try {
    userId = readAccessTokenClaims(accessToken).sub;
  } catch (err) {
    logger.error(
      {
        type: 'auth.login.invalid_access_jwt',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Backend returned invalid access token JWT (upstream contract violation)'
    );
    throw new UpstreamError('invalid_access_jwt', 'Backend access token missing sub claim');
  }

  // 從 refresh token JWT 取出 abs_exp（spec §11.1 — malformed 視為後端契約異常 502）
  let absoluteExpiresAt: number;
  try {
    const claims = readJwtClaims(refreshToken);
    absoluteExpiresAt = claims.abs_exp * 1000; // unix seconds → ms
  } catch (err) {
    logger.error(
      {
        type: 'auth.login.invalid_refresh_jwt',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Backend returned invalid refresh token JWT (upstream contract violation)'
    );
    throw new UpstreamError('invalid_refresh_jwt', 'Backend refresh token missing abs_exp claim');
  }

  // Session fixation 防護（§3.1 step 5）：先 best-effort 刪除 incoming sid，再產生新 sid。
  // 不論 incomingSid 格式合法與否都刪 — 攻擊者可能預植任意值。
  if (incomingSid) {
    try {
      await redis.del(`session:${incomingSid}`);
    } catch (err) {
      logger.warn(
        {
          type: 'auth.login.fixation_cleanup_failed',
          error: err instanceof Error ? err.message : String(err),
          requestId,
        },
        'Failed to clear pre-existing session; continuing with new sid'
      );
    }
  }

  const sessionId = generateSessionId();

  // 建立 session data
  const session: SessionData = {
    userId,
    clientId: config.api.clientId,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    absoluteExpiresAt,
    createdAt: Date.now(),
  };

  // 存儲到 Redis
  await storeSession(sessionId, session);

  logger.info(
    {
      type: 'auth.login.success',
      userId,
      clientId: config.api.clientId,
      absoluteExpiresAt,
      requestId,
    },
    'User logged in successfully'
  );

  // 5. 回傳
  return {
    userId,
    sessionId,
    absoluteExpiresAt,
  };
}
