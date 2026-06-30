'use client';

/**
 * 閒置自動登出 React 整合層（spec 02 §5.5.2 / §5.5.3 / §5.5.8）。
 *
 * 必須包在受保護區段 layout 內（依賴 SessionProvider 提供 useSession）。
 * - 純邏輯（timer / channel）在 `useEffect` 內 instantiate，回傳清理函式（Strict Mode 安全）。
 * - DOM activity / visibilitychange 用 AbortController.signal 一次清理。
 * - timer onEvent → metric（§5.5.6）、警告 modal、過期時 `POST /api/logout` + 導頁。
 * - 跨分頁：本地 activity 廣播（throttle 1s）、收到他頁 activity 重置、收到 logout 導頁。
 * - `policy.idleTimeoutMs === 0`（public-web）→ effect 立即 return，不掛任何 listener。
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/lib/session/client-session';
import {
  createIdleTimer,
  createAuthChannel,
  idlePolicyFor,
  type IdlePolicy,
  type IdleTimerEvent,
  type IdleTimerHandle,
  type AuthChannelHandle,
  type AuthChannelMessage,
} from '@/lib/idle';
import { recordMetric } from '@/lib/observability/ui-metrics';
import { IdleWarningModal } from './idle-warning-modal';

const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
] as const;

const LOGIN_REDIRECT = '/login?reason=idle_timeout';

export type IdleTimerProviderProps = {
  children: React.ReactNode;
  /** 測試 / Storybook 可覆寫，預設 idlePolicyFor(useSession().clientId) */
  policyOverride?: IdlePolicy;
};

export function IdleTimerProvider({ children, policyOverride }: IdleTimerProviderProps) {
  // Hooks 在元件頂層呼叫（Rules of Hooks）
  const session = useSession();
  const policy = policyOverride ?? idlePolicyFor(session.clientId);

  const [countdownSec, setCountdownSec] = useState<number | undefined>(undefined);
  const timerRef = useRef<IdleTimerHandle | null>(null);
  const channelRef = useRef<AuthChannelHandle | null>(null);

  const { idleTimeoutMs, warningMs } = policy;
  const { absoluteExpiresAt, createdAt, userId } = session;

  useEffect(() => {
    if (idleTimeoutMs === 0) return; // public-web no-op

    let loggingOut = false;

    const navigateToLogin = () => {
      window.location.replace(LOGIN_REDIRECT);
    };

    const sendLogout = () => {
      // 隱藏分頁 / 關閉路徑用 sendBeacon，確保 in-flight 不被吃掉；否則 fetch keepalive
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden' &&
        typeof navigator !== 'undefined' &&
        'sendBeacon' in navigator
      ) {
        navigator.sendBeacon('/api/logout');
      } else {
        fetch('/api/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        }).catch(() => {}); // 失敗仍導頁，BFF session 由 Redis TTL 兜底
      }
    };

    const onExpire = (idleMs: number) => {
      if (loggingOut) return; // 防重入
      loggingOut = true;
      // 觀測欄位對齊 spec 03 §2.5（userId + idleMs）
      recordMetric('auth.session.idle_logout', { userId, idleMs });
      channel.postLogout(Date.now());
      sendLogout();
      navigateToLogin();
    };

    const handleTimerEvent = (e: IdleTimerEvent) => {
      if (e.type === 'warning') {
        recordMetric('auth.session.idle_warning', {
          userId,
          idleMs: idleTimeoutMs - warningMs,
          remainingMs: e.remainingMs,
        });
        setCountdownSec(Math.ceil(e.remainingMs / 1000));
        channel.postWarning(Date.now()); // 跨分頁同步顯示警告（§5.6）
      } else if (e.type === 'extended') {
        recordMetric('auth.session.idle_extended', { userId, wayDismissed: e.via });
        setCountdownSec(undefined);
      } else {
        setCountdownSec(undefined);
        onExpire(e.idleMs);
      }
    };

    const handleMessage = (msg: AuthChannelMessage) => {
      if (loggingOut) return;
      if (msg.type === 'activity') {
        setCountdownSec(undefined);
        timer.notifyActivity();
      } else if (msg.type === 'logout') {
        loggingOut = true;
        navigateToLogin();
      } else if (msg.type === 'warning') {
        // 他頁進入警告：本頁若也已逼近自身到期才同步顯示（避免提早彈窗副作用）
        const remaining = timer.remainingMs();
        if (remaining > 0 && remaining <= warningMs) {
          setCountdownSec(Math.ceil(remaining / 1000));
        }
      }
    };

    const channel = createAuthChannel({
      currentSession: { createdAt, userId },
      onMessage: handleMessage,
    });
    channelRef.current = channel;

    const timer = createIdleTimer({
      idleTimeoutMs,
      warningMs,
      absoluteExpiresAt,
      onEvent: handleTimerEvent,
    });
    timerRef.current = timer;
    timer.notifyActivity(); // 啟動

    const ac = new AbortController();
    let lastBroadcastAt = 0;
    const onActivity = () => {
      timer.notifyActivity();
      const now = Date.now();
      if (now - lastBroadcastAt >= 1000) {
        lastBroadcastAt = now;
        channel.postActivity(now); // 跨分頁同步（throttle 1s）
      }
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { signal: ac.signal, passive: true });
    }
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') timer.notifyActivity(Date.now());
      },
      { signal: ac.signal }
    );

    return () => {
      ac.abort();
      timer.dispose();
      channel.dispose();
      timerRef.current = null;
      channelRef.current = null;
    };
  }, [idleTimeoutMs, warningMs, absoluteExpiresAt, createdAt, userId]);

  const onContinue = () => {
    setCountdownSec(undefined);
    timerRef.current?.notifyActivity(Date.now(), 'click');
  };
  const onLogoutNow = () => {
    timerRef.current?.forceExpire('manual');
  };

  return (
    // display:contents → 不產生 box、零佈局影響，僅作為承載 data-component 的標記節點
    <div data-component="IdleTimerProvider" className="contents">
      {children}
      <IdleWarningModal
        countdownSec={countdownSec}
        onContinue={onContinue}
        onLogoutNow={onLogoutNow}
      />
    </div>
  );
}
