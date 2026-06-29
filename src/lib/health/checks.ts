import { healthRedis } from '@/lib/session/redis';
import { config } from '@/lib/config';
import { logger } from '@/lib/logger/logger';

export type HealthCheckResult = {
  status: 'ok' | 'error';
  error?: string;
  latencyMs: number;
};

// Redis 檢查（readiness / deep 用）
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
  // liveness 不查任何依賴，故無 checks；readiness / deep 才有
  checks?: Record<string, HealthCheckResult>;
};

// Liveness（給 ECS Target Group / Docker HEALTHCHECK）
// 只證明 Node.js process 還活著、event loop 還能回應 HTTP，不查任何依賴。
// 刻意與 Redis 解耦：Redis 抖動不應觸發 ECS 連鎖替換 task（ADR 022 取代 ADR 012 的 shallow 設計）。
// 永遠回 200；process 真的死掉時根本無法回應，ECS 自會判定 unhealthy。
export function getLiveness(): HealthResponse {
  return {
    status: 'ok',
    version: process.env.APP_VERSION,
    timestamp: new Date().toISOString(),
  };
}

// Readiness（給內部依賴監控 / dashboard）
// 檢查 BFF 的內部依賴 Redis。失敗 → 503，但**不**供 ECS Target Group 使用，
// 故不觸發 task 替換；改由 `health.readiness.failure` metric + alarm 處理（spec 03 §3.3）。
export async function getReadiness(): Promise<HealthResponse> {
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
