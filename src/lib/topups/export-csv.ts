/**
 * 前端 client 端 CSV 匯出（spec 06 §8 / §11.7、spec 10 §7.3）。
 *
 * 純函式：`DepositRecord[]` → CSV 字串（含 UTF-8 BOM，Excel 開啟中文不亂碼）。
 * 僅輸出「螢幕可見欄位」；**不含** internalNote / operatorId / operatorIp——後端目前未對
 * viewer 遮罩這些敏感欄位，前端不主動匯出以避免放大外洩（spec 07 §5）。金額為整數原值
 * （幣別最小單位），不做 Intl 格式化，利於 Excel 加總對帳。
 */
import type { DepositRecord } from './types';
import { paymentMethodLabel, depositStatusLabel } from './labels';

const BOM = '﻿';
const HEADER = ['建立時間', '玩家', '參考號', '金額', '幣別', '支付方式', '狀態'] as const;

/** RFC 4180：含逗號 / 雙引號 / 換行的儲存格以雙引號包覆，內部雙引號加倍。 */
function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toRow(record: DepositRecord): string {
  return [
    record.createdAt,
    record.playerName,
    record.referenceNo ?? '',
    String(record.amount),
    record.currency,
    paymentMethodLabel(record.paymentMethod),
    depositStatusLabel(record.status),
  ]
    .map(escapeCell)
    .join(',');
}

/**
 * 產生 CSV 字串（含 BOM）。空陣列時僅回傳 BOM + 表頭列。
 * 列以 CRLF 分隔（對齊 Excel / RFC 4180）。
 */
export function toDepositCsv(records: DepositRecord[]): string {
  const lines = [HEADER.join(','), ...records.map(toRow)];
  return BOM + lines.join('\r\n');
}
