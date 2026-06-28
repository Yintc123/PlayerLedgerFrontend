import { redis } from '@/lib/session/redis';
import { logger } from '@/lib/logger/logger';

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
};

/**
 * Rate limiting 實現（ADR 009）
 * 使用 Redis 計數器實現每分鐘限流
 *
 * @param key 限流 key（例：login:192.168.1.1）
 * @param limit 每分鐘限流次數
 * @param windowSeconds 時間窗口（秒），預設 60
 * @returns RateLimitResult
 */
export async function checkLimit(
  key: string,
  limit: number,
  windowSeconds: number = 60
): Promise<RateLimitResult> {
  try {
    // 使用 Lua script 原子操作：
    // 1. INCR key
    // 2. 若新值 == 1，設定 TTL
    // 3. 回傳當前計數 + TTL
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      local ttl = redis.call('TTL', KEYS[1])
      if ttl == -1 then
        ttl = ARGV[1]
      end
      return {current, ttl}
    `;

    const result = (await redis.eval(luaScript, 1, key, windowSeconds)) as [number, number];
    const [current, ttl] = result;
    const remaining = Math.max(0, limit - current);
    const resetAt = Date.now() + ttl * 1000;

    const allowed = current <= limit;

    if (!allowed) {
      logger.warn(
        {
          type: 'ratelimit.hit',
          key,
          current,
          limit,
          ttl,
        },
        'Rate limit exceeded'
      );
    }

    return {
      allowed,
      remaining,
      resetAt,
      retryAfterSeconds: allowed ? undefined : ttl,
    };
  } catch (err) {
    logger.error(
      {
        type: 'ratelimit.error',
        error: err instanceof Error ? err.message : String(err),
        key,
      },
      'Rate limit check failed'
    );
    throw err;
  }
}

/**
 * 生成 429 Too Many Requests 回應
 */
export function tooManyRequests(result: RateLimitResult) {
  return new Response(
    JSON.stringify({
      error: 'too_many_requests',
      message: 'Rate limit exceeded',
      retryAfter: result.retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfterSeconds || 60),
      },
    }
  );
}
