'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createAuthChannel } from '@/lib/idle';

export function LogoutButton() {
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
    setLoading(true);

    // 先廣播 logout，讓其他分頁立即同步跳 login（spec §3.2 step 6）。
    // idle 觸發的 logout 由 IdleTimerProvider 自行廣播，此處負責「手動登出」。
    const channel = createAuthChannel({ onMessage: () => {} });
    try {
      channel.postLogout(Date.now());
    } finally {
      channel.dispose();
    }

    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // 忽略 logout 請求失敗：本地仍要清掉並跳 login（後端 session 由 /api/logout 處理；
      // 失敗時 access token 最終仍會過期）。
    } finally {
      window.location.replace('/login');
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={handleLogout} disabled={loading}>
      <LogOut className="size-4" aria-hidden="true" />
      登出
    </Button>
  );
}
