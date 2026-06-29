/**
 * 閒置計時器純邏輯（spec 02 §5.5.2.1 契約 / §5.5.3 演算法）。
 *
 * 設計重點：
 * - **純邏輯、無 React、無瀏覽器全域**：時間與排程都走 `deps` 注入，vitest 免 jsdom 即可測。
 * - **wall-clock 為事實來源**：狀態只有 `lastActivityAt`（`now()`）；`setTimer` 只是「該重算了」
 *   的觸發點，不持有計時邏輯。筆電休眠 / Tab 凍結 / clock drift 後以 wall-clock 重算剩餘時間。
 * - **abs_exp short-circuit**：剩餘時間以 `min(expiryAt, absoluteExpiresAt)` 為準。
 * - 只 `onEvent` 派發事件型別，**不**直接 import logger / metric（emission 在 provider，§5.5.6）。
 */

export type IdleTimerEvent =
  | { type: 'warning'; remainingMs: number }
  | { type: 'extended'; via: 'activity' | 'click' } // log 用
  | { type: 'expire'; idleMs: number };

export type IdleTimerDeps = {
  /** wall-clock 取得，測試可注入 fake clock */
  now: () => number;
  /** 在指定 ms 後執行 fn，回傳可取消的 handle；測試可注入 fake scheduler */
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export type IdleTimerOpts = {
  idleTimeoutMs: number;
  warningMs: number;
  absoluteExpiresAt: number; // 來自 ClientSession（§2.5）
  onEvent: (e: IdleTimerEvent) => void;
  deps?: Partial<IdleTimerDeps>; // 預設 Date.now / setTimeout / clearTimeout
};

export type IdleTimerHandle = {
  /** 由 DOM activity 或 cross-tab 廣播觸發；自動 throttle 1s */
  notifyActivity(at?: number): void;
  /** 由「立即登出」按鈕觸發；強制 onEvent({type:'expire',...}) 一次 */
  forceExpire(reason: 'manual'): void;
  /** 解綁所有 timer，多次呼叫安全 */
  dispose(): void;
  /** 偵錯用，回傳當下計算的剩餘 ms（不變更狀態） */
  remainingMs(): number;
};

/** setTimeout 當延遲 > 2^31-1 (~24.85 天) 會立刻觸發；超過時 clamp（§5.5.3）。 */
export const MAX_SAFE_TIMEOUT = 2_147_483_647;

const THROTTLE_MS = 1000;

const defaultDeps: IdleTimerDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 不啟動 timer；呼叫 `notifyActivity()` 才開始計時。Provider mount 後立即叫一次。
 */
export function createIdleTimer(opts: IdleTimerOpts): IdleTimerHandle {
  const { idleTimeoutMs, warningMs, absoluteExpiresAt, onEvent } = opts;
  const deps: IdleTimerDeps = { ...defaultDeps, ...opts.deps };

  let lastActivityAt = deps.now();
  let expiryAt = lastActivityAt + idleTimeoutMs;
  let warningShownAt: number | null = null; // 每個 idle cycle 的 warning 守門
  let lastRescheduleAt = Number.NEGATIVE_INFINITY; // throttle 錨點（首次必過）
  let timerHandle: unknown = null;
  let loggingOut = false; // expire 後 idempotent
  let disposed = false;

  const effectiveExpiry = () => Math.min(expiryAt, absoluteExpiresAt);

  const cancelTimer = () => {
    if (timerHandle !== null) {
      deps.clearTimer(timerHandle);
      timerHandle = null;
    }
  };

  const expire = () => {
    if (loggingOut || disposed) return; // exactly once
    loggingOut = true;
    cancelTimer();
    const idleMs = Math.max(deps.now() - lastActivityAt, 0); // clock 倒退保護
    onEvent({ type: 'expire', idleMs });
  };

  const reschedule = () => {
    if (loggingOut || disposed) return;
    cancelTimer();
    const remaining = effectiveExpiry() - deps.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    if (remaining <= warningMs) {
      if (warningShownAt === null) {
        warningShownAt = deps.now();
        onEvent({ type: 'warning', remainingMs: remaining });
      }
      // 已在警告窗：下次喚醒排到 expiry
      timerHandle = deps.setTimer(reschedule, Math.min(remaining, MAX_SAFE_TIMEOUT));
    } else {
      // 尚未進入警告窗：下次喚醒排到「警告點」（remaining - warningMs）
      const untilWarning = remaining - warningMs;
      timerHandle = deps.setTimer(reschedule, Math.min(untilWarning, MAX_SAFE_TIMEOUT));
    }
  };

  return {
    notifyActivity(at = deps.now()) {
      if (loggingOut || disposed) return;
      const wasWarning = warningShownAt !== null;
      // 永遠更新活動時間（wall-clock 精度），即使在 throttle 窗內
      lastActivityAt = at;
      expiryAt = at + idleTimeoutMs;
      if (wasWarning) {
        warningShownAt = null; // 開新 cycle
        onEvent({ type: 'extended', via: 'activity' });
      }
      // throttle：窗內不重排、不 emit（warning 解除為有意義狀態變化，繞過 throttle）
      if (!wasWarning && at - lastRescheduleAt < THROTTLE_MS) return;
      lastRescheduleAt = at;
      reschedule();
    },

    forceExpire() {
      expire();
    },

    dispose() {
      disposed = true;
      cancelTimer();
    },

    remainingMs() {
      return effectiveExpiry() - deps.now();
    },
  };
}
