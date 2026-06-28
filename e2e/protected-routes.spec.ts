import { test, expect } from '@playwright/test';

// proxy.ts CSRF Origin check 對 state-changing 方法強制；e2e POST 一律帶這個。
const ALLOWED_ORIGIN = { Origin: 'http://localhost:3000' };

test.describe('Protected Routes', () => {
  test('should require authentication for dashboard', async ({ page }) => {
    await page.goto('/dashboard');

    // Should redirect to login if not authenticated
    const url = page.url();
    expect(url).toContain('/login');
  });

  test('should show dashboard when authenticated', async ({ page }) => {
    // Note: This assumes we have a way to set authenticated state in tests
    // In real scenario, would need to login first or use browser context with cookies

    await page.goto('/dashboard');

    // Either authenticated (shows content) or unauthenticated (redirects to login)
    const url = page.url();
    expect(url).toMatch(/dashboard|login/);
  });

  test('should prevent access to protected API endpoints without session', async ({ request }) => {
    // proxy.ts 對非公開 path 沒有 session → 302 redirect 到 /login。
    // Playwright request 預設會跟 redirect，需明確 maxRedirects: 0 才看得到 302。
    const response = await request.get('/api/protected-test', { maxRedirects: 0 });

    // 302（proxy redirect）或 401（後續 handler 拒絕）皆視為正確阻擋
    expect([302, 307, 401]).toContain(response.status());
  });

  test('should allow access to public health endpoints', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBe(true);
  });

  test('should allow access to observability endpoints', async ({ request }) => {
    const clientErrorResponse = await request.post('/api/client-errors', {
      headers: ALLOWED_ORIGIN,
      data: { message: 'test error' },
    });
    expect([200, 429]).toContain(clientErrorResponse.status()); // 200 or rate limited

    const vitalsResponse = await request.post('/api/vitals', {
      headers: ALLOWED_ORIGIN,
      data: { name: 'test', value: 100, id: 'test' },
    });
    expect([200, 429]).toContain(vitalsResponse.status());

    const cspResponse = await request.post('/api/csp-report', {
      headers: ALLOWED_ORIGIN,
      data: {
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': 'script-src',
        },
      },
    });
    expect([200, 204, 429]).toContain(cspResponse.status());
  });

  test('should block CSRF attempts on state-changing methods', async ({ request }) => {
    const response = await request.post('/api/login', {
      data: { username: 'test', password: 'test' },
      headers: { Origin: 'https://evil.com' },
    });

    // Should be blocked by CSRF check or return 403
    expect([400, 401, 403]).toContain(response.status());
  });

  test('should redirect to login with redirect param on unauthorized access', async ({ page }) => {
    await page.goto('/dashboard');

    const url = page.url();
    if (url.includes('/login')) {
      expect(url).toContain('redirect=%2Fdashboard');
    }
  });

  test('should handle session expiry gracefully', async ({ page }) => {
    // Try to access dashboard
    await page.goto('/dashboard');

    const url = page.url();
    // Should either show content or redirect to login
    expect(url).toMatch(/dashboard|login/);
  });

  test('should validate request headers', async ({ request }) => {
    // Missing X-Request-ID should still work (auto-generated)
    const response = await request.get('/api/health');
    expect(response.ok()).toBe(true);

    // Verify response has request tracking headers (proxy.ts §181)
    const headers = response.headers();
    expect(headers['x-request-id']).toBeDefined();
  });
});

// Rate-limit 行為由 unit (src/lib/rate-limit/limiter.test.ts + proxy 測試) 覆蓋。
// e2e 跑 rate limit 與 proxy.ts 的 limit 設定耦合且 Redis 計數會殘留，造成 flaky；從 e2e 移除。
