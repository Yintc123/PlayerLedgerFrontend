import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HealthResponse } from '@/lib/health/checks';

// route handler 為薄包裝：呼叫 lib/health/checks.getLiveness 再映射 headers。
// liveness 不查任何依賴（ADR 022），故恆為 200；本檔測 route handler 自身責任：
// 恆 200、Cache-Control、version 透傳、且不觸碰 Redis / 上游。
const getLiveness = vi.fn<() => HealthResponse>();

vi.mock('@/lib/health/checks', () => ({
  getLiveness: () => getLiveness(),
}));

const { GET } = await import('./route');

const okBody: HealthResponse = {
  status: 'ok',
  version: 'v1.2.3',
  timestamp: '2026-06-29T00:00:00.000Z',
};

describe('GET /api/health (liveness, spec 01 §9.5)', () => {
  beforeEach(() => {
    getLiveness.mockReset();
    getLiveness.mockReturnValue(okBody);
  });

  it('should return 200 (process is alive)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('should NOT check Redis or upstream (liveness is dependency-free)', async () => {
    const body = await (await GET()).json();
    // liveness 不含 checks 欄位；確保沒有把任何依賴狀態夾帶進來
    expect(body.checks).toBeUndefined();
  });

  it('should set Cache-Control no-store to prevent stale health responses', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should include version field equal to APP_VERSION in the response body', async () => {
    const res = await GET();
    expect((await res.json()).version).toBe('v1.2.3');
  });
});
