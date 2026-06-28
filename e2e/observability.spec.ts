import { test, expect } from '@playwright/test'

test.describe('Observability Endpoints', () => {
  test('POST /api/client-errors should accept and log client errors', async ({ request }) => {
    const response = await request.post('/api/client-errors', {
      data: {
        message: 'Uncaught TypeError in React component',
        stack: 'Error: ...',
        route: '/dashboard',
        userAgent: 'Mozilla/5.0...',
      },
    })

    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.requestId).toBeDefined()
  })

  test('POST /api/client-errors should validate required fields', async ({ request }) => {
    const response = await request.post('/api/client-errors', {
      data: {
        // 缺少 message 欄位
        route: '/dashboard',
      },
    })

    expect(response.status()).toBe(400)
  })

  test('POST /api/client-errors should reject oversized payloads', async ({ request }) => {
    const largePayload = {
      message: 'x'.repeat(11 * 1024), // > 10 KB
      route: '/dashboard',
    }

    const response = await request.post('/api/client-errors', {
      data: largePayload,
    })

    expect(response.status()).toBe(413)
  })

  test('POST /api/vitals should accept Web Vitals metrics', async ({ request }) => {
    const response = await request.post('/api/vitals', {
      data: {
        name: 'LCP',
        value: 2500,
        id: 'v3-1234567890',
        navigationType: 'navigation',
      },
    })

    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
  })

  test('POST /api/vitals should accept form-encoded data from sendBeacon', async ({ request }) => {
    const response = await request.post('/api/vitals', {
      data: new URLSearchParams({
        name: 'FCP',
        value: '1800',
        id: 'v3-1234567890',
        navigationType: 'navigation',
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    expect(response.status()).toBe(200)
  })

  test('POST /api/csp-report should accept CSP violation reports', async ({ request }) => {
    const response = await request.post('/api/csp-report', {
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
          'disposition': 'enforce',
        },
      },
    })

    expect(response.status()).toBe(204)
  })

  test('POST /api/csp-report should validate required csp-report field', async ({ request }) => {
    const response = await request.post('/api/csp-report', {
      data: {
        // 缺少 csp-report
      },
    })

    expect(response.status()).toBe(400)
  })

  test('/api/health should return shallow health status', async ({ request }) => {
    const response = await request.get('/api/health')

    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  test('/api/health/deep should perform deep health check', async ({ request }) => {
    const response = await request.get('/api/health/deep')

    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.checks).toBeDefined()
  })

  test('Rate limiting should work on /api/client-errors', async ({ request }) => {
    // 快速發送多個請求以觸發 rate limit
    const promises = []
    for (let i = 0; i < 35; i++) {
      promises.push(
        request.post('/api/client-errors', {
          data: { message: `Error ${i}` },
        }),
      )
    }

    const responses = await Promise.all(promises)

    // 前 30 個應該成功（限制是 30/min）
    const successCount = responses.filter(r => r.status() === 200).length
    const rateLimitCount = responses.filter(r => r.status() === 429).length

    expect(successCount).toBeGreaterThanOrEqual(30)
    expect(rateLimitCount).toBeGreaterThan(0)
  })
})

test.describe('CSRF Protection', () => {
  test('POST to /api/client-errors should work without CSRF check (reporting endpoint)', async ({ request }) => {
    const response = await request.post('/api/client-errors', {
      data: { message: 'Error message' },
      headers: { 'Origin': 'https://evil.com' },
    })

    // 報告端點不檢查 CSRF
    expect(response.status()).not.toBe(403)
  })
})
