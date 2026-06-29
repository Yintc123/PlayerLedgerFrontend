import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { LogoutButton } from './logout-button';

/**
 * CMS 後台外殼：頂部導覽 + 內容容器。
 * 所有受保護頁面共用；session 驗證已在 (cms)/layout.tsx 完成。
 */
export function CmsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/players" className="flex items-center gap-2 font-semibold">
              <span className="bg-foreground text-background flex size-7 items-center justify-center rounded-lg">
                <Wallet className="size-4" aria-hidden="true" />
              </span>
              PlayerLedger
            </Link>
            <nav aria-label="主導覽" className="hidden items-center gap-1 text-sm sm:flex">
              <Link
                href="/players"
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 hover:bg-slate-100"
              >
                玩家搜尋
              </Link>
              <Link
                href="/deposit-records"
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 hover:bg-slate-100"
              >
                儲值紀錄
              </Link>
            </nav>
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
