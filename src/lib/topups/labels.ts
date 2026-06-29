/**
 * 儲值紀錄列舉值的中文 label（對齊後端 enum：DepositStatus / PaymentMethod）。
 * 未知值原樣回傳（fail-open）。
 */
import type { DepositStatus, PaymentMethod } from './types';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: '銀行轉帳',
  credit_card: '信用卡',
  manual: '手動補單',
  convenience_store: '超商代收',
  e_wallet: '電子錢包',
};

const STATUS_LABELS: Record<DepositStatus, string> = {
  pending: '等待處理',
  completed: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  refunded: '已退款',
};

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}

export function depositStatusLabel(status: string): string {
  return STATUS_LABELS[status as DepositStatus] ?? status;
}

/** 狀態多選選項（spec 10 篩選列）。 */
export const DEPOSIT_STATUS_OPTIONS: ReadonlyArray<{ value: DepositStatus; label: string }> = (
  ['pending', 'completed', 'failed', 'cancelled', 'refunded'] as DepositStatus[]
).map((value) => ({ value, label: STATUS_LABELS[value] }));

/** 支付方式多選選項（對齊後端 PaymentMethod enum）。 */
export const PAYMENT_METHOD_OPTIONS: ReadonlyArray<{ value: PaymentMethod; label: string }> = (
  Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]
).map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }));
