// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ResultRow } from './result-row';
import type { DepositRecord } from '@/lib/topups/types';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const YEAR = new Date().getFullYear();

const base: DepositRecord = {
  id: 'rec1',
  playerId: 'p1',
  playerName: '玩家一號',
  amount: 19900,
  currency: 'TWD',
  status: 'completed',
  paymentMethod: 'credit_card',
  operatorId: 'op1',
  operatorIp: '203.0.113.1',
  internalNote: null,
  displayNote: null,
  referenceNo: 'REF-0001',
  createdAt: `${YEAR}-06-20T03:11:22Z`,
  updatedAt: `${YEAR}-06-20T03:11:22Z`,
};

function renderRow(record: DepositRecord) {
  return render(
    <table>
      <tbody>
        <ResultRow record={record} playerId="p1" />
      </tbody>
    </table>
  );
}

beforeEach(() => pushMock.mockReset());

describe('ResultRow', () => {
  it('should render createdAt with short format for in-year and full format for cross-year', () => {
    const { unmount } = renderRow(base);
    expect(screen.getByText(/^\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();
    unmount();
    renderRow({ ...base, createdAt: `${YEAR - 1}-06-20T03:11:22Z` });
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('should render the player name', () => {
    renderRow(base);
    expect(screen.getByText('玩家一號')).toBeInTheDocument();
  });

  it('should render "—" when referenceNo is null', () => {
    renderRow({ ...base, referenceNo: null });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should render referenceNo with a title for truncation', () => {
    renderRow(base);
    const cell = screen.getByText('REF-0001').closest('td');
    expect(cell).toHaveAttribute('title', 'REF-0001');
  });

  it('should right-align amount column', () => {
    renderRow(base);
    const amountCell = screen.getByText((t) => t.includes('19,900'));
    expect(amountCell).toHaveClass('text-right');
  });

  it('should render status tag with the correct visual variant', () => {
    renderRow({ ...base, status: 'refunded' });
    const tag = screen.getByText('已退款');
    expect(tag).toHaveAttribute('data-status', 'refunded');
  });

  it('should navigate to /players/[playerId]/topups/[id] when row clicked', async () => {
    const user = userEvent.setup();
    renderRow(base);
    await user.click(screen.getByRole('row'));
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups/rec1');
  });

  it('should be focusable and navigate on Enter', async () => {
    const user = userEvent.setup();
    renderRow(base);
    const row = screen.getByRole('row');
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups/rec1');
  });
});
