// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/lib/api/errors';
import type { DepositRecord } from '@/lib/topups/types';

const getDepositMock = vi.fn();
vi.mock('@/lib/topups/get', () => ({
  getDeposit: (id: string) => getDepositMock(id),
}));

const recordMetricMock = vi.fn();
vi.mock('@/lib/observability/ui-metrics', () => ({
  recordMetric: (...a: unknown[]) => recordMetricMock(...a),
}));

const notFoundMock = vi.fn();
vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { TopupDetail } from './page';

function makeRecord(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    id: '01HXYZRECORD',
    playerId: '01HABCPLAYER',
    playerName: '王小明',
    amount: 19900,
    currency: 'TWD',
    status: 'completed',
    paymentMethod: 'credit_card',
    operatorId: 'op-1',
    operatorIp: '10.0.0.1',
    internalNote: null,
    displayNote: null,
    referenceNo: 'REF-2026-0001',
    createdAt: '2026-06-20T03:11:22Z',
    updatedAt: '2026-06-20T03:11:45Z',
    ...overrides,
  };
}

beforeEach(() => {
  getDepositMock.mockReset();
  recordMetricMock.mockReset();
  notFoundMock.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('TopupDetail', () => {
  it('should call getDeposit(recordId) with the record id only', async () => {
    getDepositMock.mockResolvedValue(makeRecord());
    render(await TopupDetail({ playerId: 'P1', recordId: 'R1' }));
    expect(getDepositMock).toHaveBeenCalledWith('R1');
  });

  it('should render TransactionCard / StatusTimeline / StatusBadge / RelatedLinks on success', async () => {
    getDepositMock.mockResolvedValue(makeRecord());
    const { container } = render(await TopupDetail({ playerId: 'P1', recordId: 'R1' }));
    // StatusBadge
    expect(screen.getByRole('status')).toBeInTheDocument();
    // TransactionCard (id visible)
    expect(screen.getByText('01HXYZRECORD')).toBeInTheDocument();
    // StatusTimeline (ol present)
    expect(container.querySelector('ol[class*="space-y"]')).toBeInTheDocument();
    // RelatedLinks
    expect(screen.getByRole('navigation', { name: 'related links' })).toBeInTheDocument();
  });

  it('should show playerName in breadcrumb linking to /players/[playerId]', async () => {
    getDepositMock.mockResolvedValue(makeRecord());
    render(await TopupDetail({ playerId: '01HABCPLAYER', recordId: 'R1' }));
    expect(screen.getByRole('link', { name: '王小明' })).toHaveAttribute(
      'href',
      '/players/01HABCPLAYER'
    );
  });

  it('should call notFound() when getDeposit throws 404', async () => {
    getDepositMock.mockRejectedValue(new ApiError(404, 'resource_not_found'));
    await TopupDetail({ playerId: 'P1', recordId: 'R1' });
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('should render ForbiddenState when getDeposit throws 403', async () => {
    getDepositMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await TopupDetail({ playerId: 'P1', recordId: 'R1' }));
    expect(screen.getByText('您的角色無權查看此筆紀錄')).toBeInTheDocument();
  });

  it('should bubble 5xx to error.tsx', async () => {
    getDepositMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    await expect(TopupDetail({ playerId: 'P1', recordId: 'R1' })).rejects.toThrow();
  });

  it('should emit topups.detail.viewed metric on successful render', async () => {
    getDepositMock.mockResolvedValue(makeRecord());
    await TopupDetail({ playerId: 'P1', recordId: 'R1' });
    expect(recordMetricMock).toHaveBeenCalledWith('topups.detail.viewed', { status: 'completed' });
  });
});
