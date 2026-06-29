'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 多選下拉（spec 10 §4.4）。用於狀態 / 支付方式。
 * trigger 顯示已選 chip；展開為 checkbox 清單；Space 切換、上下鍵移焦、Esc 關閉並還焦。
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const selectedOptions = options.filter((o) => selected.includes(o.value));

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []
    );
    const idx = items.indexOf(document.activeElement as HTMLInputElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(idx + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'border-input flex h-9 min-w-40 items-center gap-1.5 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]'
        )}
      >
        <span className="text-muted-foreground">{label}</span>
        {selectedOptions.map((o) => (
          <span
            key={o.value}
            className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700"
          >
            {o.label}
          </span>
        ))}
        <ChevronDown className="text-muted-foreground ml-auto size-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          onKeyDown={onListKeyDown}
          className="absolute z-10 mt-1 flex w-max min-w-full flex-col gap-1 rounded-md border bg-white p-2 shadow-md"
        >
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
