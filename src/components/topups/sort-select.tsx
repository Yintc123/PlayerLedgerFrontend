'use client';

import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DepositSort } from '@/lib/topups/types';

export const SORT_OPTIONS: ReadonlyArray<{ value: DepositSort; label: string }> = [
  { value: '-created_at', label: '最新優先' },
  { value: 'created_at', label: '最舊優先' },
  { value: '-amount', label: '金額高→低' },
  { value: 'amount', label: '金額低→高' },
];

/**
 * 排序下拉（spec 10 §4.1）。對齊後端 enum；預設 `-created_at` 顯示為「最新優先」。
 * 用 `appearance-none` 隱藏原生 OS 箭頭，改自畫 ChevronDown 並對齊 MultiSelect 盒型
 * （`h-9` / `min-w-40`），避免原生 select 外觀與篩選列其他 pill 控件不一致。
 */
export function SortSelect({
  value,
  onChange,
}: {
  value?: DepositSort;
  onChange: (value: DepositSort) => void;
}) {
  return (
    <div className="relative">
      <select
        aria-label="排序"
        value={value ?? '-created_at'}
        onChange={(e) => onChange(e.target.value as DepositSort)}
        className={cn(
          'border-input h-9 min-w-40 cursor-pointer appearance-none rounded-md border bg-transparent pr-8 pl-3 text-sm shadow-xs outline-none',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]'
        )}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
    </div>
  );
}
