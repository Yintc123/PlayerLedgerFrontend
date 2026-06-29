/**
 * BroadcastChannel('auth') 包裝 + stale 判定（spec 02 §5.6）。
 *
 * 用途：跨分頁同步 idle activity / logout / login，讓 idle timer 以「整個瀏覽器
 * session」為單位而非單一分頁（避免「A 分頁有人用、B 分頁閒置把大家踢出」）。
 *
 * - **echo 抑制**：每則 outbound 帶 nonce 並記入 own-set；自己 echo 回來時跳過。
 *   own-set 以 TTL（預設 60s）lazy expiry + post 時 sweep，記憶體有界。
 * - **stale 防護**：丟棄更早 session 的 logout、同帳號 login、本分頁 logout 中的 activity。
 * - **降級**：`BroadcastChannel` 不存在（SSR / Safari sandbox）→ 回 no-op handle。
 */

export type AuthChannelMessage =
  | { type: 'activity'; at: number; nonce: string }
  | { type: 'warning'; at: number; nonce: string }
  | { type: 'logout'; at: number; nonce: string }
  | { type: 'login'; at: number; nonce: string; userId: string };

export type AuthChannelOpts = {
  /** 用於 stale 過濾；缺漏代表「不過濾 createdAt」（如未登入頁面） */
  currentSession?: { createdAt: number; userId: string };
  onMessage: (msg: AuthChannelMessage) => void;
  /** 預設 60_000；own-nonce 在這個 ms 後 evict（lazy expiry + post 時 sweep） */
  nonceTtlMs?: number;
  /** 測試注入：預設 Date.now / crypto.randomUUID */
  deps?: { now?: () => number; nonce?: () => string };
};

export type AuthChannelHandle = {
  postActivity(at?: number): void;
  postWarning(at?: number): void;
  postLogout(at?: number): void;
  postLogin(userId: string, at?: number): void;
  /** close 底層 channel，停止 emit / receive；多次呼叫安全 */
  dispose(): void;
};

const DEFAULT_NONCE_TTL_MS = 60_000;
const CHANNEL_NAME = 'auth';

const NOOP_HANDLE: AuthChannelHandle = {
  postActivity() {},
  postWarning() {},
  postLogout() {},
  postLogin() {},
  dispose() {},
};

export function createAuthChannel(opts: AuthChannelOpts): AuthChannelHandle {
  // feature detect：SSR / 不支援環境 → no-op（不掛 listener、post 全為空函式）
  if (typeof BroadcastChannel === 'undefined') return NOOP_HANDLE;

  const now = opts.deps?.now ?? (() => Date.now());
  const genNonce = opts.deps?.nonce ?? (() => crypto.randomUUID());
  const ttl = opts.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;

  const ownNonces = new Map<string, number>(); // nonce -> expireAt
  let loggingOut = false;
  let disposed = false;
  let lastOwnWarningAt = Number.NEGATIVE_INFINITY; // §5.6：本分頁最後一次顯示警告的 at

  const bc = new BroadcastChannel(CHANNEL_NAME);

  const sweep = () => {
    const t = now();
    for (const [n, expireAt] of ownNonces) {
      if (expireAt <= t) ownNonces.delete(n);
    }
  };

  const post = (msg: AuthChannelMessage) => {
    if (disposed) return;
    ownNonces.set(msg.nonce, now() + ttl);
    sweep();
    bc.postMessage(msg);
  };

  const shouldDeliver = (msg: AuthChannelMessage): boolean => {
    // echo 抑制：自己發過且仍在 TTL 內的 nonce
    const expireAt = ownNonces.get(msg.nonce);
    if (expireAt !== undefined) {
      if (now() < expireAt) return false;
      ownNonces.delete(msg.nonce); // 已過 TTL → 清掉並照常處理
    }
    switch (msg.type) {
      case 'logout':
        // 更早 session 的 logout echo（§5.6 stale-session guard）
        return !(opts.currentSession && msg.at < opts.currentSession.createdAt);
      case 'activity':
        // 本分頁正在 logout 流程，不因他頁 activity 延長壽命
        return !loggingOut;
      case 'login':
        // 同帳號（重新整理 / 多分頁同帳號登入）
        return !(opts.currentSession && msg.userId === opts.currentSession.userId);
      case 'warning':
        // 本分頁自己更新（warningShownAt > 訊息 at）→ 丟棄較舊的 echo（§5.6）
        return !(msg.at < lastOwnWarningAt);
    }
  };

  bc.onmessage = (e: MessageEvent) => {
    if (disposed) return;
    const msg = e.data as AuthChannelMessage;
    if (shouldDeliver(msg)) opts.onMessage(msg);
  };

  return {
    postActivity(at = now()) {
      post({ type: 'activity', at, nonce: genNonce() });
    },
    postWarning(at = now()) {
      lastOwnWarningAt = at;
      post({ type: 'warning', at, nonce: genNonce() });
    },
    postLogout(at = now()) {
      loggingOut = true; // 之後收到的 activity 一律丟棄
      post({ type: 'logout', at, nonce: genNonce() });
    },
    postLogin(userId, at = now()) {
      post({ type: 'login', at, nonce: genNonce(), userId });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bc.onmessage = null;
      bc.close();
    },
  };
}
