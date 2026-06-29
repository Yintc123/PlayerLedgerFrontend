// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CopyButton } from './copy-button';

const writeTextMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeTextMock.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('should call navigator.clipboard.writeText with the given value when clicked', async () => {
    render(<CopyButton value="01HABCD" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(writeTextMock).toHaveBeenCalledWith('01HABCD');
  });

  it('should display "已複製" feedback for 1.5s after click', async () => {
    vi.useFakeTimers();
    render(<CopyButton value="01HABCD" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByText('已複製')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('已複製')).not.toBeInTheDocument();
  });

  it('should expose aria-label describing the action', () => {
    render(<CopyButton value="01HABCD" />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', '複製玩家 ID');
  });
});
