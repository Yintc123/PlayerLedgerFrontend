// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { DepositRecord, DepositListQuery } from '@/lib/topups/types';
import { ResultRow } from './result-row';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => pushMock.mockReset());

function makeRecord(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    id: 'rec-1',
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
    referenceNo: 'REF-1',
    createdAt: '2026-06-20T03:11:22Z',
    updatedAt: '2026-06-20T03:11:22Z',
    ...overrides,
  };
}

function renderRow(record: DepositRecord, query: DepositListQuery = {}) {
  return render(
    <table>
      <tbody>
        <ResultRow record={record} query={query} />
      </tbody>
    </table>
  );
}

describe('ResultRow (deposit-records)', () => {
  it('should render the player column with playerName', () => {
    renderRow(makeRecord());
    expect(screen.getByText('玩家一號')).toBeInTheDocument();
  });

  it('should navigate to /players/[playerId]/topups/[id] when the row is clicked', async () => {
    const user = userEvent.setup();
    renderRow(makeRecord({ id: 'rec-9', playerId: 'p9' }));
    await user.click(screen.getByRole('row'));
    expect(pushMock).toHaveBeenCalledWith('/players/p9/topups/rec-9');
  });

  it('should focus the player (preserving filters, page reset) without navigating to detail', async () => {
    const user = userEvent.setup();
    renderRow(makeRecord({ playerId: 'p1' }), { status: ['pending'], page: 3 });
    await user.click(screen.getByRole('button', { name: '聚焦玩家 玩家一號' }));
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?playerId=p1&status=pending');
  });

  it('should render "—" when referenceNo is null', () => {
    renderRow(makeRecord({ referenceNo: null }));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should right-align and format amount with per-currency minor unit (TWD = 0 decimals)', () => {
    renderRow(makeRecord({ amount: 19900, currency: 'TWD' }));
    const amountCell = screen.getByText((t) => t.includes('19,900') && !t.includes('.'));
    expect(amountCell).toHaveClass('text-right');
  });

  it('should render the status tag with the completed label (not "success")', () => {
    renderRow(makeRecord({ status: 'completed' }));
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('should be focusable and navigate to detail on Enter', async () => {
    const user = userEvent.setup();
    renderRow(makeRecord({ id: 'rec-2', playerId: 'p2' }));
    const row = screen.getByRole('row');
    row.focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenCalledWith('/players/p2/topups/rec-2');
  });
});
