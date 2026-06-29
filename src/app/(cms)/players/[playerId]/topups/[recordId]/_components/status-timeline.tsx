import { cn } from '@/lib/utils';
import { formatDateTimeSeconds } from '@/lib/format/datetime';
import { depositStatusLabel } from '@/lib/topups/labels';
import type { DepositRecord, DepositStatus } from '@/lib/topups/types';

/**
 * 狀態時間軸（spec 11 §4.4 / §6，對齊後端 DepositRecord）。
 * 後端僅有 createdAt / updatedAt，無付款 / 退款時間戳，故簡化為兩節點：
 *  1. 建立（createdAt，恆達成）
 *  2. 目前狀態（depositStatusLabel(status) @ updatedAt；
 *     status !== 'pending' 或 updatedAt !== createdAt 時達成）
 * 最後一個已達節點帶 `aria-current="step"`。`<ol><li>` 結構。
 */
type Step = {
  key: string;
  label: string;
  reached: boolean;
  time: string | null;
};

export function StatusTimeline({
  status,
  createdAt,
  updatedAt,
}: Pick<DepositRecord, 'createdAt' | 'updatedAt'> & { status: DepositStatus }) {
  const currentReached = status !== 'pending' || updatedAt !== createdAt;

  const steps: Step[] = [
    { key: 'created', label: '建立', reached: true, time: formatDateTimeSeconds(createdAt) },
    {
      key: 'current',
      label: '目前狀態',
      reached: currentReached,
      time: currentReached ? formatDateTimeSeconds(updatedAt) : null,
    },
  ];

  const lastReachedIdx = steps.reduce((acc, step, i) => (step.reached ? i : acc), 0);

  return (
    <ol className="space-y-1">
      {steps.map((step, i) => (
        <li
          key={step.key}
          data-reached={step.reached}
          aria-current={i === lastReachedIdx ? 'step' : undefined}
          className="flex gap-3 py-1"
        >
          <span
            aria-hidden="true"
            className={cn(
              'mt-1 size-3 shrink-0 rounded-full border-2',
              step.reached ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-transparent'
            )}
          />
          <div className="min-w-0">
            <div
              className={cn(
                'text-sm font-medium',
                step.reached ? 'text-slate-900' : 'text-slate-400'
              )}
            >
              {step.label}
            </div>
            {step.key === 'current' && step.reached && (
              <div className="text-xs text-slate-500">{depositStatusLabel(status)}</div>
            )}
            <div
              className={cn('text-xs', step.reached ? 'text-muted-foreground' : 'text-slate-400')}
            >
              {step.time ?? '—'}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
