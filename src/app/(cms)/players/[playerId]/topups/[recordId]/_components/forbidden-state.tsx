import { ShieldX } from 'lucide-react';

/**
 * 403 整頁狀態（spec 11 §5）。角色無權查看此筆紀錄。
 */
export function ForbiddenState() {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center"
    >
      <ShieldX className="size-10 text-red-500" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">無權查看</p>
      <p className="text-muted-foreground mt-1 text-sm">您的角色無權查看此筆紀錄</p>
    </div>
  );
}
