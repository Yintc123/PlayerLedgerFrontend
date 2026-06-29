/**
 * createDeposit — 建立儲值紀錄（POST /api/cms/deposit-records，對齊 deposit-records-api §4.1）。
 * 權限：admin / user（viewer 不可）。後端最終把關；前端按鈕顯隱非安全邊界。
 *
 * 真實串接：送 snake_case body；status 由後端固定為 pending，player_name / operator_* 由 server 填入。
 * 後端錯誤（404 player 不存在、409 reference_no 重複、400 amount 非法）由 cmsRequest 映射為 ApiError。
 */
import { cmsRequest } from '@/lib/api-client/cms';
import { toDepositRecord, type RawDepositRecord } from './transform';
import type { CreateDepositInput, DepositRecord } from './types';

export async function createDeposit(input: CreateDepositInput): Promise<DepositRecord> {
  const body = {
    player_id: input.playerId,
    amount: input.amount,
    payment_method: input.paymentMethod,
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.internalNote !== undefined ? { internal_note: input.internalNote } : {}),
    ...(input.displayNote !== undefined ? { display_note: input.displayNote } : {}),
    ...(input.referenceNo !== undefined ? { reference_no: input.referenceNo } : {}),
  };

  const { data } = await cmsRequest<RawDepositRecord>('/cms/deposit-records', {
    method: 'POST',
    body,
  });
  return toDepositRecord(data);
}
