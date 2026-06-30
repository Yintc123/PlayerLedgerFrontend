import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DepositStatus } from '@/lib/topups/types';
import { depositStatusLabel } from '@/lib/topups/labels';

/**
 * 儲值狀態 tag（對齊後端 DepositStatus）。
 * pending=黃+時鐘、completed=綠、failed=紅、refunded=紅、cancelled=灰。文字 + 顏色雙重傳達。
 */
const STATUS_CONFIG: Record<DepositStatus, { className: string; withClock?: boolean }> = {
  pending: { className: 'bg-yellow-100 text-yellow-800 ring-yellow-600/20', withClock: true },
  completed: { className: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20' },
  failed: { className: 'bg-red-100 text-red-800 ring-red-600/20' },
  refunded: { className: 'bg-red-100 text-red-800 ring-red-600/20' },
  cancelled: { className: 'bg-slate-200 text-slate-700 ring-slate-500/20' },
};

export function TopupStatusTag({
  status,
  className,
}: {
  status: DepositStatus;
  className?: string;
}) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      data-component="TopupStatusTag"
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        config.className,
        className
      )}
    >
      {config.withClock && <Clock className="size-3" aria-hidden="true" />}
      {depositStatusLabel(status)}
    </span>
  );
}
