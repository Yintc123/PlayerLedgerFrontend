'use client';

import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { serializeListQuery } from '@/lib/topups/query-params';
import type { DepositListQuery } from '@/lib/topups/types';

/**
 * 已聚焦玩家 chip（spec 14 §B4.2）。server-first：聚焦來自 URL `?playerId=`。
 * - 無 playerId → 不渲染（全玩家檢視）。
 * - 名稱由 page 傳入（取自結果列的 playerName，免新端點）；缺名時退顯示 id 片段。
 * - 清除 ✕ → router.push 去除 playerId、保留其餘篩選。
 */
export function ActivePlayerChip({
  playerId,
  playerName,
  query,
}: {
  playerId?: string;
  playerName?: string;
  query: DepositListQuery;
}) {
  const router = useRouter();
  if (!playerId) return null;

  const label = playerName ?? playerId.slice(0, 8);

  const clear = () => {
    const next: DepositListQuery = { ...query };
    delete next.playerId;
    router.push(`/deposit-records${serializeListQuery(next)}`);
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">目前聚焦玩家：</span>
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
        {label}
        <button
          type="button"
          aria-label="清除玩家聚焦"
          onClick={clear}
          className="hover:text-foreground cursor-pointer rounded-full outline-none focus-visible:ring-2"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
