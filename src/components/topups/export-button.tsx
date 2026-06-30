'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/session/client-session';
import { toDepositCsv } from '@/lib/topups/export-csv';
import type { DepositRecord } from '@/lib/topups/types';

/**
 * 「匯出 CSV」入口（spec 10 §7.3、spec 14 §B5.4）。僅 admin / user 可見（viewer 隱藏，純 UX）。
 *
 * 從已取得的當前頁 `records` 在 client 端產 CSV（含 UTF-8 BOM）下載，**無後端端點**。
 * 僅匯出螢幕可見欄位，不含 internalNote / operatorId / operatorIp（spec 07 §5）。
 *
 * `includePlayerId`（spec 14 A4.1）：跨玩家頁多帶「玩家 ID」欄；單玩家頁省略（預設 false）。
 */
export function ExportButton({
  records,
  includePlayerId = false,
}: {
  records: DepositRecord[];
  includePlayerId?: boolean;
}) {
  const { role } = useSession();
  if (role !== 'admin' && role !== 'user') return null;

  function handleExport() {
    const csv = toDepositCsv(records, { includePlayerId });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `deposit-records-${stamp()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleExport}
      data-component="ExportButton"
    >
      <Download className="size-4" aria-hidden="true" />
      匯出 CSV
    </Button>
  );
}

/** 檔名時間戳 yyyymmdd（本地時區）。 */
function stamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
