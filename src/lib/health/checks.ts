import { healthRedis } from '@/lib/session/redis';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger/logger';

export type HealthCheckResult = {
  status: 'ok' | 'error';
  error?: string;
  latencyMs: number;
};

// Redis 檢查（shallow 用）
export async function checkRedis(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  try {
    const result = await healthRedis.ping();
    const latencyMs = Date.now() - startTime;

    if (result === 'PONG') {
      return { status: 'ok', latencyMs };
    }
    return { status: 'error', error: `Unexpected ping response: ${result}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ type: 'health.redis.error', error, latencyMs }, 'Redis health check failed');
    return { status: 'error', error, latencyMs };
  }
}

// 上游 API Server 檢查（deep 用）
export async function checkApiServer(): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const url = `${config.api.baseUrl}/health/ready`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Request-ID': crypto.randomUUID() },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      return { status: 'ok', latencyMs };
    }

    return { status: 'error', error: `HTTP ${response.status}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    let errorMessage = 'Unknown';

    if (err instanceof Error) {
      errorMessage = err.message || err.name;
    }

    logger.warn(
      { type: 'health.api_server.error', errorMessage, latencyMs },
      'API server health check failed'
    );

    return { status: 'error', error: errorMessage, latencyMs };
  }
}

export type HealthResponse = {
  status: 'ok' | 'unhealthy';
  version?: string;
  timestamp: string;
  checks: Record<string, HealthCheckResult>;
};

// Shallow health check（給 ECS Target Group）
export async function getShallowHealth(): Promise<HealthResponse> {
  const checks = {
    redis: await checkRedis(),
  };

  const isHealthy = checks.redis.status === 'ok';

  return {
    status: isHealthy ? 'ok' : 'unhealthy',
    version: process.env.APP_VERSION,
    timestamp: new Date().toISOString(),
    checks,
  };
}

// Deep health check（給 CD smoke test / dashboard）
export async function getDeepHealth(): Promise<HealthResponse> {
  const [redisCheck, apiCheck] = await Promise.allSettled([checkRedis(), checkApiServer()]);

  const checks = {
    redis:
      redisCheck.status === 'fulfilled'
        ? redisCheck.value
        : { status: 'error' as const, error: 'Rejected', latencyMs: 0 },
    apiServer:
      apiCheck.status === 'fulfilled'
        ? apiCheck.value
        : { status: 'error' as const, error: 'Rejected', latencyMs: 0 },
  };

  const isHealthy = checks.redis.status === 'ok' && checks.apiServer.status === 'ok';

  return {
    status: isHealthy ? 'ok' : 'unhealthy',
    version: process.env.APP_VERSION,
    timestamp: new Date().toISOString(),
    checks,
  };
}
