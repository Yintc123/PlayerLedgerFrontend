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

describe('FilterBar (deposit-records)', () => {
  it('should hydrate sub-controls from the initial query', () => {
    render(
      <FilterBar
        initialQuery={{ startDate: '2026-06-01', endDate: '2026-06-10', status: ['completed'] }}
      />
    );
    expect(screen.getByLabelText('起始日')).toHaveValue('2026-06-01');
    expect(screen.getByLabelText('結束日')).toHaveValue('2026-06-10');
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('should NOT call router.push when fields change before Apply is clicked', () => {
    render(<FilterBar initialQuery={{}} />);
    fireEvent.change(screen.getByLabelText('起始日'), { target: { value: '2026-06-01' } });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('should call router.push with serialized query (repeated keys) when Apply clicked', async () => {
    const user = userEvent.setup();
    render(<FilterBar initialQuery={{ status: ['completed', 'refunded'] }} />);
    await user.click(screen.getByRole('button', { name: /套用/ }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?status=completed&status=refunded');
  });

  it('should preserve playerId focus through Apply', async () => {
    const user = userEvent.setup();
    render(<FilterBar initialQuery={{ playerId: 'P1', status: ['pending'] }} />);
    await user.click(screen.getByRole('button', { name: /套用/ }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?playerId=P1&status=pending');
  });

  it('should clear filters to /deposit-records (no focus) when Clear clicked', async () => {
    const user = userEvent.setup();
    render(<FilterBar initialQuery={{ status: ['completed'] }} />);
    await user.click(screen.getByRole('button', { name: /清除/ }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records');
  });

  it('should preserve playerId focus when Clear clicked', async () => {
    const user = userEvent.setup();
    render(<FilterBar initialQuery={{ playerId: 'P1', status: ['completed'] }} />);
    await user.click(screen.getByRole('button', { name: /清除/ }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?playerId=P1');
  });

  it('should disable Apply when a date validation error is present', () => {
    render(<FilterBar initialQuery={{}} />);
    fireEvent.change(screen.getByLabelText('結束日'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('起始日'), { target: { value: '2026-06-10' } });
    expect(screen.getByRole('button', { name: /套用/ })).toBeDisabled();
  });
});
