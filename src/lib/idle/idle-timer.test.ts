import { describe, it, expect, vi } from 'vitest';
import {
  createIdleTimer,
  MAX_SAFE_TIMEOUT,
  type IdleTimerEvent,
  type IdleTimerOpts,
} from './idle-timer';

const MIN = 60_000;
const IDLE = 15 * MIN; // cms-web
const WARN = 30_000;

/**
 * Fake clock + fake scheduler harness（§5.5.2.1 deps 注入）。
 * - `now()` 由 harness 控制；`advance` / `setNow` 推進 wall-clock
 * - `setTimer` 只記錄 (fn, ms)；`fire()` 模擬 setTimeout 到點觸發
 *   reschedule 每次 clear→set，故同時最多一個 pending timer。
 */
function harness(overrides: Partial<IdleTimerOpts> = {}) {
  let now = 0;
  let nextId = 1;
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  const events: IdleTimerEvent[] = [];

  const timer = createIdleTimer({
    idleTimeoutMs: IDLE,
    warningMs: WARN,
    absoluteExpiresAt: Number.MAX_SAFE_INTEGER, // 預設 abs_exp 不干擾，個別測試覆寫
    onEvent: (e) => events.push(e),
    deps: {
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, ms });
        return id;
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    ...overrides,
  });

  return {
    timer,
    events,
    setNow: (n: number) => {
      now = n;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** 觸發目前排定的 timer（模擬 setTimeout 到點） */
    fire: () => {
      const t = timers.shift();
      if (t) t.fn();
    },
    lastDelay: () => timers[timers.length - 1]?.ms,
    pendingCount: () => timers.length,
  };
}

describe('createIdleTimer', () => {
  // ── 計時 & throttle ─────────────────────────────────────────────
  it('should reset lastActivityAt on touch within throttle window without emit', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0 啟動，排程
    h.advance(500); // < 1000ms throttle window
    const onEventCalls = h.events.length;
    h.timer.notifyActivity();
    // 仍重置 lastActivityAt（remainingMs 以新 expiry 計），但不重排、不 emit
    expect(h.timer.remainingMs()).toBe(IDLE);
    expect(h.events.length).toBe(onEventCalls);
  });

  it('should reset lastActivityAt and schedule expiry on touch outside throttle window', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0
    h.advance(2000); // > throttle window
    h.timer.notifyActivity();
    expect(h.timer.remainingMs()).toBe(IDLE);
    // 重新排程：下次喚醒在 warning 前（remaining - warningMs）
    expect(h.lastDelay()).toBe(IDLE - WARN);
  });

  it('should call onExpire exactly once when timer reaches IDLE_TIMEOUT_MS', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0，排程 warning 點
    h.advance(IDLE - WARN);
    h.fire(); // 抵達 warning → emit warning，排程到 expiry
    h.advance(WARN);
    h.fire(); // 抵達 expiry → expire
    const expires = h.events.filter((e) => e.type === 'expire');
    expect(expires).toHaveLength(1);
  });

  it('should NOT call onExpire when activity occurs before timeout', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.advance(IDLE - WARN);
    h.fire(); // warning 點
    h.advance(2000);
    h.timer.notifyActivity(); // 使用者回來
    expect(h.events.some((e) => e.type === 'expire')).toBe(false);
  });

  it('should be a no-op after loggingOut flag is set (idempotent)', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.timer.forceExpire('manual'); // loggingOut = true
    const after = h.events.length;
    h.timer.notifyActivity();
    h.timer.forceExpire('manual');
    expect(h.events.length).toBe(after);
  });

  // ── wall-clock 容錯 ─────────────────────────────────────────────
  it('should onExpire immediately when Date.now() jumps past expiryAt (laptop sleep)', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0
    h.setNow(IDLE + 10 * MIN); // 休眠後醒來，已過期
    h.fire(); // 排定的喚醒觸發 → reschedule 以 wall-clock 重算 → expire
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  it('should NOT panic on negative delta (system clock moved backwards)', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0，lastActivityAt=0
    h.setNow(-5000); // 時鐘倒退
    h.timer.forceExpire('manual');
    const expire = h.events.find((e) => e.type === 'expire');
    expect(expire).toMatchObject({ type: 'expire' });
    if (expire?.type === 'expire') expect(expire.idleMs).toBeGreaterThanOrEqual(0);
  });

  it('should re-clamp setTimeout delay to MAX_SAFE_TIMEOUT when remaining > 2^31-1 ms', () => {
    const huge = 40 * 24 * 60 * MIN; // 40 天 > 2^31-1 ms
    const h = harness({ idleTimeoutMs: huge, absoluteExpiresAt: Number.MAX_SAFE_INTEGER });
    h.timer.notifyActivity();
    expect(h.lastDelay()).toBe(MAX_SAFE_TIMEOUT);
  });

  // ── abs_exp short-circuit ───────────────────────────────────────
  it('should use absoluteExpiresAt when it is earlier than idle expiry', () => {
    const h = harness({ absoluteExpiresAt: 5 * MIN }); // 早於 15min idle
    h.timer.notifyActivity(); // t=0
    expect(h.timer.remainingMs()).toBe(5 * MIN);
  });

  it('should onExpire immediately when absoluteExpiresAt already passed at start', () => {
    const h = harness({ absoluteExpiresAt: -1 });
    h.timer.notifyActivity(); // 首次排程即發現 remaining<=0
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  it('should emit expire event even on abs_exp short-circuit (feeds idle_logout log)', () => {
    const h = harness({ absoluteExpiresAt: 5 * MIN });
    h.timer.notifyActivity();
    h.setNow(5 * MIN);
    h.fire();
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  // ── 警告階段 ────────────────────────────────────────────────────
  it('should emit warning event when remaining time <= WARNING_MS', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.advance(IDLE - WARN);
    h.fire(); // 抵達 warning 點
    const warning = h.events.find((e) => e.type === 'warning');
    expect(warning).toMatchObject({ type: 'warning' });
    if (warning?.type === 'warning') expect(warning.remainingMs).toBe(WARN);
  });

  it('should emit warning at most once per idle cycle', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.advance(IDLE - WARN);
    h.fire(); // warning
    h.advance(10_000);
    h.fire(); // 再次 reschedule，但同 cycle 不應重複 warning
    expect(h.events.filter((e) => e.type === 'warning')).toHaveLength(1);
  });

  it('should clear warning state when activity resets the timer', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.advance(IDLE - WARN);
    h.fire(); // warning（cycle 1）
    h.timer.notifyActivity(); // 使用者回來 → 清 warning，開新 cycle
    h.advance(IDLE - WARN);
    h.fire(); // warning（cycle 2）
    expect(h.events.filter((e) => e.type === 'warning')).toHaveLength(2);
  });

  // ── 事件 emission（onEvent 派發；log/metric 由 provider 接，§5.5.6）──
  it('should emit expire event with idleMs at expire', () => {
    const h = harness();
    h.timer.notifyActivity(); // t=0
    h.advance(IDLE - WARN);
    h.fire();
    h.advance(WARN);
    h.fire(); // expire at t=IDLE
    const expire = h.events.find((e) => e.type === 'expire');
    if (expire?.type === 'expire') expect(expire.idleMs).toBe(IDLE);
    else throw new Error('expected expire event');
  });

  it('should emit extended event (via activity) when warning dismissed by activity', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.advance(IDLE - WARN);
    h.fire(); // warning
    h.timer.notifyActivity(); // 使用者互動關掉警告
    expect(h.events).toContainEqual({ type: 'extended', via: 'activity' });
  });

  // ── lifecycle ───────────────────────────────────────────────────
  it('should be safe to call dispose multiple times and stop further events', () => {
    const h = harness();
    h.timer.notifyActivity();
    h.timer.dispose();
    h.timer.dispose();
    const after = h.events.length;
    h.advance(IDLE);
    h.fire(); // 已 dispose，無 pending → 無效果
    h.timer.notifyActivity();
    expect(h.events.length).toBe(after);
    expect(h.pendingCount()).toBe(0);
  });

  it('should force a single expire event on forceExpire', () => {
    const onEvent = vi.fn();
    const h = harness({ onEvent });
    h.timer.notifyActivity();
    h.timer.forceExpire('manual');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'expire' }));
    expect(onEvent.mock.calls.filter((c) => c[0].type === 'expire')).toHaveLength(1);
  });
});
