import { NextRequest, NextResponse } from 'next/server'
import { login, LoginError } from '@/lib/auth/login'
import { SESSION_COOKIE_NAME, getCookieOptions } from '@/lib/session/cookie'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID()

  try {
    // 解析 request body
    const body = await request.json()
    const { username, password } = body

    if (!username || !password) {
      return NextResponse.json(
        { error: 'invalid_input' },
        { status: 400, headers: { 'X-Request-ID': requestId } },
      )
    }

    // 執行登入邏輯（傳遞 incoming sid 觸發 session fixation 防護，§3.1 step 5）
    const incomingSid = request.cookies.get(SESSION_COOKIE_NAME)?.value
    const { userId, sessionId, absoluteExpiresAt } = await login({ username, password }, incomingSid)

    // 計算 cookie TTL：min(SESSION_TTL_SECONDS, (absoluteExpiresAt - now) / 1000)
    const secondsUntilAbsExpiry = Math.floor((absoluteExpiresAt - Date.now()) / 1000)
    const cookieTtl = Math.min(config.session.ttlSeconds, secondsUntilAbsExpiry)

    // 設定 HttpOnly Cookie
    const cookieStore = await cookies()
    cookieStore.set(
      SESSION_COOKIE_NAME,
      sessionId,
      getCookieOptions(cookieTtl),
    )

    logger.info(
      { type: 'http.response', status: 200, requestId, userId },
      'Login response',
    )

    // 回應 200 with userId（request_id 僅在 X-Request-ID header，spec §1 + §8）
    return NextResponse.json(
      { userId },
      { status: 200, headers: { 'X-Request-ID': requestId } },
    )
  } catch (err) {
    if (err instanceof LoginError) {
      const statusCode = err.backendError === 'account_locked' ? 429 : 401

      logger.warn(
        {
          type: 'http.response',
          status: statusCode,
          error: err.backendError,
          requestId,
        },
        'Login failed',
      )

      const headers: Record<string, string> = { 'X-Request-ID': requestId }
      if (statusCode === 429 && err.retryAfterSec !== undefined) {
        headers['Retry-After'] = String(err.retryAfterSec)
      }

      return NextResponse.json(
        { error: err.backendError, message: err.message },
        { status: statusCode, headers },
      )
    }

    // 意外錯誤
    logger.error(
      {
        type: 'http.response',
        status: 500,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Login server error',
    )

    return NextResponse.json(
      { error: 'server_error' },
      { status: 500, headers: { 'X-Request-ID': requestId } },
    )
  }
}
