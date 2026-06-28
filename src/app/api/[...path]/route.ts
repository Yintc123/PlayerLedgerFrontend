import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/session/session';
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie';
import { config } from '@/lib/config';
import { getRequestLogger } from '@/lib/logger/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 支援的 HTTP methods
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx);
}

const HOP_BY_HOP_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
];

/**
 * BFF Proxy Handler（§4.2-§4.3）
 * 轉發請求至上游 API Server，處理 auth / headers / error
 */
async function handleProxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const requestId = req.headers.get('X-Request-ID') || crypto.randomUUID();
  const reqLogger = getRequestLogger(requestId);

  try {
    // 步驟 1: 取得有效 access token
    const params = await ctx.params;
    const path = params.path;

    // 驗證 path 不為空
    if (!path || path.length === 0 || path.some((p) => !p)) {
      return NextResponse.json({ error: 'invalid_path', requestId }, { status: 400 });
    }

    // 步驟 2: 身份驗證
    const accessToken = await getValidAccessToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);

    if (!accessToken) {
      reqLogger.error({ type: 'auth.proxy.unauthenticated' }, 'No valid access token');
      return NextResponse.json({ error: 'unauthenticated', requestId }, { status: 401 });
    }

    // 步驟 3: 檢查 body 大小（1 MB 上限）
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
      return NextResponse.json({ error: 'payload_too_large', requestId }, { status: 413 });
    }

    // 步驟 4: 讀取 body（spec §4.2 — DELETE 也支援 body 透傳）
    let body: string | undefined;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      body = await req.text();
      if (body === '') body = undefined;
    }

    // 步驟 5: 組合 upstream URL
    const upstreamUrl = `${config.api.baseUrl}${config.api.basePath}/${path.join('/')}${req.nextUrl.search}`;

    // 步驟 6: 準備 headers（白名單轉發）
    const upstreamHeaders = new Headers();

    // 從 browser 轉發
    if (req.headers.get('content-type')) {
      upstreamHeaders.set('Content-Type', req.headers.get('content-type')!);
    }
    if (req.headers.get('accept')) {
      upstreamHeaders.set('Accept', req.headers.get('accept')!);
    }
    if (req.headers.get('accept-language')) {
      upstreamHeaders.set('Accept-Language', req.headers.get('accept-language')!);
    }
    if (req.headers.get('accept-encoding')) {
      upstreamHeaders.set('Accept-Encoding', req.headers.get('accept-encoding')!);
    }

    // BFF 自行加入（spec 01 §4.2）
    upstreamHeaders.set('Authorization', `Bearer ${accessToken}`);
    upstreamHeaders.set('X-Request-ID', requestId);

    // traceparent / tracestate：W3C Trace Context（spec 01 §4.2 + 03-observability §4.6）
    // 優先用 OTel propagation.inject() 注入 BFF 自己 span 的 context；SDK 未初始化或無法 import 時
    // 回退到 passthrough，至少維持鏈完整。
    if (process.env.OTEL_SDK_DISABLED !== 'true') {
      try {
        const { context, propagation } = await import('@opentelemetry/api');
        propagation.inject(context.active(), upstreamHeaders, {
          set: (carrier: Headers, key: string, value: string) => carrier.set(key, value),
        });
      } catch {
        // OTel 未安裝時略過
      }
    }
    if (!upstreamHeaders.get('traceparent') && req.headers.get('traceparent')) {
      upstreamHeaders.set('traceparent', req.headers.get('traceparent')!);
    }
    if (!upstreamHeaders.get('tracestate') && req.headers.get('tracestate')) {
      upstreamHeaders.set('tracestate', req.headers.get('tracestate')!);
    }

    // X-Forwarded-For append（spec 01 §4.2 + ADR 011）
    // peer IP 來源依優先順序：incoming XFF 最後一段 → x-real-ip → 無 XFF 則不寫入
    const existingXff = req.headers.get('x-forwarded-for');
    const lastXffSegment = existingXff?.split(',').pop()?.trim();
    const peerIp = lastXffSegment || req.headers.get('x-real-ip') || '';

    if (existingXff && peerIp) {
      upstreamHeaders.set('X-Forwarded-For', `${existingXff}, ${peerIp}`);
    } else if (peerIp) {
      upstreamHeaders.set('X-Forwarded-For', peerIp);
    }
    // 無 XFF 且無 x-real-ip 時不寫入，避免偽造 127.0.0.1 之類的虛構 peer

    // 步驟 7: 呼叫上游 API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.api.timeoutMs);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body,
        signal: AbortSignal.any([req.signal, controller.signal]),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // 步驟 8: 處理 response（header + body 轉發）
    const responseBody = await upstreamResponse.text();

    const responseHeaders = new Headers();

    // 轉發允許的 headers
    if (upstreamResponse.headers.get('content-type')) {
      responseHeaders.set('Content-Type', upstreamResponse.headers.get('content-type')!);
    }
    if (upstreamResponse.headers.get('cache-control')) {
      responseHeaders.set('Cache-Control', upstreamResponse.headers.get('cache-control')!);
    }
    if (upstreamResponse.headers.get('x-request-id')) {
      responseHeaders.set('X-Request-ID', upstreamResponse.headers.get('x-request-id')!);
    }
    if (upstreamResponse.headers.get('retry-after')) {
      responseHeaders.set('Retry-After', upstreamResponse.headers.get('retry-after')!);
    }

    // 丟棄 hop-by-hop headers
    HOP_BY_HOP_HEADERS.forEach((header) => {
      responseHeaders.delete(header);
    });

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // 處理特定錯誤
    if (err instanceof Error && err.name === 'AbortError') {
      reqLogger.error({ type: 'proxy.timeout' }, 'Upstream timeout');
      return NextResponse.json(
        {
          error: 'upstream_timeout',
          requestId,
          message: 'upstream did not respond within the allowed time',
        },
        { status: 504 }
      );
    }

    // 網路錯誤
    reqLogger.error({ type: 'proxy.network_error', error: errMsg }, 'Upstream network error');
    return NextResponse.json({ error: 'upstream_failure', requestId }, { status: 502 });
  }
}
