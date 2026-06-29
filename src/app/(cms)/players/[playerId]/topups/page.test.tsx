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

import { TopupsResult } from './page';

function makeRecord(id: string): DepositRecord {
  return {
    id,
    playerId: 'p1',
    playerName: '玩家一號',
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

describe('TopupsResult', () => {
  it('should call listDeposits with playerId merged into the parsed query', async () => {
    listDepositsMock.mockResolvedValue(result([]));
    render(await TopupsResult({ playerId: 'p1', query: { status: ['pending'] } }));
    expect(listDepositsMock).toHaveBeenCalledWith({ playerId: 'p1', status: ['pending'] });
  });

  it('should render ResultTable when records.length > 0', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a'), makeRecord('b')]));
    render(await TopupsResult({ playerId: 'p1', query: {} }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // 2 資料列 + 1 表頭列
  });

  it('should render no-results EmptyState when records is empty', async () => {
    listDepositsMock.mockResolvedValue(result([]));
    render(await TopupsResult({ playerId: 'p1', query: {} }));
    expect(screen.getByText('無符合條件的儲值紀錄')).toBeInTheDocument();
  });

  it('should render rate-limited ErrorState on 429', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(429, 'too_many_requests', undefined, 5));
    render(await TopupsResult({ playerId: 'p1', query: {} }));
    expect(screen.getByText('請求過於頻繁')).toBeInTheDocument();
  });

  it('should render forbidden ErrorState on 403', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await TopupsResult({ playerId: 'p1', query: {} }));
    expect(screen.getByText('無權檢視儲值紀錄')).toBeInTheDocument();
  });

  it('should rethrow on 5xx (handled by error.tsx)', async () => {
    listDepositsMock.mockRejectedValue(new ApiError(500, 'internal_error'));
    await expect(TopupsResult({ playerId: 'p1', query: {} })).rejects.toThrow();
  });

  it('should emit topups.list.result_count metric on render', async () => {
    listDepositsMock.mockResolvedValue(result([makeRecord('a')]));
    render(await TopupsResult({ playerId: 'p1', query: {} }));
    expect(recordMetricMock).toHaveBeenCalledWith('topups.list.result_count', { count: 1 });
  });
});
