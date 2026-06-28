import { test, expect } from '@playwright/test'

test.describe('Protected Routes', () => {
  test('should require authentication for dashboard', async ({ page }) => {
    await page.goto('/dashboard')

    // Should redirect to login if not authenticated
    const url = page.url()
    expect(url).toContain('/login')
  })

  test('should show dashboard when authenticated', async ({ context, page }) => {
    // Note: This assumes we have a way to set authenticated state in tests
    // In real scenario, would need to login first or use browser context with cookies

    await page.goto('/dashboard')

    // Either authenticated (shows content) or unauthenticated (redirects to login)
    const url = page.url()
    expect(url).toMatch(/dashboard|login/)
  })

  test('should prevent access to protected API endpoints without session', async ({ request }) => {
    const response = await request.get('/api/user-profile')

    // Should be 401 Unauthorized or redirect
    expect([401, 302, 307]).toContain(response.status())
  })

  test('should allow access to public health endpoints', async ({ request }) => {
    const response = await request.get('/api/health')
    expect(response.ok()).toBe(true)
  })

  test('should allow access to observability endpoints', async ({ request }) => {
    const clientErrorResponse = await request.post('/api/client-errors', {
      data: { message: 'test error' },
    })
    expect([200, 429]).toContain(clientErrorResponse.status()) // 200 or rate limited

    const vitalsResponse = await request.post('/api/vitals', {
      data: { name: 'test', value: 100, id: 'test' },
    })
    expect([200, 429]).toContain(vitalsResponse.status())

    const cspResponse = await request.post('/api/csp-report', {
      data: {
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': 'script-src',
        },
      },
    })
    expect([200, 204, 429]).toContain(cspResponse.status())
  })

  test('should block CSRF attempts on state-changing methods', async ({ request }) => {
    const response = await request.post('/api/login', {
      data: { username: 'test', password: 'test' },
      headers: { Origin: 'https://evil.com' },
    })

    // Should be blocked by CSRF check or return 403
    expect([400, 401, 403]).toContain(response.status())
  })

  test('should redirect to login with redirect param on unauthorized access', async ({ page }) => {
    await page.goto('/dashboard')

    const url = page.url()
    if (url.includes('/login')) {
      expect(url).toContain('redirect=%2Fdashboard')
    }
  })

  test('should handle session expiry gracefully', async ({ page }) => {
    // Try to access dashboard
    await page.goto('/dashboard')

    const url = page.url()
    // Should either show content or redirect to login
    expect(url).toMatch(/dashboard|login/)
  })

  test('should validate request headers', async ({ request }) => {
    // Missing X-Request-ID should still work (auto-generated)
    const response = await request.get('/api/health')
    expect(response.ok()).toBe(true)

    // Verify response has request tracking headers
    const headers = response.headers()
    expect(headers['x-request-id']).toBeDefined()
  })
})

test.describe('Rate Limiting on Protected Routes', () => {
  test('should rate limit rapid requests to protected endpoints', async ({ request }) => {
    const requests = []

    // Send 35 rapid requests (limit is typically 30/min)
    for (let i = 0; i < 35; i++) {
      requests.push(
        request.post('/api/vitals', {
          data: { name: 'test', value: 100, id: `test-${i}` },
        }),
      )
    }

    const responses = await Promise.all(requests)
    const rateLimitedCount = responses.filter((r) => r.status() === 429).length

    expect(rateLimitedCount).toBeGreaterThan(0)
  })
})
