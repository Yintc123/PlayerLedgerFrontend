import { listDeposits } from '@/lib/topups/list';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import { parseListQuery } from '@/lib/topups/query-params';
import { Pagination } from '@/components/topups/pagination';
import type { DepositListQuery } from '@/lib/topups/types';
import { FilterBar } from './_components/filter-bar';
import { ActivePlayerChip } from './_components/active-player-chip';
import { ResultTable } from './_components/result-table';
import { EmptyState } from './_components/empty-state';
import { ErrorState, type ErrorVariant } from './_components/error-state';

type SearchParams = Record<string, string | string[] | undefined>;

function toURLSearchParams(params: SearchParams): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') sp.append(key, value);
    else if (Array.isArray(value)) for (const v of value) sp.append(key, v);
  }
  return sp;
}

function statusToVariant(status: number): ErrorVariant {
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status === 400) return 'bad-request';
  return 'server-error';
}

/**
 * 全玩家儲值紀錄頁（spec 14）。Server Component：解析 URL → 取資料 → 依狀態 render。
 * playerId 為可選聚焦（省略 = 全玩家）；不需新後端端點（重用扁平資源）。
 */
export default async function DepositRecordsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolved = await searchParams;
  const query = parseListQuery(toURLSearchParams(resolved));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">儲值紀錄</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          跨玩家檢視所有儲值紀錄；可依日期、狀態、支付方式篩選，或聚焦特定玩家。
        </p>
      </header>

      <FilterBar initialQuery={query} />

      <DepositsResult query={query} />
    </div>
  );
}

export async function DepositsResult({ query }: { query: DepositListQuery }) {
  try {
    const { records, page, pageSize, total } = await listDeposits(query);
    recordMetric('deposits.list.result_count', { count: records.length });
    if (query.playerId) recordMetric('deposits.list.player_focus', { playerId: query.playerId });

    // 聚焦玩家名：取自結果列的 playerName 快照（免新端點）；缺則 chip 退顯示 id 片段
    const focusedName = query.playerId
      ? records.find((r) => r.playerId === query.playerId)?.playerName
      : undefined;

    return (
      <div className="space-y-4">
        <ActivePlayerChip playerId={query.playerId} playerName={focusedName} query={query} />

        {records.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            <ResultTable records={records} query={query} />
            <Pagination
              basePath="/deposit-records"
              query={query}
              page={page}
              pageSize={pageSize}
              total={total}
            />
          </div>
        )}
      </div>
    );
  } catch (err) {
    const status = isApiError(err) ? err.status : 500;
    const code = isApiError(err) ? err.code : 'unknown';
    recordMetric('deposits.list.error', { code });

    if (status === 403 || status === 429 || status === 400) {
      return (
        <ErrorState
          variant={statusToVariant(status)}
          message={isApiError(err) ? err.message : undefined}
          retryAfter={isApiError(err) ? err.retryAfter : undefined}
        />
      );
    }
    throw err; // 5xx → error.tsx
  }
}
