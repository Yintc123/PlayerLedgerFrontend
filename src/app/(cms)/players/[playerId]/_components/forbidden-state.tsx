import { ShieldX } from 'lucide-react';

/**
 * 403 整頁錯誤態（spec 09 §5 / §6）。Server Component：純文案，不另顯示玩家資訊。
 */
export function ForbiddenState() {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      <ShieldX className="size-10 text-red-500" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">您的角色無權查看此玩家</p>
      <p className="text-muted-foreground mt-1 text-sm">如需查看，請洽系統管理員調整權限。</p>
    </div>
  );
}
