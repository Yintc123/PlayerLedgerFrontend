import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/register — passthrough 至後端 /auth/register（spec 02 §3.6）。
// CSRF Origin check / 5-per-min IP rate limit / fail-closed 由 proxy.ts 處理（已有設定）。
// 此 handler 只負責：剝離 browser-supplied client_id、注入 BFF clientId、轉發、透傳 status。
export async function POST(request: NextRequest) {
  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID()

  try {
    const incoming = await request.json().catch(() => ({}))

    // 攔截 browser-supplied client_id（spec §3.6：禁止繞過 BFF policy）
    const { client_id: _ignore, ...safeBody } = incoming as Record<string, unknown>
    void _ignore
    const upstreamBody = { ...safeBody, client_id: config.api.clientId }

    const url = `${config.api.baseUrl}${config.api.basePath}/auth/register`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(config.api.timeoutMs),
    })

    const responseHeaders: Record<string, string> = { 'X-Request-ID': requestId }
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) responseHeaders['Retry-After'] = retryAfter

    if (response.status === 201 || response.headers.get('content-length') === '0') {
      logger.info({ type: 'auth.register.success', status: response.status, requestId }, 'Register passthrough')
      return new NextResponse(null, { status: response.status, headers: responseHeaders })
    }

    const text = await response.text()
    const contentType = response.headers.get('content-type')
    if (contentType) responseHeaders['Content-Type'] = contentType
    logger.info({ type: 'auth.register.passthrough', status: response.status, requestId }, 'Register response')
    return new NextResponse(text, { status: response.status, headers: responseHeaders })
  } catch (err) {
    logger.error(
      { type: 'auth.register.error', error: err instanceof Error ? err.message : String(err), requestId },
      'Register passthrough failed',
    )
    return NextResponse.json(
      { error: 'upstream_failure' },
      { status: 502, headers: { 'X-Request-ID': requestId } },
    )
  }
}
