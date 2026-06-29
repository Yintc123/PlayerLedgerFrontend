import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/api-client/cms', () => ({ cmsRequest: vi.fn() }));

import { getPlayer } from './get';
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

// 在 afterEach（而非 beforeEach）重置：vitest 4.1.9 + Node 25 下，beforeEach 內
// 清除被追蹤的 resolved-promise mock 結果會洩漏一個 unhandled rejection 並誤判到下一個
// 測試；改於 afterEach 重置（前一測試的 promise 此時已 settle）可避免。
afterEach(() => cmsRequestMock.mockReset());

describe('getPlayer (real API via cmsRequest)', () => {
  it('should call cmsRequest with GET /cms/players/{id}', async () => {
    cmsRequestMock.mockResolvedValue({ data: rawPlayer() });
    await getPlayer('abc-123');
    expect(cmsRequestMock).toHaveBeenCalledWith('/cms/players/abc-123');
  });

  it('should percent-encode playerId in the path', async () => {
    cmsRequestMock.mockResolvedValue({ data: rawPlayer() });
    await getPlayer('a b/c');
    expect(cmsRequestMock).toHaveBeenCalledWith('/cms/players/a%20b%2Fc');
  });

  it('should return a camelCase Player object from data', async () => {
    cmsRequestMock.mockResolvedValue({
      data: rawPlayer({ player_id: 'P1', display_name: '阿明', last_active_at: null }),
    });
    const p = await getPlayer('P1');
    expect(p).toMatchObject({ playerId: 'P1', displayName: '阿明', lastActiveAt: null });
  });

  it('should propagate ApiError(404 resource_not_found) from cmsRequest', async () => {
    cmsRequestMock.mockImplementation(() => {
      throw new ApiError(404, 'resource_not_found');
    });
    await expect(getPlayer('missing')).rejects.toMatchObject({
      status: 404,
      code: 'resource_not_found',
    });
  });

  it('should propagate ApiError(403 forbidden) from cmsRequest', async () => {
    cmsRequestMock.mockImplementation(() => {
      throw new ApiError(403, 'forbidden');
    });
    await expect(getPlayer('P1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
