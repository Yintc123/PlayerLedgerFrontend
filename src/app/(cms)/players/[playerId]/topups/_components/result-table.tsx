import type { DepositRecord } from '@/lib/topups/types';
import { ResultRow } from './result-row';

const COLUMNS: ReadonlyArray<{ key: string; label: string; align?: 'right' }> = [
  { key: 'createdAt', label: '建立時間' },
  { key: 'playerName', label: '玩家' },
  { key: 'referenceNo', label: '參考號' },
  { key: 'amount', label: '金額', align: 'right' },
  { key: 'paymentMethod', label: '支付方式' },
  { key: 'status', label: '狀態' },
  { key: 'action', label: '操作' },
];

/**
 * 結果表（spec 10 §5.1）。Server Component：純展示，map 出 Client ResultRow。
 */
export function ResultTable({ records, playerId }: { records: DepositRecord[]; playerId: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="text-muted-foreground border-b bg-slate-50 text-xs font-medium">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-4 py-2 ${c.align === 'right' ? 'text-right' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <ResultRow key={record.id} record={record} playerId={playerId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
