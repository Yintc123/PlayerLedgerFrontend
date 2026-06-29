/**
 * 玩家詳情頁載入態（spec 09 §5）。三個區塊 skeleton，避免 layout shift。
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-live="polite" aria-busy="true">
      <div className="h-5 w-32 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl border bg-white" />
        <div className="h-64 animate-pulse rounded-xl border bg-white" />
      </div>
      <div className="h-56 animate-pulse rounded-xl border bg-white" />
      <span className="sr-only">載入中</span>
    </div>
  );
}
