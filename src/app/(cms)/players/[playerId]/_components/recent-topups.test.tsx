// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RecentTopups } from './recent-topups';
import type { DepositRecord } from '@/lib/topups/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeRecord(id: string): DepositRecord {
  return {
    id,
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
}

describe('RecentTopups', () => {
  it('should render up to 5 rows', () => {
    const records = Array.from({ length: 6 }, (_, i) => makeRecord(`R${i}`));
    render(<RecentTopups playerId="01HABCD" records={records} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('should render empty-state copy when records array is empty', () => {
    render(<RecentTopups playerId="01HABCD" records={[]} />);
    expect(screen.getByText('最近無儲值紀錄')).toBeInTheDocument();
  });

  it('should render "查看全部紀錄" link to /players/[playerId]/topups', () => {
    render(<RecentTopups playerId="01HABCD" records={[]} />);
    const link = screen.getByRole('link', { name: '查看全部紀錄' });
    expect(link).toHaveAttribute('href', '/players/01HABCD/topups');
  });

  it('should render link to /players/[playerId]/topups/[recordId] for each row', () => {
    const records = [makeRecord('R1'), makeRecord('R2')];
    const { container } = render(<RecentTopups playerId="01HABCD" records={records} />);
    expect(container.querySelector('a[href="/players/01HABCD/topups/R1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/players/01HABCD/topups/R2"]')).not.toBeNull();
  });

  it('should expose role="list" on the container', () => {
    render(<RecentTopups playerId="01HABCD" records={[makeRecord('R1')]} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
