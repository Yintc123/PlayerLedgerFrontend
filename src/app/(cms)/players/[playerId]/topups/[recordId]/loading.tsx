/**
 * 明細頁載入態（spec 11 §5）。skeleton 卡片 + skeleton 時間軸。
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-live="polite" aria-busy="true">
      <div className="h-5 w-64 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="h-32 animate-pulse rounded-xl border bg-white" />
          <div className="h-64 animate-pulse rounded-xl border bg-white" />
        </div>
        <div className="space-y-6">
          <div className="h-48 animate-pulse rounded-xl border bg-white" />
          <div className="h-32 animate-pulse rounded-xl border bg-white" />
        </div>
      </div>
      <span className="sr-only">載入中</span>
    </div>
  );
}
