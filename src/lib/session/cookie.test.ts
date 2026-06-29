import { describe, it, expect, vi, afterEach } from 'vitest';

// cookie.ts 在 module load 時依 config.app.secureTransport 計算 SESSION_COOKIE_NAME，
// 故每個分支需以 mock config + 重新 import 驗證。
async function loadCookie(secureTransport: boolean, cookieDomain?: string) {
  vi.resetModules();
  vi.doMock('@/lib/config', () => ({
    config: {
      app: { secureTransport },
      session: { cookieDomain },
    },
  }));
  return import('./cookie');
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/config');
});

describe('Cookie Configuration (§2.4)', () => {
  describe('SESSION_COOKIE_NAME', () => {
    it('should use __Host-sid when secureTransport is true (HTTPS)', async () => {
      const { SESSION_COOKIE_NAME } = await loadCookie(true);
      expect(SESSION_COOKIE_NAME).toBe('__Host-sid');
    });

    it('should fall back to sid when secureTransport is false (ALB HTTP 直連)', async () => {
      // __Host- 前綴要求 Secure，HTTP 下瀏覽器會拒收，故必須降級為 sid
      const { SESSION_COOKIE_NAME } = await loadCookie(false);
      expect(SESSION_COOKIE_NAME).toBe('sid');
    });
  });

  describe('getCookieOptions', () => {
    it('should set Secure flag when secureTransport is true', async () => {
      const { getCookieOptions } = await loadCookie(true);
      expect(getCookieOptions(60).secure).toBe(true);
    });

    it('should NOT set Secure flag when secureTransport is false', async () => {
      const { getCookieOptions } = await loadCookie(false);
      expect(getCookieOptions(60).secure).toBe(false);
    });

    it('should always set HttpOnly, SameSite=Lax, Path=/ and the given Max-Age', async () => {
      const { getCookieOptions } = await loadCookie(true);
      const opts = getCookieOptions(123);
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
      expect(opts.path).toBe('/');
      expect(opts.maxAge).toBe(123);
    });

    it('should omit Domain (host-only cookie) when cookieDomain is unset', async () => {
      const { getCookieOptions } = await loadCookie(true);
      expect(getCookieOptions(1).domain).toBeUndefined();
    });

    it('should include Domain when cookieDomain is set', async () => {
      const { getCookieOptions } = await loadCookie(true, 'app.example.com');
      expect(getCookieOptions(1).domain).toBe('app.example.com');
    });
  });
});
