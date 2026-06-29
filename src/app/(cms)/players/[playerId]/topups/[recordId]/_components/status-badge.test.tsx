// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatusBadge } from './status-badge';
import { formatAmount } from '@/lib/format/currency';

describe('StatusBadge', () => {
  it('should render pending variant with clock icon and "等待處理" subtitle', () => {
    const { container } = render(<StatusBadge status="pending" amount={19900} currency="TWD" />);
    expect(screen.getByText('等待處理')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'pending');
  });

  it('should render completed variant with check icon and "已完成"', () => {
    const { container } = render(<StatusBadge status="completed" amount={19900} currency="TWD" />);
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('should render failed variant with warning icon and "失敗" subtitle', () => {
    render(<StatusBadge status="failed" amount={19900} currency="TWD" />);
    expect(screen.getByText('失敗')).toBeInTheDocument();
  });

  it('should render refunded variant with refund icon and "已退款"', () => {
    render(<StatusBadge status="refunded" amount={19900} currency="TWD" />);
    expect(screen.getByText('已退款')).toBeInTheDocument();
  });

  it('should render cancelled variant with neutral color and "已取消"', () => {
    render(<StatusBadge status="cancelled" amount={19900} currency="TWD" />);
    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'cancelled');
  });

  it('should render amount with Intl.NumberFormat using currency-specific minor unit', () => {
    render(<StatusBadge status="completed" amount={199} currency="JPY" />);
    // JPY has 0 minor digits → 199 yen, not 1.99
    expect(screen.getByText(formatAmount(199, 'JPY'))).toBeInTheDocument();
  });

  it('should add strikethrough on amount when status is refunded', () => {
    render(<StatusBadge status="refunded" amount={19900} currency="TWD" />);
    expect(screen.getByRole('heading')).toHaveClass('line-through');
  });
});
