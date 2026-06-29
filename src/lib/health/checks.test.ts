import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock before importing checks - all mocks must be defined inline
vi.mock('@/lib/config', () => ({
  config: {
    api: {
      baseUrl: 'http://localhost:8080',
      basePath: '/api',
      clientId: 'cms-web',
      timeoutMs: 20000,
    },
    redis: {
      host: 'localhost',
      port: 6379,
      db: 0,
    },
    session: {},
    app: {},
    isProd: false,
  },
}));

vi.mock('@/lib/session/redis', () => {
  const mockHealthRedis = { ping: vi.fn() };
  return {
    redis: { ping: vi.fn() },
    healthRedis: mockHealthRedis,
  };
});

vi.mock('@/lib/logger/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { checkRedis, checkApiServer, getLiveness, getReadiness, getDeepHealth } from './checks';
import { healthRedis } from '@/lib/session/redis';

describe('Health Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('checkRedis', () => {
    it('should return status ok when redis ping succeeds', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      const result = await checkRedis();
      expect(result.status).toBe('ok');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('should return status error when redis ping fails', async () => {
      vi.mocked(healthRedis.ping).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await checkRedis();
      expect(result.status).toBe('error');
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should include latencyMs in response', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      const result = await checkRedis();
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      vi.mocked(healthRedis.ping).mockRejectedValueOnce(timeoutError);
      const result = await checkRedis();
      expect(result.status).toBe('error');
      expect(result.error).toContain('Timeout');
    });
  });

  describe('checkApiServer', () => {
    it('should return status ok when API server responds 200', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const result = await checkApiServer();
      expect(result.status).toBe('ok');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return status error when API server returns 5xx', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const result = await checkApiServer();
      expect(result.status).toBe('error');
      expect(result.error).toContain('503');
    });

    it('should return status error on network error', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await checkApiServer();
      expect(result.status).toBe('error');
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should call API with correct URL', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await checkApiServer();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/health/ready',
        expect.any(Object)
      );
    });
  });

  describe('getLiveness', () => {
    it('should return status ok without checking any dependency', () => {
      const health = getLiveness();

      expect(health.status).toBe('ok');
      expect(health.timestamp).toBeDefined();
    });

    it('should NOT query Redis (liveness is dependency-free, ADR 022)', () => {
      getLiveness();

      expect(healthRedis.ping).not.toHaveBeenCalled();
    });

    it('should NOT call upstream API server', () => {
      vi.mocked(global.fetch).mockClear();

      getLiveness();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should omit the checks field (no dependency checks performed)', () => {
      const health = getLiveness();

      expect(health.checks).toBeUndefined();
    });
  });

  describe('getReadiness', () => {
    it('should return status ok when redis is healthy', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      const health = await getReadiness();

      expect(health.status).toBe('ok');
      expect(health.checks?.redis.status).toBe('ok');
      expect(health.timestamp).toBeDefined();
    });

    it('should return status unhealthy when redis fails', async () => {
      vi.mocked(healthRedis.ping).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const health = await getReadiness();

      expect(health.status).toBe('unhealthy');
      expect(health.checks?.redis.status).toBe('error');
    });

    it('should NOT call upstream API server', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockClear();

      await getReadiness();

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should include correct structure', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      const health = await getReadiness();

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('timestamp');
      expect(health).toHaveProperty('checks');
      expect(health.checks).toHaveProperty('redis');
    });
  });

  describe('getDeepHealth', () => {
    it('should return status ok when both redis and apiServer are healthy', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const health = await getDeepHealth();

      expect(health.status).toBe('ok');
      expect(health.checks?.redis.status).toBe('ok');
      expect(health.checks?.apiServer.status).toBe('ok');
    });

    it('should return status unhealthy when redis fails', async () => {
      vi.mocked(healthRedis.ping).mockRejectedValueOnce(new Error('ECONNREFUSED'));
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const health = await getDeepHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.checks?.redis.status).toBe('error');
      expect(health.checks?.apiServer.status).toBe('ok');
    });

    it('should return status unhealthy when apiServer fails', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const health = await getDeepHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.checks?.redis.status).toBe('ok');
      expect(health.checks?.apiServer.status).toBe('error');
    });

    it('should return mixed status as unhealthy', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'));

      const health = await getDeepHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.checks?.redis.status).toBe('ok');
      expect(health.checks?.apiServer.status).toBe('error');
    });

    it('should run checks in parallel', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const startTime = Date.now();
      await getDeepHealth();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(100);
    });

    it('should call apiServer at correct URL', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await getDeepHealth();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8080/health/ready',
        expect.any(Object)
      );
    });

    it('should not include error stack in response', async () => {
      vi.mocked(healthRedis.ping).mockRejectedValueOnce(new Error('Test error with stack'));
      const health = await getDeepHealth();

      expect(JSON.stringify(health)).not.toContain('at ');
    });

    it('should include all required fields', async () => {
      vi.mocked(healthRedis.ping).mockResolvedValueOnce('PONG');
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const health = await getDeepHealth();

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('timestamp');
      expect(health).toHaveProperty('checks');
      expect(health.checks).toHaveProperty('redis');
      expect(health.checks).toHaveProperty('apiServer');
    });
  });
});
