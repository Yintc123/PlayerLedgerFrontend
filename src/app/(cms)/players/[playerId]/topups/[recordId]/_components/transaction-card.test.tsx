// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TransactionCard } from './transaction-card';
import { formatDateTimeSeconds } from '@/lib/format/datetime';
import type { DepositRecord } from '@/lib/topups/types';

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

const base: DepositRecord = {
  id: '01HXYZRECORD',
  playerId: '01HABCPLAYER',
  playerName: '王小明',
  amount: 19900,
  currency: 'TWD',
  status: 'completed',
  paymentMethod: 'credit_card',
  operatorId: 'op-42',
  operatorIp: '10.0.0.1',
  internalNote: '人工補單',
  displayNote: '感謝儲值',
  referenceNo: 'REF-2026-0001',
  createdAt: '2026-06-20T03:11:22Z',
  updatedAt: '2026-06-20T03:11:45Z',
};

describe('TransactionCard', () => {
  it('should render id in monospace with Copy button', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('01HXYZRECORD')).toHaveClass('font-mono');
    expect(screen.getByRole('button', { name: '複製紀錄 ID' })).toBeInTheDocument();
  });

  it('should render player as link to /players/[playerId] showing playerName', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByRole('link', { name: /王小明/ })).toHaveAttribute(
      'href',
      '/players/01HABCPLAYER'
    );
  });

  it('should render playerId in a separate "玩家 ID" field with a copy button', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('玩家 ID')).toBeInTheDocument();
    expect(screen.getByText('01HABCPLAYER')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '複製玩家 ID' })).toBeInTheDocument();
  });

  it('should hide referenceNo row when value is null', () => {
    render(<TransactionCard record={{ ...base, referenceNo: null }} />);
    expect(screen.queryByText('金流交易號')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '複製金流交易號' })).not.toBeInTheDocument();
  });

  it('should render referenceNo in monospace with Copy button when not null', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('REF-2026-0001')).toHaveClass('font-mono');
    expect(screen.getByRole('button', { name: '複製金流交易號' })).toBeInTheDocument();
  });

  it('should render paymentMethod with chinese label from labels.ts', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('信用卡')).toBeInTheDocument();
  });

  it('should hide internalNote row when value is null', () => {
    render(<TransactionCard record={{ ...base, internalNote: null }} />);
    expect(screen.queryByText('內部備註')).not.toBeInTheDocument();
  });

  it('should render internalNote when not null', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('人工補單')).toBeInTheDocument();
  });

  it('should hide displayNote row when value is null', () => {
    render(<TransactionCard record={{ ...base, displayNote: null }} />);
    expect(screen.queryByText('顯示備註')).not.toBeInTheDocument();
  });

  it('should render displayNote when not null', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('感謝儲值')).toBeInTheDocument();
  });

  it('should hide operator rows when operatorId/operatorIp are null', () => {
    render(<TransactionCard record={{ ...base, operatorId: null, operatorIp: null }} />);
    expect(screen.queryByText('操作人員')).not.toBeInTheDocument();
    expect(screen.queryByText('操作 IP')).not.toBeInTheDocument();
  });

  it('should render createdAt in user timezone with seconds precision', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText(formatDateTimeSeconds('2026-06-20T03:11:22Z'))).toBeInTheDocument();
  });

  it('should render updatedAt in user timezone with seconds precision', () => {
    render(<TransactionCard record={base} />);
    expect(screen.getByText('更新時間')).toBeInTheDocument();
    expect(screen.getByText(formatDateTimeSeconds('2026-06-20T03:11:45Z'))).toBeInTheDocument();
  });

  it('should use <dl><dt><dd> structure for field list', () => {
    const { container } = render(<TransactionCard record={base} />);
    expect(container.querySelector('dl')).toBeInTheDocument();
    expect(container.querySelector('dt')).toBeInTheDocument();
    expect(container.querySelector('dd')).toBeInTheDocument();
  });
});
