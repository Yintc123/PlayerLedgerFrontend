import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 配置和 redis 模块
vi.mock('@/lib/config', () => ({
  config: {
    redis: { host: 'localhost', port: 6379, password: '' },
  },
}))

vi.mock('@/lib/session/redis', () => {
  const mockEval = vi.fn()
  return {
    redis: { eval: mockEval },
  }
})

vi.mock('@/lib/logger/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// 在 mock 之後導入
import { checkLimit, tooManyRequests } from './limiter'
import { redis } from '@/lib/session/redis'

describe('rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('checkLimit()', () => {
    it('should allow request within limit', async () => {
      vi.mocked(redis.eval).mockResolvedValue([1, 60] as any)

      const result = await checkLimit('test-key', 10, 60)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(9)
      expect(result.retryAfterSeconds).toBeUndefined()
    })

    it('should block request exceeding limit', async () => {
      vi.mocked(redis.eval).mockResolvedValue([11, 45] as any)

      const result = await checkLimit('test-key', 10, 60)

      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterSeconds).toBe(45)
    })

    it('should calculate resetAt timestamp correctly', async () => {
      vi.mocked(redis.eval).mockResolvedValue([1, 60] as any)

      const result = await checkLimit('test-key', 10)

      expect(result.resetAt).toBeGreaterThan(Date.now())
      expect(result.resetAt).toBeLessThanOrEqual(Date.now() + 61000)
    })

    it('should use provided window seconds', async () => {
      vi.mocked(redis.eval).mockResolvedValue([1, 30] as any)

      const result = await checkLimit('test-key', 5, 30)

      expect(vi.mocked(redis.eval)).toHaveBeenCalledWith(
        expect.stringContaining('EXPIRE'),
        1,
        'test-key',
        30,
      )
    })

    it('should throw on Redis error', async () => {
      vi.mocked(redis.eval).mockRejectedValue(new Error('Redis error'))

      await expect(checkLimit('test-key', 10)).rejects.toThrow('Redis error')
    })

    it('should handle TTL of -1 by using window seconds', async () => {
      vi.mocked(redis.eval).mockResolvedValue([1, -1] as any)

      const result = await checkLimit('test-key', 10, 60)

      expect(result.remaining).toBe(9)
    })
  })

  describe('tooManyRequests()', () => {
    it('should return 429 response with Retry-After header', () => {
      const result = tooManyRequests({ allowed: false, remaining: 0, resetAt: Date.now() + 30000, retryAfterSeconds: 30 })

      expect(result.status).toBe(429)
      expect(result.headers.get('Retry-After')).toBe('30')
      expect(result.headers.get('Content-Type')).toBe('application/json')
    })

    it('should include rate limit info in JSON body', async () => {
      const result = tooManyRequests({ allowed: false, remaining: 0, resetAt: Date.now() + 30000, retryAfterSeconds: 30 })

      const body = JSON.parse(await result.text())
      expect(body.error).toBe('too_many_requests')
      expect(body.retryAfter).toBe(30)
    })

    it('should default Retry-After to 60 if not provided', () => {
      const result = tooManyRequests({ allowed: false, remaining: 0, resetAt: Date.now() + 60000, retryAfterSeconds: undefined })

      expect(result.headers.get('Retry-After')).toBe('60')
    })
  })
})
