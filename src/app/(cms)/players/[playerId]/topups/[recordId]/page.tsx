import { notFound } from 'next/navigation';
import { getDeposit } from '@/lib/topups/get';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from './_components/status-badge';
import { TransactionCard } from './_components/transaction-card';
import { StatusTimeline } from './_components/status-timeline';
import { RelatedLinks } from './_components/related-links';
import { ForbiddenState } from './_components/forbidden-state';

function Breadcrumb({ playerId, playerName }: { playerId: string; playerName: string }) {
  return (
    <nav aria-label="breadcrumb" className="text-muted-foreground text-sm">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <a href="/players" className="hover:underline">
            玩家
          </a>
        </li>
        <li aria-hidden="true">/</li>
        <li>
          <a href={`/players/${playerId}`} className="hover:underline">
            {playerName}
          </a>
        </li>
        <li aria-hidden="true">/</li>
        <li>
          <a href={`/players/${playerId}/topups`} className="hover:underline">
            儲值紀錄
          </a>
        </li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-slate-900">
          明細
        </li>
      </ol>
    </nav>
  );
}

/**
 * 單筆儲值明細頁（spec 11）。Server Component：呼叫 getDeposit → 依狀態 render。
 * 後端為扁平資源（GET /api/cms/deposit-records/{id}），fetch 僅需 recordId；
 * playerId 仍用於麵包屑 / 相關連結。
 * 404 → notFound()；403 → ForbiddenState；5xx → 冒泡至 error.tsx。
 */
export default async function TopupDetailPage({
  params,
}: {
  params: Promise<{ playerId: string; recordId: string }>;
}) {
  const { playerId, recordId } = await params;
  return <TopupDetail playerId={playerId} recordId={recordId} />;
}

export async function TopupDetail({ playerId, recordId }: { playerId: string; recordId: string }) {
  let record;
  try {
    record = await getDeposit(recordId);
  } catch (err) {
    const status = isApiError(err) ? err.status : 500;
    const code = isApiError(err) ? err.code : 'unknown';
    recordMetric('topups.detail.error', { code });
    if (status === 404) return notFound();
    if (status === 403) return <ForbiddenState />;
    throw err;
  }

  recordMetric('topups.detail.viewed', { status: record.status });

  return (
    <div className="space-y-6">
      <Breadcrumb playerId={playerId} playerName={record.playerName} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <StatusBadge status={record.status} amount={record.amount} currency={record.currency} />
          <TransactionCard record={record} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>狀態時間軸</CardTitle>
            </CardHeader>
            <CardContent>
              <StatusTimeline
                status={record.status}
                createdAt={record.createdAt}
                updatedAt={record.updatedAt}
              />
            </CardContent>
          </Card>
          <RelatedLinks playerId={playerId} />
        </div>
      </div>
    </div>
  );
}
