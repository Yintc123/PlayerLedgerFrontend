'use client';

import { Plus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session/client-session';

/**
 * 「建立儲值」入口（spec 10 §3）。僅 admin / user 可見（viewer 隱藏）。
 * 前端顯隱非安全邊界——後端 POST 仍會對 viewer 回 403。
 */
export function CreateDepositButton({ playerId }: { playerId: string }) {
  const { role } = useSession();
  if (role !== 'admin' && role !== 'user') return null;

  return (
    <a href={`/players/${playerId}/topups/new`} className={cn(buttonVariants({ size: 'sm' }))}>
      <Plus className="size-4" aria-hidden="true" />
      建立儲值
    </a>
  );
}
