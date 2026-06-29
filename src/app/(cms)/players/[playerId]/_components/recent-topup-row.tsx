'use client';

import { useRouter } from 'next/navigation';
import type { KeyboardEvent, MouseEvent } from 'react';
import { TopupStatusTag } from '@/components/topups/status-tag';
import { formatAmount } from '@/lib/format/currency';
import { formatShortDateTime } from '@/lib/format/datetime';
import { paymentMethodLabel } from '@/lib/topups/labels';
import type { DepositRecord } from '@/lib/topups/types';

/**
 * 最近紀錄單列（spec 09 §4.4 / §8.4）。Client：整列可點 / 可獲焦；Enter 導頁。
 *
 * 列本身為 `role="listitem"` 並用 `router.push` 導頁；內含真實 `<a href>`（display:contents）
 * 以保留語意連結（漸進增強 / 無 JS 時可用），其 click 由外層攔截避免雙重導頁。
 */
export function RecentTopupRow({
  playerId,
  record,
}: {
  playerId: string;
  record: DepositRecord;
}) {
  const router = useRouter();
  const href = `/players/${playerId}/topups/${record.id}`;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      router.push(href);
    }
  };

  const handleAnchorClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // 交由外層 div 統一導頁，避免 jsdom / SSR 全頁跳轉與雙重 push。
    e.preventDefault();
  };

  return (
    <div
      role="listitem"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-ring grid cursor-pointer grid-cols-1 items-center gap-2 border-b px-4 py-3 outline-none last:border-b-0 hover:bg-slate-50 focus-visible:ring-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]"
    >
      <a href={href} onClick={handleAnchorClick} tabIndex={-1} className="contents">
        <span className="text-muted-foreground text-sm tabular-nums">
          {formatShortDateTime(record.createdAt)}
        </span>
        <span className="text-sm font-medium tabular-nums">
          {formatAmount(record.amount, record.currency)}
        </span>
        <span className="text-sm">{paymentMethodLabel(record.paymentMethod)}</span>
        <span className="justify-self-start sm:justify-self-end">
          <TopupStatusTag status={record.status} />
        </span>
      </a>
    </div>
  );
}
