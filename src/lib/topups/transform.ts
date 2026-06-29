/**
 * 後端 DepositRecord（snake_case）→ 前端 DepositRecord（camelCase）轉換（spec 06 §2.3 / §3.4）。
 * nullable 欄位（operator_*、*_note、reference_no）統一以 `?? null` 正規化。
 */
import type { DepositRecord, DepositStatus, PaymentMethod } from './types';

/** 後端回傳的單筆 raw 形狀（snake_case，對齊 OpenAPI DepositRecord）。 */
export type RawDepositRecord = {
  id: string;
  player_id: string;
  player_name: string;
  amount: number;
  currency: string;
  status: DepositStatus;
  payment_method: PaymentMethod;
  operator_id?: string | null;
  operator_ip?: string | null;
  internal_note?: string | null;
  display_note?: string | null;
  reference_no?: string | null;
  created_at: string;
  updated_at: string;
};

export function toDepositRecord(raw: RawDepositRecord): DepositRecord {
  return {
    id: raw.id,
    playerId: raw.player_id,
    playerName: raw.player_name,
    amount: raw.amount,
    currency: raw.currency,
    status: raw.status,
    paymentMethod: raw.payment_method,
    operatorId: raw.operator_id ?? null,
    operatorIp: raw.operator_ip ?? null,
    internalNote: raw.internal_note ?? null,
    displayNote: raw.display_note ?? null,
    referenceNo: raw.reference_no ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}
