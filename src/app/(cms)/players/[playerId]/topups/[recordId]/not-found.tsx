import { FileQuestion } from 'lucide-react';

/**
 * 404 整頁狀態（spec 11 §5）。找不到此筆紀錄；提供回儲值列表 CTA。
 * not-found.tsx 取不到 route params，故回連至玩家清單。
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border bg-white py-16 text-center">
      <FileQuestion className="size-10 text-slate-400" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">找不到此筆紀錄</p>
      <p className="text-muted-foreground mt-1 text-sm">該紀錄不存在，或不屬於此玩家。</p>
      <a
        href="/players"
        className="mt-4 inline-flex items-center rounded-md border px-4 py-2 text-sm hover:bg-slate-50"
      >
        回儲值列表
      </a>
    </div>
  );
}
