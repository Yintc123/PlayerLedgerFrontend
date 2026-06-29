// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ResultTable } from './result-table';
import type { DepositRecord } from '@/lib/topups/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

describe('ResultTable', () => {
  it('should render a column header for each field with scope="col"', () => {
    render(<ResultTable records={[]} playerId="p1" />);
    ['建立時間', '玩家', '參考號', '金額', '支付方式', '狀態', '操作'].forEach((label) => {
      const th = screen.getByRole('columnheader', { name: label });
      expect(th).toHaveAttribute('scope', 'col');
    });
  });

  it('should render one row per record', () => {
    render(<ResultTable records={[makeRecord('a'), makeRecord('b')]} playerId="p1" />);
    expect(screen.getAllByRole('row')).toHaveLength(3); // 含表頭列
  });

  it('should right-align the amount column header', () => {
    render(<ResultTable records={[]} playerId="p1" />);
    expect(screen.getByRole('columnheader', { name: '金額' })).toHaveClass('text-right');
  });
});
