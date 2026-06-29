/**
 * 依 client_id 對應 idle 政策（spec 02 §5.5.7）。
 *
 * **純 client 模組，不 import server-only `@/lib/config`**：`CLIENT_ID` 無 `NEXT_PUBLIC_`
 * 前綴，且 `config` 在 client bundle eval 時會因缺 `REDIS_HOST` 等必填 env 直接 throw。
 * clientId 由 `IdleTimerProvider` 從 `useSession().clientId`（§2.5）傳入。
 *
 * 不暴露為 env var：閒置時長是 client policy（後端 ADR 007 規定 cms-web 必須 15 分鐘）。
 */
export type IdlePolicy = { idleTimeoutMs: number; warningMs: number };

/** idleTimeoutMs === 0 代表該 client_id 不啟用 idle timer */
const POLICIES: Record<string, IdlePolicy> = {
  'cms-web': { idleTimeoutMs: 15 * 60_000, warningMs: 30_000 },
  'public-web': { idleTimeoutMs: 0, warningMs: 0 }, // 0 = 不掛 timer
  // mobile / ios-app 不適用（不走 web）
};

export function idlePolicyFor(clientId: string): IdlePolicy {
  return POLICIES[clientId] ?? POLICIES['cms-web'];
}
