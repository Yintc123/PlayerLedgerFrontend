/**
 * 列表頁載入態（spec 10 §8）。skeleton 篩選列 + 表格列。
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-live="polite" aria-busy="true">
      <div className="h-9 w-40 animate-pulse rounded bg-slate-200" />
      <div className="h-28 animate-pulse rounded-xl border bg-white" />
      <div className="overflow-hidden rounded-xl border bg-white">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse border-b bg-slate-50 last:border-b-0" />
        ))}
      </div>
      <span className="sr-only">載入中</span>
    </div>
  );
}
