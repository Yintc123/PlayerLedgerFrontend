import { describe, it, expect, vi, beforeEach } from 'vitest'
import { metric, recordHttpRequest, recordAuthEvent, recordRateLimit } from './metrics'
import * as loggerModule from '@/lib/logger/logger'

vi.mock('@/lib/logger/logger')

describe('metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('metric()', () => {
    it('should emit EMF-formatted log for valid metrics', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      metric('test.metric', 42, 'Count', { env: 'prod' })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          _aws: expect.objectContaining({
            CloudWatchMetrics: expect.arrayContaining([
              expect.objectContaining({
                Namespace: 'PlayerLedger/Frontend',
                Metrics: expect.arrayContaining([
                  expect.objectContaining({ Name: 'test.metric', Unit: 'Count' }),
                ]),
              }),
            ]),
          }),
          'test.metric': 42,
          env: 'prod',
        }),
        'metric',
      )
    })

    it('should skip NaN values', () => {
      const mockLogger = { warn: vi.fn(), info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      metric('test.metric', NaN)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ metricName: 'test.metric' }),
        expect.stringContaining('NaN'),
      )
      expect(mockLogger.info).not.toHaveBeenCalled()
    })

    it('should handle empty dimensions', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      metric('test.metric', 1, 'Count')

      const call = mockLogger.info.mock.calls[0][0]
      expect(call._aws.CloudWatchMetrics[0].Dimensions).toEqual([])
    })

    it('should include dimension keys in Dimensions array', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      metric('test.metric', 1, 'Count', { route: '/api/login', method: 'POST' })

      const call = mockLogger.info.mock.calls[0][0]
      expect(call._aws.CloudWatchMetrics[0].Dimensions).toEqual([['route', 'method']])
    })
  })

  describe('recordHttpRequest()', () => {
    it('should emit count and duration metrics', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      recordHttpRequest('/api/login', 'POST', '2xx', 150)

      expect(mockLogger.info).toHaveBeenCalledTimes(2)
    })
  })

  describe('recordAuthEvent()', () => {
    it('should emit login success metric', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      recordAuthEvent('login_success', 'mobile-app')

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          _aws: expect.any(Object),
          'auth.login.attempts': 1,
        }),
        'metric',
      )
    })

    it('should emit login failure metric', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      recordAuthEvent('login_failure')

      expect(mockLogger.info).toHaveBeenCalled()
    })
  })

  describe('recordRateLimit()', () => {
    it('should emit rate limit hit metric', () => {
      const mockLogger = { info: vi.fn() }
      vi.spyOn(loggerModule, 'logger', 'get').mockReturnValue(mockLogger as any)

      recordRateLimit('/api/login', 'ip')

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          _aws: expect.any(Object),
          'ratelimit.hit': 1,
        }),
        'metric',
      )
    })
  })
})
