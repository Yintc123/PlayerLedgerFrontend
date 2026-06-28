import { test, expect } from '@playwright/test';

// 所有 state-changing 請求都會被 proxy.ts CSRF Origin check 攔截（ADR 013）；
// 真實瀏覽器送 POST 一定有 Origin header，e2e 透過 request context 需顯式加上。
const ALLOWED_ORIGIN = { Origin: 'http://localhost:3000' };

test.describe('Observability Endpoints', () => {
  test('POST /api/client-errors should accept and log client errors', async ({ request }) => {
    const response = await request.post('/api/client-errors', {
      headers: ALLOWED_ORIGIN,
      data: {
        message: 'Uncaught TypeError in React component',
        stack: 'Error: ...',
        route: '/dashboard',
        userAgent: 'Mozilla/5.0...',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.requestId).toBeDefined();
  });

  test('POST /api/client-errors should validate required fields', async ({ request }) => {
    const response = await request.post('/api/client-errors', {
      headers: ALLOWED_ORIGIN,
      data: {
        // 缺少 message 欄位
        route: '/dashboard',
      },
    });

    expect(response.status()).toBe(400);
  });

  test('POST /api/client-errors should reject oversized payloads', async ({ request }) => {
    const largePayload = {
      message: 'x'.repeat(11 * 1024), // > 10 KB
      route: '/dashboard',
    };

    const response = await request.post('/api/client-errors', {
      headers: ALLOWED_ORIGIN,
      data: largePayload,
    });

    expect(response.status()).toBe(413);
  });

  test('POST /api/vitals should accept Web Vitals metrics', async ({ request }) => {
    const response = await request.post('/api/vitals', {
      headers: ALLOWED_ORIGIN,
      data: {
        name: 'LCP',
        value: 2500,
        id: 'v3-1234567890',
        navigationType: 'navigation',
      },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('POST /api/vitals should accept form-encoded data from sendBeacon', async ({ request }) => {
    const response = await request.post('/api/vitals', {
      headers: { ...ALLOWED_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        name: 'FCP',
        value: '1800',
        id: 'v3-1234567890',
        navigationType: 'navigation',
      }).toString(),
    });

    expect(response.status()).toBe(200);
  });

  test('POST /api/csp-report should accept CSP violation reports', async ({ request }) => {
    const response = await request.post('/api/csp-report', {
      headers: ALLOWED_ORIGIN,
      data: {
        'csp-report': {
          'document-uri': 'https://example.com/dashboard',
          'violated-directive': 'script-src',
          'effective-directive': 'script-src-elem',
          'original-policy': "default-src 'self'",
          'blocked-uri': 'https://malicious.com/evil.js',
          'source-file': 'https://example.com/app.js',
          'line-number': 42,
          'column-number': 10,
          disposition: 'enforce',
        },
      },
    });

    expect(response.status()).toBe(204);
  });

  test('POST /api/csp-report should validate required csp-report field', async ({ request }) => {
    const response = await request.post('/api/csp-report', {
      headers: ALLOWED_ORIGIN,
      data: {
        // 缺少 csp-report
      },
    });

    expect(response.status()).toBe(400);
  });

  test('/api/health should return shallow health status', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('/api/health/deep should perform deep health check', async ({ request }) => {
    const response = await request.get('/api/health/deep');

    // 200 if upstream API reachable; 503 when upstream is down (typical in CI
    // without a backend service). Both are valid handler responses — we只
    // assert that the endpoint exists, returns JSON, and includes `checks`.
    expect([200, 503]).toContain(response.status());
    const body = await response.json();
    expect(body.checks).toBeDefined();
  });

  // Rate-limit 行為由 unit (src/lib/rate-limit/limiter.test.ts + proxy 測試) 覆蓋。
  // e2e 跑 rate limit 需要與 proxy.ts 的 limit 設定耦合（目前 public path = 100/min），
  // 且 Redis 計數會跨 test run 殘留，造成 flaky。從 e2e 移除。
});

test.describe('CSRF Protection', () => {
  test('POST /api/client-errors blocks request with disallowed Origin', async ({ request }) => {
    // ADR 013：所有 state-changing 方法（含 public reporting endpoints）一律走
    // CSRF Origin check；evil.com 不在 ALLOWED_ORIGINS → proxy 直接 403。
    const response = await request.post('/api/client-errors', {
      data: { message: 'Error message' },
      headers: { Origin: 'https://evil.com' },
    });

    expect(response.status()).toBe(403);
  });
});
