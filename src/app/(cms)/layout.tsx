import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie';
import { verifySession } from '@/lib/session/session';
import { decodeAccessToken, type TokenClaims } from '@/lib/auth/decode-token';
import { SessionProvider, type ClientSession } from '@/lib/session/client-session';
import { IdleTimerProvider } from '@/components/idle-timer-provider';
import { CmsShell } from './_components/cms-shell';

/**
 * 受保護的 layout（CMSWeb 應用）
 * Server Component 進行 session 驗證，失敗時重導向 login
 */
export default async function CMSLayout({ children }: { children: React.ReactNode }) {
  // 讀取 session
  const cookieStore = await cookies();
  const sid = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!sid) {
    redirect('/login');
  }

  const session = await verifySession(sid);
  if (!session) {
    redirect('/login');
  }

  // 解出 role（spec 07 §3.2）：access token claims 為角色單一可信來源，僅 decode 不驗簽。
  // decode 失敗 → session 受污染 / token 損毀，導回 login（防禦深度）。
  let claims: TokenClaims;
  try {
    claims = decodeAccessToken(session.accessToken);
  } catch {
    redirect('/login');
  }

  // CMS 不該出現玩家端 token（utype === 'member'）；視為 session 受污染，導回 login（spec 07 §3.2）
  if (claims.userType !== 'cms') {
    redirect('/login');
  }

  // 轉換為 ClientSession（去掉敏感欄位）
  const clientSession: ClientSession = {
    userId: session.userId,
    clientId: session.clientId,
    absoluteExpiresAt: session.absoluteExpiresAt,
    createdAt: session.createdAt,
    role: claims.role,
  };

  return (
    <SessionProvider initialSession={clientSession}>
      <IdleTimerProvider>
        <CmsShell>{children}</CmsShell>
      </IdleTimerProvider>
    </SessionProvider>
  );
}
