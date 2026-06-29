// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { FilterBar } from './filter-bar';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => pushMock.mockReset());

describe('FilterBar', () => {
  it('should hydrate sub-controls from URL search params', () => {
    render(
      <FilterBar
        playerId="p1"
        initialQuery={{ startDate: '2026-06-01', endDate: '2026-06-10', status: ['completed'] }}
      />
    );
    expect(screen.getByLabelText('起始日')).toHaveValue('2026-06-01');
    expect(screen.getByLabelText('結束日')).toHaveValue('2026-06-10');
    // 狀態 chip 顯示在 trigger 內
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('should NOT call router.push when fields change before Apply is clicked', () => {
    render(<FilterBar playerId="p1" initialQuery={{}} />);
    fireEvent.change(screen.getByLabelText('起始日'), { target: { value: '2026-06-01' } });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('should call router.push with serialized query when Apply clicked', async () => {
    const user = userEvent.setup();
    render(<FilterBar playerId="p1" initialQuery={{ status: ['completed'] }} />);
    await user.click(screen.getByRole('button', { name: /套用/ }));
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups?status=completed');
  });

  it('should call router.push("/players/[id]/topups") when Clear clicked', async () => {
    const user = userEvent.setup();
    render(<FilterBar playerId="p1" initialQuery={{ status: ['completed'] }} />);
    await user.click(screen.getByRole('button', { name: /清除/ }));
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups');
  });

  it('should disable Apply when date validation error is present', () => {
    render(<FilterBar playerId="p1" initialQuery={{}} />);
    fireEvent.change(screen.getByLabelText('結束日'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('起始日'), { target: { value: '2026-06-10' } });
    expect(screen.getByRole('button', { name: /套用/ })).toBeDisabled();
  });

  it('should call Apply when Enter pressed inside a date input', async () => {
    const user = userEvent.setup();
    render(<FilterBar playerId="p1" initialQuery={{ startDate: '2026-06-01' }} />);
    const start = screen.getByLabelText('起始日');
    start.focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenCalled();
    expect(pushMock.mock.calls[0][0]).toContain('/players/p1/topups');
  });
});
