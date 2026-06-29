import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { DepositRecord } from '@/lib/topups/types';
import { RecentTopupRow } from './recent-topup-row';

const MAX_ROWS = 5;

/**
 * 最近紀錄區塊（spec 09 §4.4 / §8.3）。Server Component：列表外殼，map 出 Client row。
 * 「查看全部紀錄」為 `<a>`（導航非動作）→ spec 10 列表頁。
 */
export function RecentTopups({
  playerId,
  records,
}: {
  playerId: string;
  records: DepositRecord[];
}) {
  const shown = records.slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">最近儲值紀錄</h2>
        <a
          href={`/players/${playerId}/topups`}
          className="text-primary inline-flex items-center gap-1 text-sm font-medium hover:underline"
        >
          查看全部紀錄
          <ArrowRight className="size-4" aria-hidden="true" />
        </a>
      </CardHeader>
      <CardContent className="px-0">
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-6 py-8 text-center text-sm">最近無儲值紀錄</p>
        ) : (
          <div role="list" className="border-t">
            {shown.map((record) => (
              <RecentTopupRow key={record.id} playerId={playerId} record={record} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
