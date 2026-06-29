'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DEPOSIT_STATUS_OPTIONS, PAYMENT_METHOD_OPTIONS } from '@/lib/topups/labels';
import { serializeListQuery } from '@/lib/topups/query-params';
import type {
  DepositListQuery,
  DepositStatus,
  DepositSort,
  PaymentMethod,
} from '@/lib/topups/types';
import { DateRangePicker } from '@/components/topups/date-range-picker';
import { MultiSelect } from '@/components/topups/multi-select';
import { SortSelect } from '@/components/topups/sort-select';

const DEFAULT_SORT: DepositSort = '-created_at';
const BASE = '/deposit-records';

/**
 * 篩選列（spec 14 §B4）。沿用 spec 10 行為（草稿狀態、按「套用」才送出）。
 * 跨玩家頁特性：**保留 playerId 聚焦**——套用 / 清除都不沖掉 `?playerId=`
 * （玩家聚焦的清除由 ActivePlayerChip 負責）。本列本身不含玩家欄（server-first）。
 */
export function FilterBar({ initialQuery }: { initialQuery: DepositListQuery }) {
  const router = useRouter();
  const playerId = initialQuery.playerId;

  const [startDate, setStartDate] = useState(initialQuery.startDate ?? '');
  const [endDate, setEndDate] = useState(initialQuery.endDate ?? '');
  const [status, setStatus] = useState<string[]>(initialQuery.status ?? []);
  const [paymentMethod, setPaymentMethod] = useState<string[]>(initialQuery.paymentMethod ?? []);
  const [sort, setSort] = useState<DepositSort>(initialQuery.sort ?? DEFAULT_SORT);
  const [dateValid, setDateValid] = useState(true);

  const buildQuery = (): DepositListQuery => {
    const q: DepositListQuery = {};
    if (playerId) q.playerId = playerId; // 保留聚焦
    if (startDate) q.startDate = startDate;
    if (endDate) q.endDate = endDate;
    if (status.length) q.status = status as DepositStatus[];
    if (paymentMethod.length) q.paymentMethod = paymentMethod as PaymentMethod[];
    if (sort !== DEFAULT_SORT) q.sort = sort;
    return q;
  };

  const handleApply = (e: FormEvent) => {
    e.preventDefault();
    if (!dateValid) return;
    router.push(`${BASE}${serializeListQuery(buildQuery())}`);
  };

  const handleClear = () => {
    setStartDate('');
    setEndDate('');
    setStatus([]);
    setPaymentMethod([]);
    setSort(DEFAULT_SORT);
    setDateValid(true);
    // 清篩選但保留玩家聚焦
    router.push(`${BASE}${playerId ? serializeListQuery({ playerId }) : ''}`);
  };

  return (
    <form
      onSubmit={handleApply}
      aria-label="儲值紀錄篩選列"
      className="rounded-xl border bg-white p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={(next, valid) => {
            setStartDate(next.startDate ?? '');
            setEndDate(next.endDate ?? '');
            setDateValid(valid);
          }}
        />
        <MultiSelect
          label="狀態"
          options={DEPOSIT_STATUS_OPTIONS}
          selected={status}
          onChange={setStatus}
        />
        <MultiSelect
          label="支付方式"
          options={PAYMENT_METHOD_OPTIONS}
          selected={paymentMethod}
          onChange={setPaymentMethod}
        />
        <SortSelect value={sort} onChange={setSort} />
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" disabled={!dateValid}>
          <Search className="size-4" aria-hidden="true" />
          套用
        </Button>
        <Button type="button" variant="ghost" onClick={handleClear}>
          <X className="size-4" aria-hidden="true" />
          清除
        </Button>
      </div>
    </form>
  );
}
