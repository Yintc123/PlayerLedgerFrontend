// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ErrorState } from './error-state';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

beforeEach(() => refreshMock.mockReset());
afterEach(() => vi.useRealTimers());

describe('ErrorState', () => {
  it('should render bad-request copy when variant="bad-request"', () => {
    render(<ErrorState variant="bad-request" />);
    expect(screen.getByText('搜尋條件有誤')).toBeInTheDocument();
  });

  it('should render forbidden copy and hide retry when variant="forbidden"', () => {
    render(<ErrorState variant="forbidden" />);
    expect(screen.getByText('無權使用玩家查詢功能')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重試' })).not.toBeInTheDocument();
  });

  it('should render countdown using Retry-After when variant="rate-limited"', () => {
    render(<ErrorState variant="rate-limited" retryAfter={5} />);
    expect(screen.getByText(/將於 5 秒後自動重試/)).toBeInTheDocument();
  });

  it('should auto-trigger refresh once when countdown reaches zero (rate-limited)', async () => {
    vi.useFakeTimers();
    render(<ErrorState variant="rate-limited" retryAfter={2} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('should render server-error copy with Retry button when variant="server-error"', () => {
    render(<ErrorState variant="server-error" />);
    expect(screen.getByText('發生錯誤')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument();
  });

  it('should call router.refresh() when Retry clicked', async () => {
    const user = userEvent.setup();
    render(<ErrorState variant="server-error" />);
    await user.click(screen.getByRole('button', { name: '重試' }));
    expect(refreshMock).toHaveBeenCalled();
  });

  it('should expose role="alert" on the error container', () => {
    render(<ErrorState variant="forbidden" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
