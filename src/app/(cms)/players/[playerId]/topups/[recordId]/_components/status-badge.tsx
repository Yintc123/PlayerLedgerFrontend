import { AlertTriangle, CheckCircle2, Clock, RotateCcw, Ban, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAmount } from '@/lib/format/currency';
import type { DepositStatus } from '@/lib/topups/types';

/**
 * 大型狀態徽章（spec 11 §4.2 / §6）。
 * 主標金額為 `<h1>`、`text-4xl`；refunded 加刪除線（model 無獨立退款金額）。
 * 副標依狀態：pending→等待處理、completed→已完成、failed→失敗、cancelled→已取消、
 * refunded→已退款。整體 `role="status"`，副標可被螢幕閱讀器讀出。
 */
const STATUS_VISUAL: Record<
  DepositStatus,
  { icon: LucideIcon; iconClass: string; containerClass: string; subtitle: string }
> = {
  pending: {
    icon: Clock,
    iconClass: 'text-yellow-600',
    containerClass: 'border-yellow-200 bg-yellow-50',
    subtitle: '等待處理',
  },
  completed: {
    icon: CheckCircle2,
    iconClass: 'text-emerald-600',
    containerClass: 'border-emerald-200 bg-emerald-50',
    subtitle: '已完成',
  },
  failed: {
    icon: AlertTriangle,
    iconClass: 'text-red-600',
    containerClass: 'border-red-200 bg-red-50',
    subtitle: '失敗',
  },
  refunded: {
    icon: RotateCcw,
    iconClass: 'text-red-600',
    containerClass: 'border-red-200 bg-red-50',
    subtitle: '已退款',
  },
  cancelled: {
    icon: Ban,
    iconClass: 'text-slate-500',
    containerClass: 'border-slate-200 bg-slate-50',
    subtitle: '已取消',
  },
};

export function StatusBadge({
  status,
  amount,
  currency,
}: {
  status: DepositStatus;
  amount: number;
  currency: string;
}) {
  const visual = STATUS_VISUAL[status];
  const Icon = visual.icon;
  const formattedAmount = formatAmount(amount, currency);
  const isRefunded = status === 'refunded';

  return (
    <div
      role="status"
      data-status={status}
      className={cn('rounded-xl border p-6 shadow-sm', visual.containerClass)}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn('size-6', visual.iconClass)} aria-hidden="true" />
        <span className="text-sm font-medium text-slate-700">{visual.subtitle}</span>
      </div>

      <h1
        aria-label={`金額 ${formattedAmount}`}
        className={cn(
          'mt-3 text-right text-4xl font-bold tracking-tight tabular-nums',
          isRefunded && 'text-slate-500 line-through'
        )}
      >
        {formattedAmount}
      </h1>
    </div>
  );
}
