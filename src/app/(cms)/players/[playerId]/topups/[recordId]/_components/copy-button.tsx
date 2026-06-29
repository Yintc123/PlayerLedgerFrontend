'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 複製按鈕（spec 11 §3 / §6）。Client：寫入剪貼簿並短暫顯示「已複製」。
 * `label` 描述複製對象（如「訂單 ID」），組成 aria-label「複製訂單 ID」。
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 剪貼簿不可用時靜默；不阻斷頁面
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      aria-label={`複製${label}`}
      onClick={handleClick}
      className={cn(
        'focus-visible:ring-ring inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2',
        className
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? '已複製' : ''}</span>
    </button>
  );
}
