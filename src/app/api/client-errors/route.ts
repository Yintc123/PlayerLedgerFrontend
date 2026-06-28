import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger/logger';
import { checkLimit, tooManyRequests } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/client-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_SIZE = 10 * 1024; // 10 KB

type ClientErrorReport = {
  message: string;
  stack?: string;
  fingerprint?: string;
  route?: string;
  userAgent?: string;
};

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID();
  const clientIp = getClientIp(request);

  try {
    // 檢查 body 大小
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return NextResponse.json({ error: 'payload_too_large', requestId }, { status: 413 });
    }

    // Rate limit：每個 session / IP 30/min
    // 若無 session，用 IP 限流
    const sid = request.cookies.get('__Host-sid')?.value || request.cookies.get('sid')?.value;
    const rateLimitKey = sid ? `client-errors:${sid}` : `client-errors:ip:${clientIp}`;

    const rateLimit = await checkLimit(rateLimitKey, 30, 60);
    if (!rateLimit.allowed) {
      return tooManyRequests(rateLimit);
    }

    // 解析 request body
    const body: ClientErrorReport = await request.json();

    // 驗證必要欄位
    if (!body.message) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'message field required' },
        { status: 400 }
      );
    }

    // Log 錯誤（含 PII redaction）
    logger.error(
      {
        type: 'client.error.report',
        fingerprint: body.fingerprint,
        route: body.route,
        userAgent: body.userAgent,
        message: body.message,
        // stack 不記 log（可能含 PII）
        requestId,
      },
      'Client-side error reported'
    );

    return NextResponse.json({ success: true, requestId }, { status: 200 });
  } catch (err) {
    logger.error(
      {
        type: 'http.response',
        status: 500,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Client errors endpoint error'
    );

    return NextResponse.json({ error: 'server_error', requestId }, { status: 500 });
  }
}
