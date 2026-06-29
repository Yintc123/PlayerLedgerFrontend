import { SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 空結果態（spec 10 §8）。「無符合條件的儲值紀錄」+「清除篩選」CTA。
 * Server Component：CTA 為純連結（回到不帶篩選的列表）。
 */
export function EmptyState({ playerId }: { playerId: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white py-20 text-center">
      <SearchX className="text-muted-foreground size-10" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">無符合條件的儲值紀錄</p>
      <a
        href={`/players/${playerId}/topups`}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}
      >
        清除篩選
      </a>
    </div>
  );
}
