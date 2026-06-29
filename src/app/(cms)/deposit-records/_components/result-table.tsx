import type { DepositRecord, DepositListQuery, DepositSort } from '@/lib/topups/types';
import { ResultRow } from './result-row';

type Column = { key: string; label: string; align?: 'right'; sortField?: 'createdAt' | 'amount' };

const COLUMNS: ReadonlyArray<Column> = [
  { key: 'createdAt', label: '建立時間', sortField: 'createdAt' },
  { key: 'playerName', label: '玩家' },
  { key: 'referenceNo', label: '參考號' },
  { key: 'amount', label: '金額', align: 'right', sortField: 'amount' },
  { key: 'paymentMethod', label: '支付方式' },
  { key: 'status', label: '狀態' },
  { key: 'action', label: '操作' },
];

const DEFAULT_SORT: DepositSort = '-created_at';

/** 將 sort enum 映射為該欄的 aria-sort（spec 14 §B8）。預設 -created_at → 建立時間降冪。 */
function ariaSortFor(
  sortField: Column['sortField'],
  sort: DepositSort
): 'ascending' | 'descending' | undefined {
  if (!sortField) return undefined;
  if (sortField === 'createdAt' && (sort === 'created_at' || sort === '-created_at')) {
    return sort.startsWith('-') ? 'descending' : 'ascending';
  }
  if (sortField === 'amount' && (sort === 'amount' || sort === '-amount')) {
    return sort.startsWith('-') ? 'descending' : 'ascending';
  }
  return undefined;
}

/**
 * 結果表（spec 14 §B5.1）。Server Component：純展示，map 出 Client ResultRow。
 * 跨玩家頁含「玩家」欄；目前排序欄標 aria-sort。
 */
export function ResultTable({
  records,
  query,
}: {
  records: DepositRecord[];
  query: DepositListQuery;
}) {
  const sort = query.sort ?? DEFAULT_SORT;

  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="text-muted-foreground border-b bg-slate-50 text-xs font-medium">
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={ariaSortFor(c.sortField, sort)}
                className={`px-4 py-2 ${c.align === 'right' ? 'text-right' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <ResultRow key={record.id} record={record} query={query} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
