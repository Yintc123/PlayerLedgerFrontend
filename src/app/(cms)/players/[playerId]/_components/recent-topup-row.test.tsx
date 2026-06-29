// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { RecentTopupRow } from './recent-topup-row';
import { formatShortDateTime } from '@/lib/format/datetime';
import type { DepositRecord } from '@/lib/topups/types';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const record: DepositRecord = {
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

beforeEach(() => pushMock.mockReset());

describe('RecentTopupRow', () => {
  it('should render createdAt, amount with currency, paymentMethod, status tag', () => {
    render(<RecentTopupRow playerId="01HABCD" record={record} />);
    expect(screen.getByText(formatShortDateTime(record.createdAt))).toBeInTheDocument();
    expect(screen.getByText(/19,900/)).toBeInTheDocument();
    expect(screen.getByText('信用卡')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('should navigate to /players/[playerId]/topups/[recordId] when clicked', async () => {
    const user = userEvent.setup();
    render(<RecentTopupRow playerId="01HABCD" record={record} />);
    await user.click(screen.getByRole('listitem'));
    expect(pushMock).toHaveBeenCalledWith('/players/01HABCD/topups/01HXYZR1');
  });

  it('should navigate when Enter pressed with row focused', async () => {
    const user = userEvent.setup();
    render(<RecentTopupRow playerId="01HABCD" record={record} />);
    screen.getByRole('listitem').focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenCalledWith('/players/01HABCD/topups/01HXYZR1');
  });

  it('should be focusable (tabIndex 0)', () => {
    render(<RecentTopupRow playerId="01HABCD" record={record} />);
    expect(screen.getByRole('listitem')).toHaveAttribute('tabindex', '0');
  });
});
