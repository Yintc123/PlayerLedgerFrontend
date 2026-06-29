import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/api-client/cms', () => ({ cmsRequest: vi.fn() }));

import { searchPlayers } from './search';
import { cmsRequest } from '@/lib/api-client/cms';
import { ApiError } from '@/lib/api/errors';
import type { RawPlayerDTO } from './transform';

const cmsRequestMock = vi.mocked(cmsRequest);

function rawPlayer(overrides: Partial<RawPlayerDTO> = {}): RawPlayerDTO {
  return {
    player_id: '11111111-1111-1111-1111-111111111111',
    external_id: null,
    display_name: '玩家小王',
    email: 'wang@example.com',
    phone: '+886912345678',
    status: 'active',
    registered_at: '2025-03-04T10:23:11Z',
    last_active_at: null,
    ...overrides,
  };
}

/** 取本次呼叫的 query string，方便斷言 */
function lastQuery(): URLSearchParams {
  const init = cmsRequestMock.mock.calls[0][1]!;
  return init.searchParams as URLSearchParams;
}

// 見 get.test.ts 說明：vitest 4.1.9 + Node 25 下須於 afterEach 重置，避免 beforeEach
// 清除 mock 結果洩漏 unhandled rejection 誤判到下一個測試。
afterEach(() => cmsRequestMock.mockReset());

describe('searchPlayers (real API via cmsRequest)', () => {
  // ── 必填組合 + trim（BFF 唯一的輸入處理）
  it('should throw invalid_input WITHOUT calling cmsRequest when all fields are empty after trim', async () => {
    await expect(searchPlayers({ displayName: '   ', email: '' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_input',
    });
    expect(cmsRequestMock).not.toHaveBeenCalled();
  });

  it('should trim whitespace from string fields and omit fields that become empty', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ displayName: '  王  ', email: '   ' });
    const qs = lastQuery();
    expect(qs.get('display_name')).toBe('王');
    expect(qs.has('email')).toBe(false);
  });

  it('should NOT lowercase email / NFC display_name / strip phone (backend normalizes)', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ email: 'Alice@Example.com', phone: '0912-345-678', displayName: '林' });
    const qs = lastQuery();
    expect(qs.get('email')).toBe('Alice@Example.com'); // 原樣，不 lowercase
    expect(qs.get('phone')).toBe('0912-345-678'); // 原樣，不 strip
  });

  // ── API 呼叫
  it('should call cmsRequest with GET /cms/players and only non-empty params', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ playerId: 'PID-1', externalId: 'EXT-1' });
    const [path] = cmsRequestMock.mock.calls[0];
    expect(path).toBe('/cms/players');
    const qs = lastQuery();
    expect(qs.get('player_id')).toBe('PID-1');
    expect(qs.get('external_id')).toBe('EXT-1');
    expect(qs.has('display_name')).toBe(false);
    expect(qs.has('email')).toBe(false);
    expect(qs.has('phone')).toBe(false);
  });

  it('should pass cursor through verbatim without parsing or validating it', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ displayName: '王', cursor: '!!not-base64!!' });
    expect(lastQuery().get('cursor')).toBe('!!not-base64!!');
  });

  it('should default limit to 20 when not provided and send it as a query param', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ displayName: '王' });
    expect(lastQuery().get('limit')).toBe('20');
  });

  it('should forward limit > 50 to the backend (no client-side clamp)', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    await searchPlayers({ displayName: '王', limit: 999 });
    expect(lastQuery().get('limit')).toBe('999');
  });

  // ── 回傳轉換 / cursor
  it('should return camelCase Player objects from data.players', async () => {
    cmsRequestMock.mockResolvedValue({
      data: { players: [rawPlayer({ player_id: 'P9', display_name: '阿明' })], next_cursor: null },
    });
    const res = await searchPlayers({ displayName: '阿' });
    expect(res.players[0]).toMatchObject({ playerId: 'P9', displayName: '阿明' });
  });

  it('should return an empty players array (not throw) when backend returns empty result', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    const res = await searchPlayers({ displayName: '不存在' });
    expect(res.players).toEqual([]);
  });

  it('should return nextCursor from data.next_cursor', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: 'CURSOR-XYZ' } });
    const res = await searchPlayers({ displayName: '王' });
    expect(res.nextCursor).toBe('CURSOR-XYZ');
  });

  it('should return nextCursor null when backend returns null next_cursor', async () => {
    cmsRequestMock.mockResolvedValue({ data: { players: [], next_cursor: null } });
    const res = await searchPlayers({ displayName: '王' });
    expect(res.nextCursor).toBeNull();
  });

  // ── 錯誤透傳
  it('should propagate ApiError(400 invalid_input) thrown by cmsRequest', async () => {
    cmsRequestMock.mockImplementation(() => {
      throw new ApiError(400, 'invalid_input', 'bad');
    });
    await expect(searchPlayers({ displayName: '王' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_input',
    });
  });

  it('should propagate ApiError(429) with retryAfter thrown by cmsRequest', async () => {
    cmsRequestMock.mockImplementation(() => {
      throw new ApiError(429, 'too_many_requests', undefined, 7);
    });
    await expect(searchPlayers({ displayName: '王' })).rejects.toMatchObject({
      status: 429,
      retryAfter: 7,
    });
  });
});
