import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatAmount, formatRefundRate } from '@/lib/format/currency';
import { formatDateTime } from '@/lib/format/datetime';
import { cn } from '@/lib/utils';
import type { CurrencyTotals, TopupSummary } from '@/lib/topups/types';
import { REFUND_RATE_WARNING_THRESHOLD } from '../_lib/thresholds';

const NOT_YET = '尚未儲值';

/**
 * 儲值彙總卡（spec 09 §4.3 / §8.2）。Server Component：純展示。
 * 金額用 `Intl.NumberFormat`（server-safe）；退款率由後端回傳，前端不算除法。
 */
export function TopupSummaryCard({ summary }: { summary: TopupSummary }) {
  const isEmpty = summary.totalsByCurrency.length === 0;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold tracking-tight">儲值彙總</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {isEmpty ? (
          <p className="text-muted-foreground text-sm">此玩家尚未有任何儲值紀錄</p>
        ) : (
          <div className="space-y-3">
            {summary.totalsByCurrency.map((totals) => (
              <CurrencySubCard key={totals.currency} totals={totals} />
            ))}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t pt-4 text-sm">
          <dt className="text-muted-foreground">首次儲值</dt>
          <dd>{summary.firstTopupAt ? formatDateTime(summary.firstTopupAt) : NOT_YET}</dd>

          <dt className="text-muted-foreground">最近儲值</dt>
          <dd>{summary.lastTopupAt ? formatDateTime(summary.lastTopupAt) : NOT_YET}</dd>

          {summary.lifetimeDays !== null && (
            <>
              <dt className="text-muted-foreground">儲值生涯</dt>
              <dd>{`儲值生涯 ${summary.lifetimeDays} 天`}</dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function CurrencySubCard({ totals }: { totals: CurrencyTotals }) {
  const isWarning = totals.refundRate > REFUND_RATE_WARNING_THRESHOLD;
  // refundRate === 0 → 顯示「0%」而非「—」（spec §4.3）。
  const refundRateLabel = totals.refundRate === 0 ? '0%' : formatRefundRate(totals.refundRate);

  return (
    <div className="rounded-lg border bg-slate-50 p-4">
      <h3 className="font-mono text-sm font-semibold">{totals.currency}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">成功總額</dt>
        <dd className="text-right tabular-nums">{formatAmount(totals.successAmount, totals.currency)}</dd>

        <dt className="text-muted-foreground">成功筆數</dt>
        <dd className="text-right tabular-nums">{totals.successCount}</dd>

        <dt className="text-muted-foreground">退款總額</dt>
        <dd className="text-right tabular-nums">{formatAmount(totals.refundedAmount, totals.currency)}</dd>

        <dt className="text-muted-foreground">退款率</dt>
        <dd className="flex items-center justify-end gap-2">
          <span className="tabular-nums">{refundRateLabel}</span>
          {isWarning && (
            <span
              className={cn(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                'bg-red-100 text-red-800 ring-1 ring-inset ring-red-600/20'
              )}
            >
              退款率警示
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
}
