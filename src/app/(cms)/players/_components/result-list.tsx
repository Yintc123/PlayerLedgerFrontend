import { ResultRow } from './result-row';
import type { Player } from '@/lib/players/types';

/**
 * 搜尋結果列表外殼（spec 08 §5）。Server Component：純展示，map 出 Client ResultRow。
 */
export function ResultList({ players }: { players: Player[] }) {
  return (
    <div role="list" className="overflow-hidden rounded-xl border bg-white">
      <div className="text-muted-foreground hidden grid-cols-[1.5fr_1.5fr_1fr_1fr_1fr] gap-2 border-b bg-slate-50 px-4 py-2 text-xs font-medium sm:grid">
        <span>暱稱 / ID</span>
        <span>Email</span>
        <span>手機</span>
        <span>狀態</span>
        <span>註冊 / 最近活動</span>
      </div>
      {players.map((player) => (
        <ResultRow key={player.playerId} player={player} />
      ))}
    </div>
  );
}
