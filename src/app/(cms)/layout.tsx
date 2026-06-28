import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie'
import { verifySession } from '@/lib/session/session'
import { SessionProvider, type ClientSession } from '@/lib/session/client-session'

/**
 * 受保護的 layout（CMSWeb 應用）
 * Server Component 進行 session 驗證，失敗時重導向 login
 */
export default async function CMSLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 讀取 session
  const cookieStore = await cookies()
  const sid = cookieStore.get(SESSION_COOKIE_NAME)?.value

  if (!sid) {
    redirect('/login')
  }

  const session = await verifySession(sid)
  if (!session) {
    redirect('/login')
  }

  // 轉換為 ClientSession（去掉敏感欄位）
  const clientSession: ClientSession = {
    userId: session.userId,
    clientId: session.clientId,
    absoluteExpiresAt: session.absoluteExpiresAt,
    createdAt: session.createdAt,
  }

  return (
    <SessionProvider initialSession={clientSession}>
      {children}
    </SessionProvider>
  )
}
