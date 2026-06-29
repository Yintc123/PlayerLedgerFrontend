import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HealthResponse } from '@/lib/health/checks';

// readiness route handler 為薄包裝：呼叫 getReadiness 再映射 HTTP 狀態 + headers。
// Redis timeout / socket release 等檢查層行為由 checks.test.ts 覆蓋（spec 01 §9.5）；
// 本檔只測 route handler 自身責任：狀態碼映射、Cache-Control、version 透傳、不洩漏內部錯誤。
const getReadiness = vi.fn<() => Promise<HealthResponse>>();

vi.mock('@/lib/health/checks', () => ({
  getReadiness: () => getReadiness(),
}));

const { GET } = await import('./route');

const okBody: HealthResponse = {
  status: 'ok',
  version: 'v1.2.3',
  timestamp: '2026-06-29T00:00:00.000Z',
  checks: { redis: { status: 'ok', latencyMs: 1 } },
};

describe('GET /api/health/ready (readiness, spec 01 §9.5)', () => {
  beforeEach(() => {
    getReadiness.mockReset();
  });

  it('should return 200 when redis is reachable', async () => {
    getReadiness.mockResolvedValue(okBody);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('should return 503 when redis ping fails', async () => {
    getReadiness.mockResolvedValue({
      status: 'unhealthy',
      timestamp: '2026-06-29T00:00:00.000Z',
      checks: { redis: { status: 'error', error: 'connection refused', latencyMs: 2000 } },
    });
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('unhealthy');
  });

  it('should set Cache-Control no-store to prevent stale health responses', async () => {
    getReadiness.mockResolvedValue(okBody);
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should include version field equal to APP_VERSION in the response body', async () => {
    getReadiness.mockResolvedValue(okBody);
    const res = await GET();
    expect((await res.json()).version).toBe('v1.2.3');
  });

  it('should NOT include error.stack / error.cause in unhealthy response (info leak)', async () => {
    getReadiness.mockResolvedValue({
      status: 'unhealthy',
      timestamp: '2026-06-29T00:00:00.000Z',
      checks: { redis: { status: 'error', error: 'connection refused', latencyMs: 2000 } },
    });
    const res = await GET();
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('cause');
  });
});
