import { config } from '@/lib/config';

// Cookie 名稱：HTTPS 部署用 __Host- 前綴（強制 Secure + Path=/），
// HTTP 部署（如 ALB 直連）降級為 sid——__Host-/Secure 在 HTTP 下會被瀏覽器拒收。
export const SESSION_COOKIE_NAME = config.app.secureTransport ? '__Host-sid' : 'sid';

// Cookie 設定參數（供 cookies().set() 使用）
export function getCookieOptions(ttlSeconds: number) {
  return {
    httpOnly: true,
    secure: config.app.secureTransport, // 僅 HTTPS 部署帶 Secure
    sameSite: 'lax' as const, // CSRF 防護
    path: '/' as const,
    maxAge: ttlSeconds, // 秒數
    domain: config.session.cookieDomain, // 若未設則為 undefined（host-only cookie）
  };
}
