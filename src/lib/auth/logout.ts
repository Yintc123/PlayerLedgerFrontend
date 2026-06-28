import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'
import { deleteSession, verifySession } from '@/lib/session/session'

/**
 * 登出流程（§3.2）
 * 1. 驗證 session
 * 2. 呼叫後端 logout endpoint
 * 3. 刪除 session
 * 4. 清除 cookie
 *
 * 注意：後端 logout 失敗時仍繼續清除 BFF session（fail-open）
 */
export async function logout(sid: string | undefined): Promise<void> {
  if (!sid) {
    // 無 session 可清，直接回傳成功
    return
  }

  const requestId = crypto.randomUUID()

  try {
    // 驗證 session 存在
    const session = await verifySession(sid)

    if (session) {
      // 呼叫後端 logout（fail-safe：失敗也繼續）
      try {
        const url = `${config.api.baseUrl}${config.api.basePath}/auth/logout`
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.accessToken}`,
            'X-Request-ID': requestId,
          },
          body: JSON.stringify({
            refresh_token: session.refreshToken,
          }),
          signal: AbortSignal.timeout(config.api.timeoutMs),
        })
      } catch (err) {
        // 後端 logout 失敗時只記 log，不中斷流程
        logger.warn(
          {
            type: 'auth.logout.upstream_failure',
            error: err instanceof Error ? err.message : String(err),
            requestId,
          },
          'Backend logout failed (continuing)',
        )
      }
    }

    // 刪除 BFF session（always）
    await deleteSession(sid)

    logger.info(
      { type: 'auth.logout', userId: session?.userId, requestId },
      'User logged out',
    )
  } catch (err) {
    logger.error(
      {
        type: 'auth.logout.error',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Logout error',
    )
  }
}
