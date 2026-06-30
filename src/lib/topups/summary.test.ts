import { describe, it, expect, vi, afterEach } from 'vitest';

const cmsRequestMock = vi.fn();
vi.mock('@/lib/api-client/cms', () => ({
  cmsRequest: (...args: unknown[]) => cmsRequestMock(...args),
}));

import { getPlayerTopupSummary } from './summary';
import { ApiError } from '@/lib/api/errors';

function rawSummary(over: Record<string, unknown> = {}) {
  return {
    player_id: 'P1',
    totals_by_currency: [
      {
        currency: 'TWD',
        completed_count: 2,
        completed_amount: 3000,
        refunded_count: 1,
        refunded_amount: 990,
        failed_count: 1,
        refund_rate: 0.33,
      },
    ],
    first_topup_at: '2026-05-30T11:20:18Z',
    last_topup_at: '2026-06-25T14:00:32Z',
    lifetime_days: 26,
    ...over,
  };
}

afterEach(() => cmsRequestMock.mockReset());

describe('getPlayerTopupSummary (real API)', () => {
  it('should request /cms/players/{id}/deposit-summary with the player id in the path', async () => {
    cmsRequestMock.mockResolvedValue({ data: rawSummary() });
    await getPlayerTopupSummary('89913bed-3ee9-4375-a0b2-bb25613ae9ad');
    expect(cmsRequestMock).toHaveBeenCalledWith(
      '/cms/players/89913bed-3ee9-4375-a0b2-bb25613ae9ad/deposit-summary'
    );
  });

  it('should transform snake_case totals to camelCase (completedCount, completedAmount)', async () => {
    cmsRequestMock.mockResolvedValue({ data: rawSummary() });
    const out = await getPlayerTopupSummary('P1');
    expect(out.playerId).toBe('P1');
    expect(out.totalsByCurrency[0]).toEqual({
      currency: 'TWD',
      completedCount: 2,
      completedAmount: 3000,
      refundedCount: 1,
      refundedAmount: 990,
      failedCount: 1,
      refundRate: 0.33,
    });
  });

  it('should map first_topup_at / last_topup_at / lifetime_days to camelCase', async () => {
    cmsRequestMock.mockResolvedValue({ data: rawSummary() });
    const out = await getPlayerTopupSummary('P1');
    expect(out.firstTopupAt).toBe('2026-05-30T11:20:18Z');
    expect(out.lastTopupAt).toBe('2026-06-25T14:00:32Z');
    expect(out.lifetimeDays).toBe(26);
  });

  it('should pass through null first/last/lifetime when player has no successful topups', async () => {
    cmsRequestMock.mockResolvedValue({
      data: rawSummary({
        totals_by_currency: [],
        first_topup_at: null,
        last_topup_at: null,
        lifetime_days: null,
      }),
    });
    const out = await getPlayerTopupSummary('P1');
    expect(out.totalsByCurrency).toEqual([]);
    expect(out.firstTopupAt).toBeNull();
    expect(out.lastTopupAt).toBeNull();
    expect(out.lifetimeDays).toBeNull();
  });

  it('should default totalsByCurrency to [] when data omits the array', async () => {
    cmsRequestMock.mockResolvedValue({
      data: { player_id: 'P1', first_topup_at: null, last_topup_at: null, lifetime_days: null },
    });
    const out = await getPlayerTopupSummary('P1');
    expect(out.totalsByCurrency).toEqual([]);
  });

  it('should propagate ApiError (e.g. 404) from upstream', async () => {
    cmsRequestMock.mockRejectedValue(new ApiError(404, 'resource_not_found', '找不到資源'));
    await expect(getPlayerTopupSummary('missing')).rejects.toMatchObject({ status: 404 });
  });
});
