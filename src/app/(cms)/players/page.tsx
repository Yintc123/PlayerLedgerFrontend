import { searchPlayers } from '@/lib/players/search';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import { SearchForm } from './_components/search-form';
import { ResultList } from './_components/result-list';
import { EmptyState } from './_components/empty-state';
import { ErrorState, type ErrorVariant } from './_components/error-state';
import { LoadMore } from './_components/load-more';
import { parseSearchQuery, hasAnySearchField } from './_lib/query-params';

type SearchParams = Record<string, string | string[] | undefined>;

function toURLSearchParams(params: SearchParams): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') sp.set(key, value);
    else if (Array.isArray(value) && value[0]) sp.set(key, value[0]);
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
 * 玩家搜尋頁（spec 08）。Server Component：解析 URL → 取資料 → 依狀態 render。
 */
export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolved = await searchParams;
  const query = parseSearchQuery(toURLSearchParams(resolved));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">玩家搜尋</h1>
        <p className="text-muted-foreground mt-1 text-sm">以 ID、暱稱、Email 或手機定位玩家。</p>
      </header>

      <SearchForm initialQuery={query} />

      <PlayersResult query={query} />
    </div>
  );
}

export async function PlayersResult({ query }: { query: ReturnType<typeof parseSearchQuery> }) {
  if (!hasAnySearchField(query)) {
    return <EmptyState variant="idle" />;
  }

  try {
    const { players, nextCursor } = await searchPlayers(query);
    recordMetric('players.search.result_count', { count: players.length });

    if (players.length === 0) {
      return <EmptyState variant="no-results" />;
    }

    return (
      <div className="space-y-2">
        <ResultList players={players} />
        {nextCursor && <LoadMore query={query} nextCursor={nextCursor} />}
      </div>
    );
  } catch (err) {
    const status = isApiError(err) ? err.status : 500;
    const code = isApiError(err) ? err.code : 'unknown';
    recordMetric('players.search.error', { code });
    return (
      <ErrorState
        variant={statusToVariant(status)}
        message={isApiError(err) ? err.message : undefined}
        retryAfter={isApiError(err) ? err.retryAfter : undefined}
      />
    );
  }
}
