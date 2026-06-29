'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { PlayerSearchQuery } from '../_lib/types';
import { serializeSearchQuery } from '../_lib/query-params';

/**
 * 「載入更多」按鈕（spec 08 §5.3）。帶 cursor 重新 router.push，由 page.tsx 重新 SSR。
 * nextCursor 為 null 時 page.tsx 不渲染本元件。
 */
export function LoadMore({ query, nextCursor }: { query: PlayerSearchQuery; nextCursor: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(() => {
      router.push(`/players${serializeSearchQuery({ ...query, cursor: nextCursor })}`);
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
