'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ShieldX, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type ErrorVariant = 'bad-request' | 'forbidden' | 'rate-limited' | 'server-error';

/**
 * 列表頁錯誤態（spec 10 §8）。各 variant 文案與 CTA 不同。
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
      title: '篩選條件有誤',
      body: message ?? '請回到篩選列修正條件後再試一次。',
      retry: false,
    },
    forbidden: {
      icon: <ShieldX className="size-10 text-red-500" aria-hidden="true" />,
      title: '無權檢視儲值紀錄',
      body: message ?? '您的角色無權檢視此玩家的儲值紀錄。',
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
