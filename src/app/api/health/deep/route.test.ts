import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HealthResponse } from '@/lib/health/checks';

// deep route handler 為薄包裝：呼叫 getDeepHealth 再映射 HTTP 狀態 + headers。
// apiServer timeout / root-path / parallel 等檢查層行為由 checks.test.ts 覆蓋（spec 01 §9.5）；
// 本檔只測 route handler 自身責任：狀態碼映射、Cache-Control、不洩漏內部錯誤。
const getDeepHealth = vi.fn<() => Promise<HealthResponse>>();

vi.mock('@/lib/health/checks', () => ({
  getDeepHealth: () => getDeepHealth(),
}));

const { GET } = await import('./route');

function makeBody(redis: 'ok' | 'error', apiServer: 'ok' | 'error'): HealthResponse {
  const isHealthy = redis === 'ok' && apiServer === 'ok';
  return {
    status: isHealthy ? 'ok' : 'unhealthy',
    version: 'v1.2.3',
    timestamp: '2026-06-29T00:00:00.000Z',
    checks: {
      redis:
        redis === 'ok'
          ? { status: 'ok', latencyMs: 1 }
          : { status: 'error', error: 'down', latencyMs: 2000 },
      apiServer:
        apiServer === 'ok'
          ? { status: 'ok', latencyMs: 5 }
          : { status: 'error', error: 'HTTP 500', latencyMs: 50 },
    },
  };
}

describe('GET /api/health/deep (spec 01 §9.5)', () => {
  beforeEach(() => {
    getDeepHealth.mockReset();
  });

  it('should return 200 when both redis and apiServer are reachable', async () => {
    getDeepHealth.mockResolvedValue(makeBody('ok', 'ok'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('should return 503 when redis ping fails', async () => {
    getDeepHealth.mockResolvedValue(makeBody('error', 'ok'));
    expect((await GET()).status).toBe(503);
  });

  it('should return 503 when apiServer health endpoint returns 5xx', async () => {
    getDeepHealth.mockResolvedValue(makeBody('ok', 'error'));
    expect((await GET()).status).toBe(503);
  });

  it('should return mixed status (redis ok, apiServer fail) as 503 unhealthy', async () => {
    getDeepHealth.mockResolvedValue(makeBody('ok', 'error'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('unhealthy');
  });

  it('should set Cache-Control no-store', async () => {
    getDeepHealth.mockResolvedValue(makeBody('ok', 'ok'));
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('should NOT include error.stack / error.cause in unhealthy response (info leak)', async () => {
    getDeepHealth.mockResolvedValue(makeBody('error', 'error'));
    const raw = JSON.stringify(await (await GET()).json());
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('cause');
  });
});
