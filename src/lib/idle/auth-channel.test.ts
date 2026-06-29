import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAuthChannel, type AuthChannelMessage } from './auth-channel';

const CHANNEL = 'auth'; // 與實作內部固定名稱一致（§5.6）
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// 每個測試各自建立的 channel/raw 都登記，afterEach 統一清理避免跨測試串訊息
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await tick();
  while (cleanups.length) cleanups.pop()!();
});

/** 模擬「另一個分頁」的原生 channel；回傳含 post 與收到的訊息陣列 */
function otherTab() {
  const bc = new BroadcastChannel(CHANNEL);
  const received: AuthChannelMessage[] = [];
  bc.onmessage = (e) => received.push(e.data as AuthChannelMessage);
  cleanups.push(() => bc.close());
  return {
    post: (msg: AuthChannelMessage) => bc.postMessage(msg),
    received,
  };
}

describe('createAuthChannel', () => {
  it('should deliver an inbound message from another tab to onMessage', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({ onMessage });
    cleanups.push(() => ch.dispose());
    otherTab().post({ type: 'activity', at: 1, nonce: 'from-other' });
    await tick();
    expect(onMessage).toHaveBeenCalledWith({ type: 'activity', at: 1, nonce: 'from-other' });
  });

  it('should attach nonce to every outbound message', async () => {
    const other = otherTab();
    const ch = createAuthChannel({ onMessage: vi.fn() });
    cleanups.push(() => ch.dispose());
    ch.postActivity(1);
    ch.postWarning(2);
    ch.postLogout(3);
    ch.postLogin('u-1', 4);
    await tick();
    expect(other.received).toHaveLength(4);
    for (const msg of other.received) {
      expect(typeof msg.nonce).toBe('string');
      expect(msg.nonce.length).toBeGreaterThan(0);
    }
  });

  it('should drop messages whose nonce matches own emission Set (echo suppression)', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({ onMessage, deps: { nonce: () => 'n1' } });
    cleanups.push(() => ch.dispose());
    ch.postActivity(1); // own set 記下 'n1'
    otherTab().post({ type: 'activity', at: 2, nonce: 'n1' }); // 帶自己的 nonce 回來
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('should drop logout whose at < currentSession.createdAt (stale-session guard)', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({
      currentSession: { createdAt: 1000, userId: 'u-1' },
      onMessage,
    });
    cleanups.push(() => ch.dispose());
    otherTab().post({ type: 'logout', at: 500, nonce: 'x' }); // 早於本 session
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('should drop activity while local loggingOut === true', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({
      currentSession: { createdAt: 0, userId: 'u-1' },
      onMessage,
    });
    cleanups.push(() => ch.dispose());
    ch.postLogout(10); // 本分頁進入 logout 流程
    otherTab().post({ type: 'activity', at: 20, nonce: 'y' });
    await tick();
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'activity' }));
  });

  it('should drop login whose userId equals currentUserId', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({
      currentSession: { createdAt: 0, userId: 'u-1' },
      onMessage,
    });
    cleanups.push(() => ch.dispose());
    otherTab().post({ type: 'login', at: 5, nonce: 'z', userId: 'u-1' });
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('should deliver a fresh warning broadcast from another tab', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({ onMessage });
    cleanups.push(() => ch.dispose());
    otherTab().post({ type: 'warning', at: 5, nonce: 'w-fresh' });
    await tick();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('should drop warning whose at < own last broadcast warning at (§5.6 self-newer)', async () => {
    const onMessage = vi.fn();
    const ch = createAuthChannel({ onMessage });
    cleanups.push(() => ch.dispose());
    ch.postWarning(1000); // 本分頁已在 1000 顯示警告
    otherTab().post({ type: 'warning', at: 500, nonce: 'w-stale' }); // 更舊
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('should release own-emission nonce after reasonable TTL (memory bound)', async () => {
    const onMessage = vi.fn();
    let clock = 0;
    const ch = createAuthChannel({
      onMessage,
      nonceTtlMs: 1000,
      deps: { nonce: () => 'n1', now: () => clock },
    });
    cleanups.push(() => ch.dispose());
    ch.postActivity(); // own set: n1 @ expireAt 1000
    clock = 1001; // 過 TTL
    otherTab().post({ type: 'activity', at: 1001, nonce: 'n1' });
    await tick();
    // n1 已 evict → 不再被當成自己的 echo → 正常派發
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'activity', nonce: 'n1' })
    );
  });

  it('should close() the underlying BroadcastChannel and stop emitting on dispose', async () => {
    const other = otherTab();
    const ch = createAuthChannel({ onMessage: vi.fn() });
    ch.dispose();
    ch.dispose(); // 多次安全
    ch.postActivity(1); // dispose 後不應送出
    await tick();
    expect(other.received).toHaveLength(0);
  });

  it('should feature-detect BroadcastChannel and become a no-op when undefined', async () => {
    const saved = globalThis.BroadcastChannel;
    // @ts-expect-error 故意移除以模擬 SSR / 不支援環境
    delete globalThis.BroadcastChannel;
    try {
      const onMessage = vi.fn();
      const ch = createAuthChannel({ onMessage });
      expect(() => {
        ch.postActivity(1);
        ch.postLogout(2);
        ch.dispose();
      }).not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      globalThis.BroadcastChannel = saved;
    }
  });
});
