import { listDeposits } from '@/lib/topups/list';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import { parseListQuery } from '@/lib/topups/query-params';
import { FilterBar } from './_components/filter-bar';
import { CreateDepositButton } from './_components/create-deposit-button';
import { ResultTable } from './_components/result-table';
import { Pagination } from '@/components/topups/pagination';
import { EmptyState } from './_components/empty-state';
import { ErrorState, type ErrorVariant } from './_components/error-state';
import type { DepositListQuery } from './_lib/types';

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
 * 儲值紀錄列表頁（spec 10）。Server Component：解析 URL → 取資料 → 依狀態 render。
 */
export default async function TopupListPage({
  params,
  searchParams,
}: {
  params: Promise<{ playerId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { playerId } = await params;
  const resolved = await searchParams;
  const query = parseListQuery(toURLSearchParams(resolved));

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">儲值紀錄</h1>
          <p className="text-muted-foreground mt-1 text-sm">依日期、狀態、支付方式等條件查詢。</p>
        </div>
        <CreateDepositButton playerId={playerId} />
      </header>

      <FilterBar playerId={playerId} initialQuery={query} />

      <TopupsResult playerId={playerId} query={query} />
    </div>
  );
}

export async function TopupsResult({
  playerId,
  query,
}: {
  playerId: string;
  query: DepositListQuery;
}) {
  try {
    const { records, page, pageSize, total } = await listDeposits({ playerId, ...query });
    recordMetric('topups.list.result_count', { count: records.length });

    if (records.length === 0) {
      return <EmptyState playerId={playerId} />;
    }

    return (
      <div className="space-y-2">
        <ResultTable records={records} playerId={playerId} />
        <Pagination
          basePath={`/players/${playerId}/topups`}
          query={query}
          page={page}
          pageSize={pageSize}
          total={total}
        />
      </div>
    );
  } catch (err) {
    const status = isApiError(err) ? err.status : 500;
    const code = isApiError(err) ? err.code : 'unknown';
    recordMetric('topups.list.error', { code });

    // player_id 篩選找不到 → 後端回空集合（非 404），故此處不處理 404
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
