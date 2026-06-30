'use client';

/**
 * 閒置警告 modal（spec 02 §5.5.4）。
 *
 * - `countdownSec === undefined` → 不顯示（render null）。
 * - `role="alertdialog"` + `aria-live="polite"`，ESC 等同「繼續」。
 * - focus trap：Tab / Shift+Tab 在 modal 內循環；開啟時移焦進 modal、關閉還原。
 * - 倒數每秒更新（`setInterval` 僅在顯示時掛，卸載 / 關閉立即清）。顯示用,
 *   真正的逾時由 IdleTimerProvider 的 timer 驅動（§5.5.3）。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export type IdleWarningModalProps = {
  /** undefined → 不顯示；給定數字 → 顯示倒數 */
  countdownSec: number | undefined;
  onContinue: () => void; // 「繼續工作」/ ESC / 任何 activity
  onLogoutNow: () => void; // 「立即登出」
};

export function IdleWarningModal({ countdownSec, onContinue, onLogoutNow }: IdleWarningModalProps) {
  const open = countdownSec !== undefined;
  const [remaining, setRemaining] = useState(countdownSec ?? 0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 重新顯示時重置倒數起點
  useEffect(() => {
    if (countdownSec !== undefined) setRemaining(countdownSec);
  }, [countdownSec]);

  // 倒數計時：僅在顯示時掛 interval
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setRemaining((s) => Math.max(s - 1, 0)), 1000);
    return () => clearInterval(id);
  }, [open]);

  // 焦點：開啟時記住 opener 並移焦進 modal，關閉還原
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      openerRef.current?.focus?.();
    };
  }, [open]);

  // ESC = 繼續；Tab / Shift+Tab focus trap
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onContinue();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onContinue]);

  if (!open) return null;

  return (
    <div
      data-component="IdleWarningModal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-live="polite"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-desc"
        tabIndex={-1}
        className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl outline-none"
      >
        <h2 id="idle-warning-title" className="text-lg font-semibold">
          即將自動登出
        </h2>
        <p id="idle-warning-desc" className="text-muted-foreground mt-2 text-sm">
          因閒置過久，將在 <span className="text-foreground font-medium">剩餘 {remaining} 秒</span>{' '}
          後自動登出。要繼續使用請點「繼續工作」。
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onLogoutNow}>
            立即登出
          </Button>
          <Button size="sm" onClick={onContinue}>
            繼續工作
          </Button>
        </div>
      </div>
    </div>
  );
}
