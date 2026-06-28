import { NextResponse } from 'next/server'
import { logout } from '@/lib/auth/logout'
import { SESSION_COOKIE_NAME, getCookieOptions } from '@/lib/session/cookie'
import { logger } from '@/lib/logger/logger'
import { cookies } from 'next/headers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const requestId = crypto.randomUUID()

  try {
    // 從 cookie 取出 sid
    const cookieStore = await cookies()
    const sid = cookieStore.get(SESSION_COOKIE_NAME)?.value

    // 執行登出邏輯
    await logout(sid)

    // 清除 cookie（必須帶與設定時相同的 attributes，否則 __Host- 前綴的清除失效，spec §8）
    cookieStore.set(SESSION_COOKIE_NAME, '', getCookieOptions(0))

    logger.info(
      { type: 'http.response', status: 200, requestId },
      'Logout response',
    )

    // request_id 僅在 X-Request-ID header，不寫入 body（spec §1 + §8）
    return NextResponse.json(
      {},
      { status: 200, headers: { 'X-Request-ID': requestId } },
    )
  } catch (err) {
    logger.error(
      {
        type: 'http.response',
        status: 500,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Logout error',
    )

    return NextResponse.json(
      { error: 'server_error' },
      { status: 500, headers: { 'X-Request-ID': requestId } },
    )
  }
}
