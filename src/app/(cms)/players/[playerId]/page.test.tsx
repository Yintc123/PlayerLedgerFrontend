// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/lib/api/errors';
import type { Player } from '@/lib/players/types';
import type { TopupSummary, DepositListResult, DepositRecord } from '@/lib/topups/types';

const getPlayerMock = vi.fn();
const getSummaryMock = vi.fn();
const listDepositsMock = vi.fn();
const recordMetricMock = vi.fn();
const refreshMock = vi.fn();
const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('@/lib/players/get', () => ({ getPlayer: (id: string) => getPlayerMock(id) }));
vi.mock('@/lib/topups/summary', () => ({
  getPlayerTopupSummary: (id: string) => getSummaryMock(id),
}));
vi.mock('@/lib/topups/list', () => ({
  listDeposits: (q: unknown) => listDepositsMock(q),
}));
vi.mock('@/lib/observability/ui-metrics', () => ({
  recordMetric: (...a: unknown[]) => recordMetricMock(...a),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
  notFound: () => notFoundMock(),
}));

import { PlayerDetail } from './page';

const player: Player = {
  playerId: '01HABCD',
  externalId: null,
  displayName: '玩家小王',
  email: 'wang@example.com',
  phone: '+886912345678',
  status: 'active',
  registeredAt: '2025-03-04T10:23:11Z',
  lastActiveAt: '2026-06-26T08:11:00Z',
};

const summary: TopupSummary = {
  playerId: '01HABCD',
  totalsByCurrency: [
    {
      currency: 'TWD',
      successCount: 2,
      successAmount: 69900,
      refundedCount: 0,
      refundedAmount: 0,
      failedCount: 0,
      refundRate: 0,
    },
  ],
  firstTopupAt: '2026-05-30T11:20:18Z',
  lastTopupAt: '2026-06-25T14:00:32Z',
  lifetimeDays: 26,
};

const sampleRecord: DepositRecord = {
  id: '01HXYZR1',
  playerId: '01HABCD',
  playerName: '玩家小王',
  amount: 19900,
  currency: 'TWD',
  status: 'completed',
  paymentMethod: 'credit_card',
  operatorId: null,
  operatorIp: null,
  internalNote: null,
  displayNote: null,
  referenceNo: null,
  createdAt: '2026-06-25T14:00:00Z',
  updatedAt: '2026-06-25T14:00:32Z',
};

const listResult: DepositListResult = {
  records: [sampleRecord],
  page: 1,
  pageSize: 5,
  total: 1,
};

beforeEach(() => {
  getPlayerMock.mockReset();
  getSummaryMock.mockReset();
  listDepositsMock.mockReset();
  recordMetricMock.mockReset();
  refreshMock.mockReset();
  notFoundMock.mockClear();
});

describe('PlayerDetail — 主資料分支', () => {
  it('should call notFound() when getPlayer throws 404', async () => {
    getPlayerMock.mockRejectedValue(new ApiError(404, 'resource_not_found'));
    await expect(PlayerDetail({ playerId: '01HABCD' })).rejects.toThrow();
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('should render ForbiddenState when getPlayer throws 403', async () => {
    getPlayerMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await PlayerDetail({ playerId: '01HABCD' }));
    expect(screen.getByText('您的角色無權查看此玩家')).toBeInTheDocument();
  });

  it('should bubble 5xx errors to error.tsx (Next.js error boundary)', async () => {
    getPlayerMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    await expect(PlayerDetail({ playerId: '01HABCD' })).rejects.toThrow();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

describe('PlayerDetail — 部分失敗', () => {
  it('should render summary error block when getPlayerTopupSummary fails', async () => {
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    listDepositsMock.mockResolvedValue(listResult);
    render(await PlayerDetail({ playerId: '01HABCD' }));
    expect(screen.getByText('儲值彙總載入失敗')).toBeInTheDocument();
  });

  it('should render recent error block when listDeposits fails', async () => {
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockResolvedValue(summary);
    listDepositsMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    render(await PlayerDetail({ playerId: '01HABCD' }));
    expect(screen.getByText('最近紀錄載入失敗')).toBeInTheDocument();
  });

  it('should still render ProfileCard when summary and recent both fail', async () => {
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    listDepositsMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    render(await PlayerDetail({ playerId: '01HABCD' }));
    expect(screen.getByRole('heading', { name: '玩家小王' })).toBeInTheDocument();
  });

  it('should call router.refresh when summary error retry button clicked', async () => {
    const user = userEvent.setup();
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    listDepositsMock.mockResolvedValue(listResult);
    render(await PlayerDetail({ playerId: '01HABCD' }));
    await user.click(screen.getByRole('button', { name: '重試' }));
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe('PlayerDetail — 並行性與 metric', () => {
  it('should call getPlayer / getPlayerTopupSummary / listDeposits concurrently (Promise.allSettled)', async () => {
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    listDepositsMock.mockResolvedValue(listResult);
    render(await PlayerDetail({ playerId: '01HABCD' }));
    // allSettled：即使 summary 失敗，listDeposits 仍被呼叫（不短路）
    expect(getPlayerMock).toHaveBeenCalledWith('01HABCD');
    expect(getSummaryMock).toHaveBeenCalledWith('01HABCD');
    expect(listDepositsMock).toHaveBeenCalledWith({
      playerId: '01HABCD',
      pageSize: 5,
      sort: '-created_at',
    });
  });

  it('should emit players.detail.viewed metric on successful render', async () => {
    getPlayerMock.mockResolvedValue(player);
    getSummaryMock.mockResolvedValue(summary);
    listDepositsMock.mockResolvedValue(listResult);
    render(await PlayerDetail({ playerId: '01HABCD' }));
    expect(recordMetricMock).toHaveBeenCalledWith('players.detail.viewed', { playerId: '01HABCD' });
  });
});
