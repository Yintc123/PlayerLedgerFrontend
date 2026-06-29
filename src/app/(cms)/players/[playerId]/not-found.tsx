import { SearchX } from 'lucide-react';

/**
 * 404 玩家不存在（spec 09 §5 / §5.2）。由 page.tsx 的 `notFound()` 觸發。
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white py-20 text-center">
      <SearchX className="text-muted-foreground size-10" aria-hidden="true" />
      <p className="mt-4 text-sm font-medium">找不到此玩家</p>
      <p className="text-muted-foreground mt-1 text-sm">此玩家可能不存在，或 ID 有誤。</p>
      <a
        href="/players"
        className="bg-background hover:bg-accent mt-4 inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs"
      >
        回搜尋頁
      </a>
    </div>
  );
}
