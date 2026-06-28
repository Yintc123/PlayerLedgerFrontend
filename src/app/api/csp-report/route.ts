import { NextRequest, NextResponse } from 'next/server';
import { getRequestLogger } from '@/lib/logger/logger';
import { checkLimit, tooManyRequests } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/client-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_SIZE = 5 * 1024; // 5 KB（CSP 報告通常很小）

type CSPViolation = {
  'document-uri': string;
  'violated-directive'?: string;
  'effective-directive'?: string;
  'original-policy'?: string;
  disposition?: string;
  'blocked-uri'?: string;
  'source-file'?: string;
  'line-number'?: number;
  'column-number'?: number;
  'status-code'?: number;
  'disposition-report-only'?: boolean;
};

type CSPReport = {
  'csp-report': CSPViolation;
};

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID();
  const clientIp = getClientIp(request);
  const reqLogger = getRequestLogger(requestId);

  try {
    // 檢查 body 大小
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
    }

    // Rate limit：每個 IP 60/min（spec 03 §6.1）
    const rateLimitKey = `csp-report:ip:${clientIp}`;
    const rateLimit = await checkLimit(rateLimitKey, 60, 60);
    if (!rateLimit.allowed) {
      return tooManyRequests(rateLimit);
    }

    // 解析 JSON
    const body: CSPReport = await request.json();
    const report = body['csp-report'];

    if (!report) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'csp-report field required' },
        { status: 400 }
      );
    }

    // Log 報告（敏感路徑在 redact-paths.ts 中已配置）
    reqLogger.warn(
      {
        type: 'security.csp_violation',
        documentUri: report['document-uri'],
        violatedDirective: report['violated-directive'] || report['effective-directive'],
        blockedUri: report['blocked-uri'],
        sourceFile: report['source-file'],
        lineNumber: report['line-number'],
        columnNumber: report['column-number'],
        statusCode: report['status-code'],
        disposition: report['disposition'],
      },
      'CSP violation reported'
    );

    return NextResponse.json({ success: true }, { status: 204 });
  } catch (err) {
    reqLogger.error(
      {
        type: 'http.response',
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      },
      'CSP report endpoint error'
    );

    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
