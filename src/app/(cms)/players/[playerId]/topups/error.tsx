'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 列表頁 5xx 錯誤邊界（spec 10 §8）。通用錯誤 + 重試。
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      <AlertTriangle className="size-10 text-red-500" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">發生錯誤</p>
      <p className="text-muted-foreground mt-1 text-sm">系統暫時無法處理請求，請稍後重試。</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={reset}>
        重試
      </Button>
    </div>
  );
}
