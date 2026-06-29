'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldX, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ErrorVariant = 'bad-request' | 'forbidden' | 'rate-limited' | 'server-error';

/**
 * 搜尋頁錯誤態（spec 08 §6）。各 variant 文案與 CTA 不同，故不共用 switch god-component。
 */
export function ErrorState({
  variant,
  message,
  retryAfter,
}: {
  variant: ErrorVariant;
  message?: string;
  retryAfter?: number;
}) {
  const router = useRouter();

  if (variant === 'rate-limited') {
    return <RateLimited retryAfter={retryAfter ?? 10} onRetry={() => router.refresh()} />;
  }

  const config = {
    'bad-request': {
      icon: <AlertTriangle className="size-10 text-amber-500" aria-hidden="true" />,
      title: '搜尋條件有誤',
      body: message ?? '請回到表單修正搜尋條件後再試一次。',
      retry: false,
    },
    forbidden: {
      icon: <ShieldX className="size-10 text-red-500" aria-hidden="true" />,
      title: '無權使用玩家查詢功能',
      body: message ?? '您的角色無權使用玩家查詢功能。',
      retry: false,
    },
    'server-error': {
      icon: <AlertTriangle className="size-10 text-red-500" aria-hidden="true" />,
      title: '發生錯誤',
      body: message ?? '系統暫時無法處理請求，請稍後重試。',
      retry: true,
    },
  }[variant];

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      {config.icon}
      <p className="mt-4 text-sm font-medium">{config.title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{config.body}</p>
      {config.retry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={() => router.refresh()}>
          重試
        </Button>
      )}
    </div>
  );
}

function RateLimited({ retryAfter, onRetry }: { retryAfter: number; onRetry: () => void }) {
  const [seconds, setSeconds] = useState(retryAfter);
  const firedRef = useRef(false);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    // 單一 interval，每秒遞減；歸零時觸發一次 retry。
    const id = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(id);
          if (!firedRef.current) {
            firedRef.current = true;
            onRetryRef.current();
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      <Timer className="size-10 text-amber-500" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">請求過於頻繁</p>
      <p className="text-muted-foreground mt-1 text-sm" aria-live="polite">
        {seconds > 0 ? `將於 ${seconds} 秒後自動重試` : '重試中…'}
      </p>
    </div>
  );
}
