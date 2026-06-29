'use client';

import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 部分失敗的行內錯誤區塊（spec 09 §5 / §6）。Client：重試呼叫 `router.refresh()`。
 * `role="alert"` + 可獲焦的「重試」按鈕。
 */
function ErrorBlock({ title }: { title: string }) {
  const router = useRouter();
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-10 text-center"
    >
      <AlertTriangle className="size-8 text-amber-500" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => router.refresh()}>
        重試
      </Button>
    </div>
  );
}

export function SummaryErrorBlock() {
  return <ErrorBlock title="儲值彙總載入失敗" />;
}

export function RecentErrorBlock() {
  return <ErrorBlock title="最近紀錄載入失敗" />;
}
