import { notFound } from 'next/navigation';
import { getPlayer } from '@/lib/players/get';
import { getPlayerTopupSummary } from '@/lib/topups/summary';
import { listDeposits } from '@/lib/topups/list';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import type { Player } from '@/lib/players/types';
import { ProfileCard } from './_components/profile-card';
import { TopupSummaryCard } from './_components/topup-summary-card';
import { RecentTopups } from './_components/recent-topups';
import { ForbiddenState } from './_components/forbidden-state';
import { SummaryErrorBlock, RecentErrorBlock } from './_components/error-block';

/**
 * 玩家詳情頁（spec 09）。Server Component：
 * 1. `getPlayer` 主資料；404 → notFound()、403 → ForbiddenState、5xx → 冒泡至 error.tsx
 * 2. 彙總與最近紀錄用 `Promise.allSettled` 並行；任一失敗不阻塞另一個（行內錯誤區塊）
 */
export default async function Page({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  return <PlayerDetail playerId={playerId} />;
}

export async function PlayerDetail({ playerId }: { playerId: string }) {
  let player: Player;
  try {
    player = await getPlayer(playerId);
  } catch (err) {
    if (isApiError(err)) {
      if (err.status === 404) {
        recordMetric('players.detail.error', { code: '404' });
        notFound();
      }
      if (err.status === 403) {
        recordMetric('players.detail.error', { code: '403' });
        return <ForbiddenState />;
      }
    }
    // 5xx / 未預期 → 冒泡至 error.tsx
    recordMetric('players.detail.error', { code: isApiError(err) ? String(err.status) : 'unknown' });
    throw err;
  }

  const [summaryResult, recentResult] = await Promise.allSettled([
    getPlayerTopupSummary(playerId),
    listDeposits({ playerId, pageSize: 5, sort: '-created_at' }),
  ]);

  recordMetric('players.detail.viewed', { playerId });

  return (
    <div className="space-y-6">
      <nav aria-label="breadcrumb" className="text-muted-foreground text-sm">
        <a href="/players" className="hover:underline">
          玩家
        </a>
        <span className="mx-2">/</span>
        <span aria-current="page">詳情</span>
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ProfileCard player={player} />
        {summaryResult.status === 'fulfilled' ? (
          <TopupSummaryCard summary={summaryResult.value} />
        ) : (
          <SummaryErrorBlock />
        )}
      </div>

      {recentResult.status === 'fulfilled' ? (
        <RecentTopups playerId={playerId} records={recentResult.value.records} />
      ) : (
        <RecentErrorBlock />
      )}
    </div>
  );
}
