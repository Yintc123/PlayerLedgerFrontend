import { createHash } from 'node:crypto'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'
import { storeSession, generateSessionId, type SessionData } from '@/lib/session/session'
import { redis } from '@/lib/session/redis'
import { readJwtClaims } from './jwt-claims'

export type LoginCredentials = {
  username: string
  password: string
}

export type LoginResponse = {
  userId: string
  sessionId: string
  absoluteExpiresAt: number
}

export class LoginError extends Error {
  constructor(
    public backendError: string,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

export class InvalidCredentialsError extends LoginError {
  constructor(backendError: string) {
    super(backendError, 'Invalid username or password')
    this.name = 'InvalidCredentialsError'
  }
}

// 登入流程（§3.1）
// incomingSid 為 browser 帶來的既有 sid cookie（若有）— 不論合法與否，登入前都會
// DEL session:<incomingSid>，防 session fixation（§3.1 step 5 / §6.2）。
export async function login(
  credentials: LoginCredentials,
  incomingSid?: string,
): Promise<LoginResponse> {
  // 1. 驗證 request body
  if (!credentials.username || credentials.username.length > 128) {
    throw new LoginError('invalid_input', 'Username must be non-empty and ≤ 128 characters')
  }

  if (!credentials.password || credentials.password.length > 256) {
    throw new LoginError('invalid_input', 'Password must be non-empty and ≤ 256 characters')
  }

  // 2. Account lockout check（§6.3）
  const usernameHash = createHash('sha256')
    .update(credentials.username)
    .digest('hex')
    .slice(0, 8)

  const lockoutKey = `login:fail:${usernameHash}`

  // Redis 故障 → fail-closed 503（spec §3.1 / ADR 011）
  let lockoutCount: string | null
  try {
    lockoutCount = await redis.get(lockoutKey)
  } catch (err) {
    logger.error(
      { type: 'auth.login.redis_error', error: err instanceof Error ? err.message : String(err) },
      'Redis failure during lockout check; fail-closed',
    )
    throw new LoginError('service_unavailable', 'Service temporarily unavailable')
  }

  if (lockoutCount && parseInt(lockoutCount, 10) >= 5) {
    let ttl = 900
    try {
      ttl = await redis.ttl(lockoutKey)
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
      'Account locked after 5 failed attempts',
    )
    throw new LoginError('account_locked', 'Account locked due to too many failed login attempts', ttl)
  }

  // 3. 呼叫後端 /auth/login
  const url = `${config.api.baseUrl}${config.api.basePath}/auth/login`
  const requestId = crypto.randomUUID()

  let response: Response
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), config.api.timeoutMs)

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
    })

    clearTimeout(timeoutId)
  } catch (err) {
    logger.error(
      {
        type: 'auth.login.network_error',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Login network error',
    )
    throw new LoginError(
      'upstream_error',
      err instanceof Error ? err.message : 'Network error',
    )
  }

  // 解析回應
  const body = await response.json()

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
    `
    let newCount = 1
    try {
      newCount = (await redis.eval(luaIncrExpire, 1, lockoutKey, '900')) as number
    } catch (err) {
      // Redis 寫入失敗時不阻斷 401 回應（讀路徑已 fail-closed），記 warn 供觀測
      logger.warn(
        {
          type: 'auth.login.lockout_incr_failed',
          error: err instanceof Error ? err.message : String(err),
          requestId,
        },
        'Failed to increment lockout counter',
      )
    }

    const errorCode = body.error || 'invalid_credentials'
    logger.warn(
      {
        type: 'auth.login.failure',
        reason: errorCode,
        usernameHash,
        lockoutCount: newCount,
        requestId,
      },
      'Login failed: invalid credentials',
    )
    throw new InvalidCredentialsError(errorCode)
  }

  // 失敗情況 2：5xx
  if (!response.ok) {
    logger.error(
      {
        type: 'auth.login.upstream_error',
        status: response.status,
        requestId,
      },
      'Login upstream error',
    )
    throw new LoginError('upstream_error', `Backend returned ${response.status}`)
  }

  // 成功登入清除計數
  await redis.del(lockoutKey)

  // 4. 建立 session — 後端契約規定 envelope { success, request_id, data }（spec §7 / §8）
  if (!body.data || typeof body.data !== 'object') {
    logger.error(
      { type: 'auth.envelope.parse_error', requestId },
      'Backend response missing envelope data field (upstream contract violation)',
    )
    throw new LoginError('envelope_missing_data', 'Backend response missing data field')
  }

  const tokenData = body.data
  const accessToken = tokenData.access_token
  const refreshToken = tokenData.refresh_token
  const expiresInSeconds = tokenData.expires_in
  const userId = tokenData.user_id

  if (!accessToken || !refreshToken || !expiresInSeconds || !userId) {
    logger.error(
      { type: 'auth.login.invalid_response', requestId },
      'Backend returned invalid login response',
    )
    throw new LoginError('upstream_error', 'Backend returned invalid response')
  }

  // 從 refresh token JWT 取出 abs_exp（spec §11.1 — malformed 視為後端契約異常 502）
  let absoluteExpiresAt: number
  try {
    const claims = readJwtClaims(refreshToken)
    absoluteExpiresAt = claims.abs_exp * 1000  // unix seconds → ms
  } catch (err) {
    logger.error(
      {
        type: 'auth.login.invalid_refresh_jwt',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Backend returned invalid refresh token JWT (upstream contract violation)',
    )
    throw new LoginError('upstream_error', 'Backend refresh token missing abs_exp claim')
  }

  // Session fixation 防護（§3.1 step 5）：先 best-effort 刪除 incoming sid，再產生新 sid。
  // 不論 incomingSid 格式合法與否都刪 — 攻擊者可能預植任意值。
  if (incomingSid) {
    try {
      await redis.del(`session:${incomingSid}`)
    } catch (err) {
      logger.warn(
        { type: 'auth.login.fixation_cleanup_failed', error: err instanceof Error ? err.message : String(err), requestId },
        'Failed to clear pre-existing session; continuing with new sid',
      )
    }
  }

  const sessionId = generateSessionId()

  // 建立 session data
  const session: SessionData = {
    userId,
    clientId: config.api.clientId,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    absoluteExpiresAt,
    createdAt: Date.now(),
  }

  // 存儲到 Redis
  await storeSession(sessionId, session)

  logger.info(
    {
      type: 'auth.login.success',
      userId,
      clientId: config.api.clientId,
      absoluteExpiresAt,
      requestId,
    },
    'User logged in successfully',
  )

  // 5. 回傳
  return {
    userId,
    sessionId,
    absoluteExpiresAt,
  }
}
