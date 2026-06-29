'use client';

import { useRouter } from 'next/navigation';
import type { KeyboardEvent } from 'react';
import { PlayerStatusTag } from '@/components/players/status-tag';
import { formatDateTime } from '@/lib/format/datetime';
import { formatPhoneForDisplay } from '@/lib/format/phone';
import type { Player } from '@/lib/players/types';

const DASH = '—';

/**
 * 搜尋結果單列（spec 08 §5）。整列可點 / 可獲焦；Enter 導頁；上下鍵移焦。
 */
export function ResultRow({ player }: { player: Player }) {
  const router = useRouter();
  const href = `/players/${player.playerId}`;

  const moveFocus = (current: HTMLElement, dir: 'next' | 'prev' | 'first' | 'last') => {
    const list = current.closest('[role="list"]');
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="listitem"]'));
    const idx = rows.indexOf(current);
    const target =
      dir === 'next'
        ? rows[idx + 1]
        : dir === 'prev'
          ? rows[idx - 1]
          : dir === 'first'
            ? rows[0]
            : rows[rows.length - 1];
    target?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'Enter':
        router.push(href);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(e.currentTarget, 'next');
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(e.currentTarget, 'prev');
        break;
      case 'Home':
        e.preventDefault();
        moveFocus(e.currentTarget, 'first');
        break;
      case 'End':
        e.preventDefault();
        moveFocus(e.currentTarget, 'last');
        break;
    }
  };

  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={`${player.displayName}，ID ${player.playerId}，狀態 ${player.status}`}
      onClick={() => router.push(href)}
      onKeyDown={handleKeyDown}
      className="focus-visible:ring-ring grid cursor-pointer grid-cols-1 gap-2 border-b px-4 py-3 outline-none last:border-b-0 hover:bg-slate-50 focus-visible:ring-2 sm:grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr] sm:items-center"
    >
      <div className="min-w-0">
        <div className="truncate font-medium">{player.displayName}</div>
        <div className="text-muted-foreground truncate font-mono text-xs" title={player.playerId}>
          {player.playerId}
        </div>
      </div>
      <div className="truncate text-sm" title={player.email ?? undefined}>
        {player.email ?? DASH}
      </div>
      <div className="text-sm">{player.phone ? formatPhoneForDisplay(player.phone) : DASH}</div>
      <div>
        <PlayerStatusTag status={player.status} />
      </div>
      <div className="text-muted-foreground text-xs">
        <div>{formatDateTime(player.registeredAt)}</div>
        <div>{player.lastActiveAt ? formatDateTime(player.lastActiveAt) : DASH}</div>
      </div>
    </div>
  );
}
