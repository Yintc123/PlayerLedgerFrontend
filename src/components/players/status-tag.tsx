import { cn } from '@/lib/utils';
import type { PlayerStatus } from '@/lib/players/types';

/**
 * 玩家狀態 tag（spec 08 §5.1 / 09 §4.2）。
 * 文字 + 顏色雙重傳達語意（不單靠顏色）；對比 ≥ AA。
 */
const STATUS_CONFIG: Record<PlayerStatus, { label: string; className: string }> = {
  active: { label: '正常', className: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20' },
  frozen: { label: '凍結', className: 'bg-amber-100 text-amber-800 ring-amber-600/20' },
  closed: { label: '已關閉', className: 'bg-slate-200 text-slate-700 ring-slate-500/20' },
};

export function PlayerStatusTag({
  status,
  className,
}: {
  status: PlayerStatus;
  className?: string;
}) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  );
}
