// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/lib/api/errors';
import type { DepositRecord } from '@/lib/topups/types';

const listDepositsMock = vi.fn();
vi.mock('@/lib/topups/list', () => ({
  listDeposits: (q: unknown) => listDepositsMock(q),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const recordMetricMock = vi.fn();
vi.mock('@/lib/observability/ui-metrics', () => ({
  recordMetric: (...a: unknown[]) => recordMetricMock(...a),
}));

import { DepositsResult } from './page';

function makeRecord(id: string, playerId = 'p1'): DepositRecord {
  return {
    id,
    playerId,
    playerName: `玩家 ${playerId}`,
    amount: 19900,
    currency: 'TWD',
    status: 'completed',
    paymentMethod: 'credit_card',
    operatorId: null,
    operatorIp: null,
    internalNote: null,
    displayNote: null,
    referenceNo: `REF-${id}`,
    createdAt: '2026-06-20T03:11:22Z',
    updatedAt: '2026-06-20T03:11:22Z',
  };
}

function result(records: DepositRecord[], total = records.length) {
  return { records, page: 1, pageSize: 20, total };
}

beforeEach(() => {
  listDepositsMock.mockReset();
  recordMetricMock.mockReset();
});

describe('DepositsResult', () => {
  it('should call listDeposits with the parsed query (NO playerId → all players)', async () => {
    listDepositsMock.mockResolvedValue(result([]));
    render(await DepositsResult({ query: { status: ['pending'] } }));
    expect(listDepositsMock).toHaveBeenCalledWith({ status: ['pending'] });
  });

  it('should call listDeposits with playerId when focused', async () => {
    listDepositsMock.mockResolvedValue(result([]));
    render(await DepositsResult({ query: { playerId: 'P1' } }));
    expect(listDepositsMock).toHaveBeenCalledWith({ playerId: 'P1' });
  });

  it('should render ResultTable with rows across multiple players when records > 0', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a', 'p1'), makeRecord('b', 'p2')]));
    render(await DepositsResult({ query: {} }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2
  });

  it('should render no-results EmptyState when records is empty', async () => {
    listDepositsMock.mockResolvedValue(result([]));
    render(await DepositsResult({ query: {} }));
    expect(screen.getByText('無符合條件的儲值紀錄')).toBeInTheDocument();
  });

  it('should render the ActivePlayerChip with the focused playerName when playerId is set', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a', 'P1')]));
    render(await DepositsResult({ query: { playerId: 'P1' } }));
    expect(screen.getByText('目前聚焦玩家：')).toBeInTheDocument();
    // 名稱同時出現在 chip 與列內玩家連結，故用 getAllByText
    expect(screen.getAllByText('玩家 P1').length).toBeGreaterThan(0);
  });

  it('should render numbered pagination when more pages remain (meta passed to Pagination)', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a')], 40)); // 40/20 = 2 頁
    render(await DepositsResult({ query: {} }));
    expect(screen.getByRole('navigation', { name: '分頁' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
  });

  it('should render forbidden ErrorState on 403', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await DepositsResult({ query: {} }));
    expect(screen.getByText('無權檢視儲值紀錄')).toBeInTheDocument();
  });

  it('should render rate-limited ErrorState on 429', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(429, 'too_many_requests', undefined, 5));
    render(await DepositsResult({ query: {} }));
    expect(screen.getByText('請求過於頻繁')).toBeInTheDocument();
  });

  it('should rethrow on 5xx (handled by error.tsx)', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(500, 'internal_error'));
    await expect(DepositsResult({ query: {} })).rejects.toThrow();
  });

  it('should emit deposits.list.result_count metric on render', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a')]));
    render(await DepositsResult({ query: {} }));
    expect(recordMetricMock).toHaveBeenCalledWith('deposits.list.result_count', { count: 1 });
  });

  it('should emit deposits.list.player_focus metric when playerId is present', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a', 'P1')]));
    render(await DepositsResult({ query: { playerId: 'P1' } }));
    expect(recordMetricMock).toHaveBeenCalledWith('deposits.list.player_focus', { playerId: 'P1' });
  });
});
