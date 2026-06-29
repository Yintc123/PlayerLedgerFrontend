'use client';

import { useRouter } from 'next/navigation';
import type { KeyboardEvent, MouseEvent } from 'react';
import { TopupStatusTag } from '@/components/topups/status-tag';
import { formatShortDateTime } from '@/lib/format/datetime';
import { formatAmount } from '@/lib/format/currency';
import { paymentMethodLabel } from '@/lib/topups/labels';
import { serializeListQuery } from '@/lib/topups/query-params';
import type { DepositRecord, DepositListQuery } from '@/lib/topups/types';

const DASH = '—';

/**
 * 結果單列（spec 14 §B5.2）。整列可點 / 可獲焦進明細；Enter 導頁。
 * 「玩家」欄為跨玩家頁的聚焦入口：點玩家名 → 聚焦該玩家（保留現有篩選、page 重置），
 * 以 stopPropagation 與整列導明細區隔。
 */
export function ResultRow({ record, query }: { record: DepositRecord; query: DepositListQuery }) {
  const router = useRouter();
  const href = `/players/${record.playerId}/topups/${record.id}`;

  // 聚焦該玩家：保留現有篩選、設 playerId、移除 page（回第一頁）
  const focusQuery: DepositListQuery = { ...query, playerId: record.playerId };
  delete focusQuery.page;
  const focusHref = `/deposit-records${serializeListQuery(focusQuery)}`;

  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter') router.push(href);
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  const focusPlayer = (e: MouseEvent) => {
    e.stopPropagation();
    router.push(focusHref);
  };

  return (
    <tr
      tabIndex={0}
      aria-label={`儲值紀錄 ${record.id}`}
      onClick={() => router.push(href)}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-ring cursor-pointer border-b outline-none last:border-b-0 hover:bg-slate-50 focus-visible:ring-2"
    >
      <td className="px-4 py-3 text-sm whitespace-nowrap">
        {formatShortDateTime(record.createdAt)}
      </td>
      <td className="px-4 py-3 text-sm">
        <button
          type="button"
          onClick={focusPlayer}
          aria-label={`聚焦玩家 ${record.playerName}`}
          className="text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {record.playerName}
        </button>
      </td>
      <td className="px-4 py-3 font-mono text-xs" title={record.referenceNo ?? undefined}>
        <span className="block max-w-40 truncate">{record.referenceNo ?? DASH}</span>
      </td>
      <td className="px-4 py-3 text-right text-sm font-medium whitespace-nowrap">
        {formatAmount(record.amount, record.currency)}
      </td>
      <td className="px-4 py-3 text-sm">{paymentMethodLabel(record.paymentMethod)}</td>
      <td className="px-4 py-3">
        <TopupStatusTag status={record.status} />
      </td>
      <td className="px-4 py-3 text-sm">
        <a href={href} onClick={stop} className="text-primary underline-offset-4 hover:underline">
          明細
        </a>
      </td>
    </tr>
  );
}
