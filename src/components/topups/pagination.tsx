'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';
import type { DepositListQuery } from '@/lib/topups/types';
import { serializeListQuery } from '@/lib/topups/query-params';

/**
 * 頁碼分頁（spec 10 §6 / spec 14 §B6）。後端為 OFFSET 分頁（page/page_size/total）。
 * 上一頁 ‧ 頁碼（含省略號 …）‧ 下一頁；總頁數 <= 1 不渲染。
 *
 * 共用於兩個畫面（spec 14 §B1.3）：以 **serializable** `basePath` + `query` 參數化，
 * 在 client 端組出各頁連結。不用函式 prop——函式無法跨 Server→Client component 邊界（RSC 限制）。
 */
const DELTA = 1; // 目前頁兩側各顯示幾個鄰頁

/** 計算頁碼視窗：恆含第 1、最末頁與 current±DELTA，缺口以 'ellipsis' 表示。 */
export function pageItems(current: number, totalPages: number): (number | 'ellipsis')[] {
  const wanted = new Set<number>([1, totalPages]);
  for (let n = current - DELTA; n <= current + DELTA; n++) wanted.add(n);
  const sorted = [...wanted].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);

  const items: (number | 'ellipsis')[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) items.push('ellipsis');
    items.push(n);
    prev = n;
  }
  return items;
}

export function Pagination({
  basePath,
  query,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  query: DepositListQuery;
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const current = Math.min(Math.max(page, 1), totalPages);

  const hrefFor = (n: number) => {
    const q: DepositListQuery = { ...query };
    if (n <= 1) delete q.page;
    else q.page = n;
    return `${basePath}${serializeListQuery(q)}`;
  };

  const go = (n: number) => {
    startTransition(() => {
      router.push(hrefFor(n));
    });
  };

  const baseBtn =
    'inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-md border px-3 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50';

  return (
    <nav
      data-component="Pagination"
      aria-label="分頁"
      aria-busy={pending}
      className="flex items-center justify-center gap-1 py-4"
    >
      <button
        type="button"
        aria-label="上一頁"
        onClick={() => go(current - 1)}
        disabled={current <= 1}
        className={cn(baseBtn, 'hover:bg-slate-50')}
      >
        上一頁
      </button>

      {pageItems(current, totalPages).map((item, i) =>
        item === 'ellipsis' ? (
          <span key={`ellipsis-${i}`} aria-hidden="true" className="text-muted-foreground px-1">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            onClick={() => go(item)}
            aria-current={item === current ? 'page' : undefined}
            className={cn(
              baseBtn,
              item === current
                ? 'bg-foreground text-background border-foreground'
                : 'hover:bg-slate-50'
            )}
          >
            {item}
          </button>
        )
      )}

      <button
        type="button"
        aria-label="下一頁"
        onClick={() => go(current + 1)}
        disabled={current >= totalPages}
        className={cn(baseBtn, 'hover:bg-slate-50')}
      >
        下一頁
      </button>
    </nav>
  );
}
