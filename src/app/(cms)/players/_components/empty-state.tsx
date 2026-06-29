'use client';

import { SearchX, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 搜尋頁空態（spec 08 §6）。
 * idle：未搜尋；no-results：搜尋無結果（CTA 將焦點移回表單第一欄）。
 */
export function EmptyState({ variant }: { variant: 'idle' | 'no-results' }) {
  const focusFirstField = () => {
    document.getElementById('playerId')?.focus();
  };

  if (variant === 'idle') {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white py-20 text-center">
        <Users className="text-muted-foreground size-10" aria-hidden="true" />
        <p className="text-muted-foreground mt-4 text-sm">輸入玩家資訊以開始查詢</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white py-20 text-center">
      <SearchX className="text-muted-foreground size-10" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">找不到符合條件的玩家</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={focusFirstField}>
        修改搜尋條件
      </Button>
    </div>
  );
}
