// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IdleWarningModal } from './idle-warning-modal';

describe('IdleWarningModal', () => {
  it('should render nothing when countdownSec is undefined', () => {
    const { container } = render(
      <IdleWarningModal countdownSec={undefined} onContinue={vi.fn()} onLogoutNow={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('should render with role="alertdialog" and aria-live="polite"', () => {
    render(<IdleWarningModal countdownSec={30} onContinue={vi.fn()} onLogoutNow={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-live', 'polite');
  });

  it('should close on Escape key (equivalent to "繼續")', () => {
    const onContinue = vi.fn();
    render(<IdleWarningModal countdownSec={30} onContinue={onContinue} onLogoutNow={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('should call onContinue / onLogoutNow when respective buttons clicked', () => {
    const onContinue = vi.fn();
    const onLogoutNow = vi.fn();
    render(
      <IdleWarningModal countdownSec={30} onContinue={onContinue} onLogoutNow={onLogoutNow} />
    );
    fireEvent.click(screen.getByRole('button', { name: /繼續/ }));
    fireEvent.click(screen.getByRole('button', { name: /立即登出/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onLogoutNow).toHaveBeenCalledTimes(1);
  });

  it('should trap focus inside modal while open', () => {
    render(<IdleWarningModal countdownSec={30} onContinue={vi.fn()} onLogoutNow={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' }); // 末項 Tab → 回到首項
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); // 首項 Shift+Tab → 末項
    expect(document.activeElement).toBe(last);
  });

  it('should restore focus to opener element on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <IdleWarningModal countdownSec={30} onContinue={vi.fn()} onLogoutNow={vi.fn()} />
    );
    // 開啟時焦點移入 modal
    expect(document.activeElement).not.toBe(opener);
    // 關閉 → 還原焦點
    rerender(
      <IdleWarningModal countdownSec={undefined} onContinue={vi.fn()} onLogoutNow={vi.fn()} />
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  describe('countdown (fake timers)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('should display countdown seconds and update each second', () => {
      render(<IdleWarningModal countdownSec={30} onContinue={vi.fn()} onLogoutNow={vi.fn()} />);
      expect(screen.getByText(/30/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/29/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText(/27/)).toBeInTheDocument();
    });

    it('should clear countdown interval on unmount', () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      const { unmount } = render(
        <IdleWarningModal countdownSec={30} onContinue={vi.fn()} onLogoutNow={vi.fn()} />
      );
      unmount();
      expect(clearSpy).toHaveBeenCalled();
    });
  });
});
