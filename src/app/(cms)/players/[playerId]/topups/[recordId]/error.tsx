'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { recordMetric } from '@/lib/observability/ui-metrics';

/**
 * 5xx 整頁錯誤態（spec 11 §5）。通用錯誤 + 重試。
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    recordMetric('topups.detail.error', { code: 'render_error' });
  }, [error]);

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      <AlertTriangle className="size-10 text-red-500" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">發生錯誤</p>
      <p className="text-muted-foreground mt-1 text-sm">系統暫時無法載入此筆紀錄，請稍後重試。</p>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => reset()}>
        重試
      </Button>
    </div>
  );
}
