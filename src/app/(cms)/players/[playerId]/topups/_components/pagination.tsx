'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { DepositListQuery } from '../_lib/types';
import { serializeListQuery } from '../_lib/query-params';

/**
 * 「載入更多」分頁（spec 10 §6）。後端為 offset 分頁（page/page_size/total）。
 * 僅當 `page * pageSize < total`（仍有下一頁）時渲染；點擊以 page+1 重新 router.push。
 * 其他篩選條件由 `query` 帶入並保留。
 */
export function Pagination({
  playerId,
  query,
  page,
  pageSize,
  total,
}: {
  playerId: string;
  query: DepositListQuery;
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const hasNext = page * pageSize < total;
  if (!hasNext) return null;

  const handleClick = () => {
    startTransition(() => {
      router.push(`/players/${playerId}/topups${serializeListQuery({ ...query, page: page + 1 })}`);
    });
  };

  return (
    <div className="flex justify-center py-4">
      <Button variant="outline" onClick={handleClick} aria-busy={pending} disabled={pending}>
        載入更多
      </Button>
    </div>
  );
}
