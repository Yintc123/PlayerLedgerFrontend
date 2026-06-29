// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DateRangePicker } from './date-range-picker';

describe('DateRangePicker', () => {
  it('should emit startDate/endDate on change', () => {
    const onChange = vi.fn();
    render(<DateRangePicker onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('起始日'), { target: { value: '2026-06-10' } });
    expect(onChange).toHaveBeenLastCalledWith(
      { startDate: '2026-06-10', endDate: undefined },
      true
    );
  });

  it('should show inline error when startDate > endDate', () => {
    render(<DateRangePicker startDate="2026-06-10" endDate="2026-06-01" onChange={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('起始日不可晚於結束日');
  });

  it('should show inline error when range > 366 days', () => {
    render(<DateRangePicker startDate="2025-01-01" endDate="2026-06-01" onChange={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('366');
  });

  it('should serialize selected dates as YYYY-MM-DD in user local timezone', () => {
    const onChange = vi.fn();
    render(<DateRangePicker startDate="2026-06-01" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('結束日'), { target: { value: '2026-06-15' } });
    expect(onChange).toHaveBeenLastCalledWith(
      { startDate: '2026-06-01', endDate: '2026-06-15' },
      true
    );
  });

  it('should hydrate values from URL search params on mount', () => {
    render(<DateRangePicker startDate="2026-06-01" endDate="2026-06-28" onChange={() => {}} />);
    expect(screen.getByLabelText('起始日')).toHaveValue('2026-06-01');
    expect(screen.getByLabelText('結束日')).toHaveValue('2026-06-28');
  });
});
