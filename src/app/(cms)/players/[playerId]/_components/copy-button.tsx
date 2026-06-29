'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 複製玩家 ID 按鈕（spec 09 §4.2 / §8.5）。Client 子元件。
 *
 * 用 `navigator.clipboard.writeText` 複製；複製後顯示 1.5s 的「已複製」提示，
 * 並以 `aria-live="polite"` 對輔助技術宣告。按鈕本身一律存在（不依角色顯隱）。
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timerRef.current ?? undefined), []);

  const handleClick = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="複製玩家 ID"
      onClick={handleClick}
      className="gap-1.5"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? '已複製' : '複製'}</span>
    </Button>
  );
}
