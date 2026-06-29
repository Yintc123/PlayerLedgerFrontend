// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TopupSummaryCard } from './topup-summary-card';
import { formatDateTime } from '@/lib/format/datetime';
import type { CurrencyTotals, TopupSummary } from '@/lib/topups/types';

function totals(over: Partial<CurrencyTotals> = {}): CurrencyTotals {
  return {
    currency: 'TWD',
    successCount: 2,
    successAmount: 69900,
    refundedCount: 1,
    refundedAmount: 99000,
    failedCount: 1,
    refundRate: 0.0523,
    ...over,
  };
}

function summary(over: Partial<TopupSummary> = {}): TopupSummary {
  return {
    playerId: '01HABCD',
    totalsByCurrency: [totals()],
    firstTopupAt: '2026-05-30T11:20:18Z',
    lastTopupAt: '2026-06-25T14:00:32Z',
    lifetimeDays: 26,
    ...over,
  };
}

describe('TopupSummaryCard', () => {
  it('should render one sub-card per currency in totalsByCurrency', () => {
    render(
      <TopupSummaryCard
        summary={summary({
          totalsByCurrency: [totals({ currency: 'TWD' }), totals({ currency: 'USD' })],
        })}
      />
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'TWD' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'USD' })).toBeInTheDocument();
  });

  it('should render empty-state copy when totalsByCurrency is empty array', () => {
    render(<TopupSummaryCard summary={summary({ totalsByCurrency: [] })} />);
    expect(screen.getByText('此玩家尚未有任何儲值紀錄')).toBeInTheDocument();
  });

  it('should format amount using Intl.NumberFormat with currency-specific minor unit', () => {
    render(
      <TopupSummaryCard
        summary={summary({ totalsByCurrency: [totals({ successAmount: 69900, currency: 'TWD' })] })}
      />
    );
    // 後端對 TWD 的最小單位為「元」（0 位小數）→ 69900 顯示為 69,900（非 699.00）
    expect(screen.getByText(/69,900/)).toBeInTheDocument();
  });

  it('should render refundRate as percentage (0.0523 → "5.23%")', () => {
    render(
      <TopupSummaryCard summary={summary({ totalsByCurrency: [totals({ refundRate: 0.0523 })] })} />
    );
    expect(screen.getByText('5.23%')).toBeInTheDocument();
  });

  it('should render "0%" when refundRate is 0 (not "—")', () => {
    render(
      <TopupSummaryCard summary={summary({ totalsByCurrency: [totals({ refundRate: 0 })] })} />
    );
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('should render warning tag when refundRate > threshold (0.3)', () => {
    render(
      <TopupSummaryCard summary={summary({ totalsByCurrency: [totals({ refundRate: 0.4 })] })} />
    );
    expect(screen.getByText(/警示/)).toBeInTheDocument();
  });

  it('should NOT render warning tag when refundRate is below threshold', () => {
    render(
      <TopupSummaryCard summary={summary({ totalsByCurrency: [totals({ refundRate: 0.1 })] })} />
    );
    expect(screen.queryByText(/警示/)).not.toBeInTheDocument();
  });

  it('should render firstTopupAt / lastTopupAt in user timezone', () => {
    const s = summary();
    render(<TopupSummaryCard summary={s} />);
    expect(screen.getByText(formatDateTime(s.firstTopupAt!))).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(s.lastTopupAt!))).toBeInTheDocument();
  });

  it('should render "尚未儲值" when firstTopupAt is null', () => {
    render(<TopupSummaryCard summary={summary({ firstTopupAt: null, lastTopupAt: null })} />);
    expect(screen.getAllByText('尚未儲值').length).toBeGreaterThanOrEqual(1);
  });

  it('should render lifetimeDays as "儲值生涯 N 天" when not null', () => {
    render(<TopupSummaryCard summary={summary({ lifetimeDays: 26 })} />);
    expect(screen.getByText('儲值生涯 26 天')).toBeInTheDocument();
  });
});
