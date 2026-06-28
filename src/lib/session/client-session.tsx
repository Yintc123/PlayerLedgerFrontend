'use client';

import { createContext, useContext } from 'react';
import type { Role } from '@/lib/auth/decode-token';

/**
 * Client Session Model（§2.5；role 由 spec 07 §3.3 擴充）
 * 不含 token，只含非敏感欄位供 UI 讀取
 */
export type ClientSession = {
  userId: string;
  clientId: string; // 'cms-web' 等
  absoluteExpiresAt: number; // ms，與 server 端相同欄位
  createdAt: number; // ms，本次 login 建立 sid 的時間
  role: Role; // spec 07 §3.3；單一字串（**非**陣列）
};

const SessionContext = createContext<ClientSession | null>(null);

export function SessionProvider(props: {
  initialSession: ClientSession;
  children: React.ReactNode;
}) {
  return (
    <SessionContext.Provider value={props.initialSession}>{props.children}</SessionContext.Provider>
  );
}

/**
 * 受保護區段 Client Component 唯一的 session 取得方式
 * 若呼叫端在 SessionProvider 外（例如 /login page），throws
 */
export function useSession(): ClientSession {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error('useSession must be called within SessionProvider');
  }
  return session;
}

/**
 * 公開區段（login page）使用：不 throw，回 null
 * 用於「navbar 顯示登入按鈕 / 已登入頭像」等 conditional UI
 */
export function useSessionOptional(): ClientSession | null {
  return useContext(SessionContext);
}
