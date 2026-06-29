'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

/** 計算行內錯誤（spec 10 §4.3）：startDate<=endDate、區間 <= 366 天。單邊允許（後端各自獨立）。 */
export function computeDateError(startDate?: string, endDate?: string): string | null {
  if (startDate && endDate) {
    if (startDate > endDate) return '起始日不可晚於結束日';
    const diffDays =
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS;
    if (diffDays > MAX_RANGE_DAYS) return `查詢區間不可超過 ${MAX_RANGE_DAYS} 天`;
  }
  return null;
}

/**
 * 日期區間（spec 10 §4.3）。兩個原生 `<input type="date">`，對齊後端 start_date/end_date。
 * 受控於 props；每次變更回呼 `onChange(next, valid)`，由 FilterBar 收斂 Apply 啟用狀態。
 * 原生 date input 之 value 已為 YYYY-MM-DD（使用者本地日），直接序列化。
 */
export function DateRangePicker({
  startDate,
  endDate,
  onChange,
}: {
  startDate?: string;
  endDate?: string;
  onChange: (next: { startDate?: string; endDate?: string }, valid: boolean) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const error = computeDateError(startDate || undefined, endDate || undefined);

  const emit = (nextStart?: string, nextEnd?: string) => {
    const s = nextStart || undefined;
    const e = nextEnd || undefined;
    onChange({ startDate: s, endDate: e }, computeDateError(s, e) === null);
  };

  const inputCls = cn(
    'border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none',
    'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]'
  );

  return (
    <div>
      <div className="flex items-center gap-2">
        <label htmlFor={fromId} className="sr-only">
          起始日
        </label>
        <input
          id={fromId}
          type="date"
          aria-label="起始日"
          value={startDate ?? ''}
          max={endDate || undefined}
          aria-invalid={error != null}
          onChange={(e) => emit(e.target.value, endDate)}
          className={inputCls}
        />
        <span aria-hidden="true">～</span>
        <label htmlFor={toId} className="sr-only">
          結束日
        </label>
        <input
          id={toId}
          type="date"
          aria-label="結束日"
          value={endDate ?? ''}
          min={startDate || undefined}
          aria-invalid={error != null}
          onChange={(e) => emit(startDate, e.target.value)}
          className={inputCls}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
