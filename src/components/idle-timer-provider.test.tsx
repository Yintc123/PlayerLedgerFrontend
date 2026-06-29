// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SessionProvider, type ClientSession } from '@/lib/session/client-session';
import { IdleTimerProvider } from './idle-timer-provider';

const MIN = 60_000;
const IDLE = 15 * MIN;
const WARN = 30_000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];

let replaceSpy: ReturnType<typeof vi.fn>;
let beaconSpy: ReturnType<typeof vi.fn>;
let visState: DocumentVisibilityState;

beforeEach(() => {
  replaceSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { replace: replaceSpy, href: 'http://localhost/players' },
  });
  visState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visState });
  beaconSpy = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beaconSpy });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeSession(overrides: Partial<ClientSession> = {}): ClientSession {
  return {
    userId: 'u-1',
    clientId: 'cms-web',
    absoluteExpiresAt: Date.now() + 8 * 3600_000,
    createdAt: Date.now(),
    role: 'admin',
    ...overrides,
  };
}

function renderProvider(session: ClientSession = makeSession()) {
  return render(
    <SessionProvider initialSession={session}>
      <IdleTimerProvider>
        <button>child</button>
      </IdleTimerProvider>
    </SessionProvider>
  );
}

describe('IdleTimerProvider — mount / policy', () => {
  it('should attach passive listeners on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderProvider();
    const calls = addSpy.mock.calls.filter((c) => ACTIVITY_EVENTS.includes(c[0]));
    expect(calls).toHaveLength(ACTIVITY_EVENTS.length);
    for (const c of calls) expect((c[2] as AddEventListenerOptions).passive).toBe(true);
  });

  it('should use AbortController.signal so all listeners are cleaned up together', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderProvider();
    const calls = addSpy.mock.calls.filter((c) => ACTIVITY_EVENTS.includes(c[0]));
    for (const c of calls) {
      expect((c[2] as AddEventListenerOptions).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('should NOT mount listeners when idlePolicyFor(clientId).idleTimeoutMs === 0 (public-web)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderProvider(makeSession({ clientId: 'public-web' }));
    expect(addSpy.mock.calls.filter((c) => c[0] === 'mousemove')).toHaveLength(0);
    expect(screen.getByText('child')).toBeInTheDocument();
  });

  it('should select policy from useSession().clientId (not from server-only @/lib/config)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { unmount } = renderProvider(makeSession({ clientId: 'public-web' }));
    expect(addSpy.mock.calls.some((c) => c[0] === 'mousemove')).toBe(false);
    unmount();
    addSpy.mockClear();
    renderProvider(makeSession({ clientId: 'cms-web' }));
    expect(addSpy.mock.calls.some((c) => c[0] === 'mousemove')).toBe(true);
  });
});

describe('IdleTimerProvider — timing (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should reset timer on any of [mousemove, mousedown, keydown, wheel, touchstart, scroll]', () => {
    for (const ev of ACTIVITY_EVENTS) {
      const { unmount } = renderProvider();
      act(() => vi.advanceTimersByTime(IDLE - WARN - 5000)); // 5s 前
      act(() => {
        window.dispatchEvent(new Event(ev));
      }); // 重置
      act(() => vi.advanceTimersByTime(10_000)); // 跨過原警告點
      expect(screen.queryByRole('alertdialog')).toBeNull();
      unmount();
    }
  });

  it('should reschedule on document visibilitychange to visible', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE - WARN - 5000));
    visState = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('should show IdleWarningModal when warning phase triggers', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE - WARN));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/30/)).toBeInTheDocument();
  });

  it('should call fetch /api/logout with credentials: same-origin and keepalive: true', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE));
    expect(fetch).toHaveBeenCalledWith(
      '/api/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', keepalive: true })
    );
  });

  it('should call navigator.sendBeacon when document hidden at expiry time', () => {
    renderProvider();
    visState = 'hidden';
    act(() => vi.advanceTimersByTime(IDLE));
    expect(beaconSpy).toHaveBeenCalledWith('/api/logout');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should navigate to /login?reason=idle_timeout after logout', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE));
    expect(replaceSpy).toHaveBeenCalledWith('/login?reason=idle_timeout');
  });

  it('should set loggingOut flag before fetch to prevent re-entry', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE));
    act(() => vi.advanceTimersByTime(IDLE)); // 再推進不應再次登出
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('should NOT throw if /api/logout fetch rejects', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    renderProvider();
    expect(() => act(() => vi.advanceTimersByTime(IDLE))).not.toThrow();
    expect(replaceSpy).toHaveBeenCalledWith('/login?reason=idle_timeout');
  });

  it('should reset timer and close modal when "繼續工作" clicked', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE - WARN));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByRole('button', { name: /繼續/ })));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => vi.advanceTimersByTime(WARN + 5000)); // 跨過原到期點
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('should expire immediately when "立即登出" clicked', () => {
    renderProvider();
    act(() => vi.advanceTimersByTime(IDLE - WARN));
    act(() => fireEvent.click(screen.getByRole('button', { name: /立即登出/ })));
    expect(replaceSpy).toHaveBeenCalledWith('/login?reason=idle_timeout');
    expect(fetch).toHaveBeenCalled();
  });
});

describe('IdleTimerProvider — cross-tab (real timers)', () => {
  const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

  it('should broadcast activity on local DOM event', async () => {
    const raw = new BroadcastChannel('auth');
    const got: Array<{ type: string }> = [];
    raw.onmessage = (e) => got.push(e.data);
    renderProvider();
    window.dispatchEvent(new Event('mousemove'));
    await waitFor(() => expect(got.some((m) => m.type === 'activity')).toBe(true));
    raw.close();
  });

  it('should navigate to /login when receiving fresh logout broadcast', async () => {
    renderProvider(makeSession({ createdAt: 1000 }));
    const raw = new BroadcastChannel('auth');
    raw.postMessage({ type: 'logout', at: 2000, nonce: 'other-tab' });
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith('/login?reason=idle_timeout'));
    raw.close();
  });

  it('should not respond to own broadcasts (echo suppression)', async () => {
    renderProvider();
    window.dispatchEvent(new Event('mousemove')); // provider 廣播自己的 activity
    await settle(); // 給 BroadcastChannel 充分交付時間，確認仍不導頁
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('should detach listeners on unmount (no broadcast after unmount)', async () => {
    const { unmount } = renderProvider();
    unmount();
    const raw = new BroadcastChannel('auth');
    const got: unknown[] = [];
    raw.onmessage = (e) => got.push(e.data);
    window.dispatchEvent(new Event('mousemove'));
    await settle();
    expect(got).toHaveLength(0);
    raw.close();
  });
});
