import { config } from '@/lib/config';

// Cookie 名稱：production 用 __Host- 前綴（強制 Secure + Path=/），dev 用 sid
export const SESSION_COOKIE_NAME = config.isProd ? '__Host-sid' : 'sid';

// Cookie 設定參數（供 cookies().set() 使用）
export function getCookieOptions(ttlSeconds: number) {
  return {
    httpOnly: true,
    secure: config.isProd, // production 強制 HTTPS only
    sameSite: 'lax' as const, // CSRF 防護
    path: '/' as const,
    maxAge: ttlSeconds, // 秒數
    domain: config.session.cookieDomain, // 若未設則為 undefined（host-only cookie）
  };
}
