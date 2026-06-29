// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DepositRecord } from '@/lib/topups/types';
import { ResultTable } from './result-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeRecord(id: string): DepositRecord {
  return {
    id,
    playerId: `player-${id}`,
    playerName: `玩家 ${id}`,
    amount: 1000,
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

describe('ResultTable (deposit-records)', () => {
  it('should render a column header "玩家"', () => {
    render(<ResultTable records={[makeRecord('a')]} query={{}} />);
    expect(screen.getByRole('columnheader', { name: '玩家' })).toBeInTheDocument();
  });

  it('should render one row per record (plus the header row)', () => {
    render(<ResultTable records={[makeRecord('a'), makeRecord('b')]} query={{}} />);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('should mark the sorted column with aria-sort (amount descending)', () => {
    render(<ResultTable records={[makeRecord('a')]} query={{ sort: '-amount' }} />);
    expect(screen.getByRole('columnheader', { name: '金額' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('should default aria-sort to 建立時間 descending when no sort given', () => {
    render(<ResultTable records={[makeRecord('a')]} query={{}} />);
    expect(screen.getByRole('columnheader', { name: '建立時間' })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });
});
