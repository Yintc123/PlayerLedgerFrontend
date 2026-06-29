import { SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 空結果態（spec 14 §B9）。「無符合條件的儲值紀錄」+「清除篩選」CTA。
 * Server Component：CTA 為純連結，回到不帶任何篩選的全玩家列表。
 */
export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white py-20 text-center">
      <SearchX className="text-muted-foreground size-10" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">無符合條件的儲值紀錄</p>
      <a
        href="/deposit-records"
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}
      >
        清除篩選
      </a>
    </div>
  );
}
