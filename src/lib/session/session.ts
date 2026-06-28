import { redis } from '@/lib/session/redis'
import { config } from '@/lib/config'
import { logger, getRequestLogger } from '@/lib/logger/logger'
import { SESSION_COOKIE_NAME, getCookieOptions } from '@/lib/session/cookie'
import { recordRefreshOutcome } from '@/lib/observability/metrics'

export type SessionData = {
  userId: string
  clientId: string            // 對應後端 client policy（cms-web / public-web / ...）
  accessToken: string
  refreshToken: string
  expiresAt: number           // access token 到期時間（Unix ms）
  absoluteExpiresAt: number   // family abs_exp（Unix ms），rotation 不延長
  createdAt: number           // Unix timestamp（ms）
}

// SessionId 格式驗證：64 個 hex 字元
const SESSION_ID_REGEX = /^[0-9a-f]{64}$/

/**
 * 驗證並取得 session。只做格式驗證 + Redis lookup，不處理 refresh
 * @param sid Session ID
 * @returns SessionData 或 null
 */
export async function verifySession(sid: string | undefined): Promise<SessionData | null> {
  if (!sid) return null

  // 1. 格式驗證（廉價過濾）
  if (!SESSION_ID_REGEX.test(sid)) {
    return null
  }

  // 2. Redis lookup
  try {
    const data = await redis.get(`session:${sid}`)
    if (!data) {
      return null
    }

    return JSON.parse(data) as SessionData
  } catch (err) {
    logger.error(
      { type: 'session.verify.error', error: err instanceof Error ? err.message : String(err) },
      'Failed to verify session',
    )
    return null
  }
}

/**
 * 生成新的 SessionId（256 bits 加密強度隨機值）
 */
export function generateSessionId(): string {
  return crypto.getRandomValues(new Uint8Array(32))
    .reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '')
}

/**
 * 在 Redis 存儲 session
 */
export async function storeSession(
  sid: string,
  session: SessionData,
): Promise<void> {
  const ttlSeconds = Math.min(
    config.session.ttlSeconds,
    Math.floor((session.absoluteExpiresAt - Date.now()) / 1000),
  )

  try {
    await redis.setex(
      `session:${sid}`,
      ttlSeconds,
      JSON.stringify(session),
    )
  } catch (err) {
    logger.error(
      { type: 'session.store.error', error: err instanceof Error ? err.message : String(err) },
      'Failed to store session',
    )
    throw err
  }
}

// CAS 失敗時，refresh 已從後端拿到新 family，但 session 已被 logout 刪掉。
// 必須背景撤銷剛發出的新 refresh token，避免洩漏到 abs_exp（§3.4 step 7）。
// 非阻塞、失敗忽略，不影響使用者請求生命週期。
function revokeRefreshFamily(accessToken: string, refreshToken: string): void {
  const url = `${config.api.baseUrl}${config.api.basePath}/auth/logout`
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(config.api.timeoutMs),
  }).catch((err) => {
    logger.warn(
      { type: 'auth.token.refresh.revoke_failed', error: err instanceof Error ? err.message : String(err) },
      'Failed to revoke newly issued refresh family after CAS abort',
    )
  })
}

/**
 * 刪除 session
 */
export async function deleteSession(sid: string): Promise<void> {
  try {
    await redis.del(`session:${sid}`)
  } catch (err) {
    logger.error(
      { type: 'session.delete.error', error: err instanceof Error ? err.message : String(err) },
      'Failed to delete session',
    )
  }
}

/**
 * 取得有效的 access token（支援自動 refresh + mutex 控制）
 * 實現 §3.4 的完整 token refresh 流程
 *
 * 演算法：
 * 1. 驗證 session 存在
 * 2. 檢查 absoluteExpiresAt（超期直接回 null）
 * 3. 檢查 accessToken 是否即將過期
 * 4. 嘗試搶 refresh mutex
 * 5. 若成功持鎖：執行 refresh，更新 session，釋放鎖
 * 6. 若失敗持鎖：bounded polling 等待持鎖者完成
 */
export async function getValidAccessToken(sid: string | undefined): Promise<string | null> {
  // 步驟 1: 驗證 session
  if (!sid) return null

  const session = await verifySession(sid)
  if (!session) return null

  const now = Date.now()

  // 步驟 2: absoluteExpiresAt 檢查
  if (now >= session.absoluteExpiresAt) {
    await deleteSession(sid)
    return null
  }

  // 步驟 3: 檢查 accessToken 是否還有時間（REFRESH_THRESHOLD）
  if (session.expiresAt - now > config.session.refreshThresholdSeconds * 1000) {
    // 快速路徑：token 還有效，更新 TTL 並回傳
    await refreshSessionTtl(sid, session)
    return session.accessToken
  }

  // 步驟 4: 嘗試搶 refresh mutex
  const lockKey = `refresh_lock:${sid}`
  const lockSet = await redis.set(lockKey, '1', 'NX', 'EX', config.session.refreshLockTtlSeconds)

  if (lockSet) {
    const startedAt = Date.now()
    // 步驟 5: 持鎖者 - 執行 refresh
    try {
      const { refreshTokens } = await import('@/lib/auth/refresh')
      const { accessToken, refreshToken, expiresAt } = await refreshTokens(session.refreshToken)

      // 用 Lua script 確保 CAS（避免 concurrent logout 復活已刪 session）
      const luaScript = `
        if redis.call('EXISTS', KEYS[1]) == 1 then
          redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
          return 1
        else
          return 0
        end
      `

      const newSessionData: SessionData = {
        ...session,
        accessToken,
        refreshToken,
        expiresAt,
      }

      const casResult = await redis.eval(
        luaScript,
        1,
        `session:${sid}`,
        JSON.stringify(newSessionData),
        Math.min(
          config.session.ttlSeconds,
          Math.floor((session.absoluteExpiresAt - now) / 1000),
        ),
      )

      if (!casResult) {
        // Session 已被 logout 刪掉，放棄更新，並背景撤銷剛拿到的新 family（§3.4 step 7）
        logger.info(
          { type: 'session.refresh.cas_failed', sid },
          'Session was deleted during refresh',
        )
        await deleteSession(sid)
        revokeRefreshFamily(accessToken, refreshToken)
        recordRefreshOutcome('session_deleted', Date.now() - startedAt)
        return null
      }

      // 更新 Redis TTL
      await refreshSessionTtl(sid, newSessionData)

      // re-emit Set-Cookie（滑動 Max-Age；OWASP ASVS 3.3.1，spec §3.4 step 7）
      // sid 值不變，只刷新 Max-Age 倒數
      try {
        const { cookies } = await import('next/headers')
        const cookieStore = await cookies()
        const maxAgeSeconds = Math.min(
          config.session.ttlSeconds,
          Math.floor((session.absoluteExpiresAt - Date.now()) / 1000),
        )
        cookieStore.set(SESSION_COOKIE_NAME, sid, getCookieOptions(maxAgeSeconds))
      } catch {
        // 若呼叫端不在 Route Handler context，cookies().set() 會拋出
        // 吞掉不影響 token 回傳，log debug 便於排查
        logger.debug(
          { type: 'session.cookie_reemit.skip', sid },
          'Cannot re-emit Set-Cookie outside Route Handler context',
        )
      }

      logger.info(
        { type: 'auth.token.refresh', isHolder: true, outcome: 'rotated' },
        'Token refreshed (holder)',
      )
      recordRefreshOutcome('rotated', Date.now() - startedAt)

      return accessToken
    } catch (err) {
      const { TokenRefreshError, UpstreamError } = await import('@/lib/auth/refresh')

      if (err instanceof TokenRefreshError) {
        // 401: token 過期、abs_exp 過、重放偵測 → 刪除 session
        await deleteSession(sid)
        logger.error(
          {
            type: 'auth.token.refresh',
            isHolder: true,
            outcome: 'unauthorized',
            backendError: err.backendError,
            failed: true,
          },
          'Token refresh failed: unauthorized',
        )
        const outcome = err.backendError === 'replay_detected'
          ? 'replay_detected'
          : err.backendError === 'absolute_expired' ? 'absolute_expired' : 'expired'
        recordRefreshOutcome(outcome, Date.now() - startedAt)
        return null
      } else if (err instanceof UpstreamError) {
        // 網路錯誤 / 5xx：不刪 session，下次再試
        logger.warn(
          { type: 'auth.token.refresh', isHolder: true, outcome: 'network_error', failed: true },
          'Token refresh network error',
        )
        recordRefreshOutcome('network_error', Date.now() - startedAt)
        return null
      }

      throw err
    } finally {
      // 必須釋放鎖
      await redis.del(lockKey)
    }
  } else {
    // 步驟 6: 等待者 - Bounded polling
    const waiterStartedAt = Date.now()
    const maxWaitMs = (config.session.refreshLockTtlSeconds - 1) * 1000

    while (Date.now() - waiterStartedAt < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 100))

      if (Date.now() >= session.absoluteExpiresAt) {
        logger.info(
          { type: 'auth.token.refresh', isHolder: false, outcome: 'absolute_expired' },
          'Session expired during wait',
        )
        recordRefreshOutcome('absolute_expired', Date.now() - waiterStartedAt)
        return null
      }

      const current = await verifySession(sid)
      if (!current) {
        logger.info(
          { type: 'auth.token.refresh', isHolder: false, outcome: 'session_deleted' },
          'Session deleted during wait',
        )
        recordRefreshOutcome('session_deleted', Date.now() - waiterStartedAt)
        return null
      }

      if (current.accessToken !== session.accessToken) {
        logger.info(
          { type: 'auth.token.refresh', isHolder: false, outcome: 'waited' },
          'Token refreshed (waiter)',
        )
        recordRefreshOutcome('waited', Date.now() - waiterStartedAt)
        return current.accessToken
      }
    }

    logger.warn(
      { type: 'auth.token.refresh', isHolder: false, outcome: 'timeout' },
      'Token refresh wait timeout',
    )
    recordRefreshOutcome('timeout', Date.now() - waiterStartedAt)
    return null
  }
}

/**
 * 更新 session TTL（滑動過期）
 * 在 Route Handler 中呼叫，更新 cookie 的 MaxAge
 */
async function refreshSessionTtl(sid: string, session: SessionData): Promise<void> {
  const ttlSeconds = Math.min(
    config.session.ttlSeconds,
    Math.floor((session.absoluteExpiresAt - Date.now()) / 1000),
  )

  if (ttlSeconds <= 0) {
    return
  }

  try {
    // 更新 Redis TTL
    await redis.expire(`session:${sid}`, ttlSeconds)

    // 更新 Cookie MaxAge（需要在 Route Handler 中呼叫 cookies().set）
    // 此處僅更新 Redis，Cookie 更新由 Route Handler 負責
  } catch (err) {
    logger.warn(
      { type: 'session.ttl_refresh.error', error: err instanceof Error ? err.message : String(err) },
      'Failed to refresh session TTL',
    )
  }
}
