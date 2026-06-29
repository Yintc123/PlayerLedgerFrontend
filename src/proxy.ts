import { NextRequest, NextResponse } from 'next/server';
import { verifySession, type SessionData } from '@/lib/session/session';
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie';
import { checkLimit, tooManyRequests } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/client-ip';
import { metric } from '@/lib/observability/metrics';
import { config as appConfig } from '@/lib/config';
import { logger } from '@/lib/logger/logger';

// 不需要 session 即可存取的公開路徑（exact match，避免前綴誤判，詳見 ADR 007）
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/register', // spec 12 §3.1：UI route，不需 session
  '/api/login',
  '/api/logout',
  '/api/register', // §3.6 passthrough，無對應 UI，仍受 CSRF + rate limit 保護
  '/api/health', // liveness（ECS Target Group / docker HEALTHCHECK）— ADR 022
  '/api/health/ready', // readiness：Redis 依賴檢查（dashboard / 監控，非 ECS）— ADR 022
  '/api/health/deep', // deep health（CD smoke test）— ADR 012 / 022
  '/api/client-errors', // frontend error boundary 回報 — 03-observability §6.1
  '/api/csp-report', // CSP 違規回報 — spec 01 §10.3
  '/api/vitals', // Web Vitals beacon — 03-observability §6.1
]);

// 須做 CSRF Origin check 的方法（state-changing）— ADR 013
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function loginUrl(request: NextRequest, withRedirect: boolean): URL {
  const url = new URL('/login', request.url);
  if (withRedirect) url.searchParams.set('redirect', request.nextUrl.pathname);
  return url;
}

// 驗證規則與後端 pkg/logger/requestid.go 的 isValidRequestID 一致：
// 非空、長度 ≤ 128、僅含可印 ASCII（0x21–0x7E），避免 log injection
function isValidRequestId(id: string): boolean {
  if (!id || id.length > 128) return false;
  for (const char of id) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function isOriginAllowed(request: NextRequest): boolean {
  if (!STATE_CHANGING.has(request.method)) return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  // 拒絕字面 "null"：sandboxed iframe / file:// / data: 等 opaque origin 都會送 Origin: null
  if (origin === 'null') return false;
  return appConfig.app.allowedOrigins.has(origin);
}

export function buildCsp(nonce: string): string {
  // Next.js / React 開發模式（Fast Refresh、callstack 重建等）需要 eval()，
  // 故 dev 才放行 'unsafe-eval'；production build 一律不含，維持嚴格 CSP。
  const scriptSrc =
    process.env.NODE_ENV === 'production'
      ? `script-src 'self' 'nonce-${nonce}'`
      : `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // upgrade-insecure-requests 只在 HTTPS 環境啟用（PoC HTTP-only 時開啟會讓瀏覽器升級 https → 連不到）
    ...(process.env.ENABLE_HSTS === 'true' ? ['upgrade-insecure-requests'] : []),
    'report-uri /api/csp-report',
    'report-to csp-endpoint',
  ].join('; ');
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // 1. CSRF Origin check（先於所有其他檢查，含公開路徑 — login CSRF 防護）
  if (!isOriginAllowed(request)) {
    logger.warn(
      {
        type: 'auth.proxy.csrf_blocked',
        method: request.method,
        path: pathname,
        origin: request.headers.get('origin') ?? null,
      },
      'state-changing request blocked by Origin check'
    );
    metric('auth.proxy.csrf_blocked', 1, 'Count', { method: request.method, path: pathname });
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. 沿用 browser 帶來的合法 X-Request-ID，不合法則靜默產生新的
  const incoming = request.headers.get('X-Request-ID');
  const requestId = incoming && isValidRequestId(incoming) ? incoming : crypto.randomUUID();

  // 3. CSP nonce（每請求新值）— spec 01 §10.3.1
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // 4. Session 驗證（非公開路徑才檢查）
  let session: SessionData | null = null;
  if (!PUBLIC_PATHS.has(pathname)) {
    const sid = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!sid) {
      logger.info(
        { type: 'auth.proxy.redirect', reason: 'no_sid', path: pathname, requestId },
        'redirect to login'
      );
      return NextResponse.redirect(loginUrl(request, true));
    }

    session = await verifySession(sid);
    if (!session) {
      logger.info(
        { type: 'auth.proxy.redirect', reason: 'invalid_session', path: pathname, requestId },
        'redirect to login'
      );
      return NextResponse.redirect(loginUrl(request, true));
    }
  }

  // 5. Rate limit（session 驗證後 / header 注入前；ADR 009 + ADR 011）
  //    高價值寫入端點（login / register）fail-closed，其他 fail-open + metric
  const clientIp = getClientIp(request);
  const isLogin = pathname === '/api/login';
  const isRegister = pathname === '/api/register';
  const isHighValueWrite = isLogin || isRegister;

  let rlKey: string;
  let rlLimit: number;
  let rlRoute: string;

  if (isLogin) {
    rlKey = `login:${clientIp}`;
    rlLimit = 10;
    rlRoute = '/api/login';
  } else if (isRegister) {
    rlKey = `register:${clientIp}`;
    rlLimit = 5;
    rlRoute = '/api/register';
  } else if (pathname === '/api/logout') {
    rlKey = '';
    rlLimit = 0; // 不限流
    rlRoute = '';
  } else if (session) {
    rlKey = `session:${session.userId}`;
    rlLimit = 100;
    rlRoute = pathname;
  } else {
    rlKey = `ip:${clientIp}`;
    rlLimit = 100;
    rlRoute = pathname;
  }

  if (rlLimit > 0) {
    try {
      const r = await checkLimit(rlKey, rlLimit, 60);
      if (!r.allowed) return tooManyRequests(r);
    } catch (err) {
      if (isHighValueWrite) {
        logger.error(
          { err, type: 'ratelimit.fail_closed', route: rlRoute },
          'limiter failed; refusing high-value write'
        );
        metric('ratelimit.fail_closed', 1, 'Count', { route: rlRoute });
        return new Response(JSON.stringify({ error: 'service_unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      logger.warn(
        { err, type: 'ratelimit.fail_open', route: rlRoute },
        'limiter failed; allowing request'
      );
      metric('ratelimit.fail_open', 1, 'Count', { route: rlRoute });
    }
  }

  // 6. 注入下游 request headers（公開與受保護路徑都注入）
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('X-Request-ID', requestId);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', buildCsp(nonce));
  // X-Request-ID 對 client 暴露，供 client log / 客服回報串接（spec 03 §1.1）
  response.headers.set('X-Request-ID', requestId);

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
