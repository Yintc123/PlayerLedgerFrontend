/**
 * getDeposit — 取單筆儲值紀錄（GET /api/cms/deposit-records/{id}，對齊 deposit-records-api §4.3）。
 *
 * 真實串接：扁平資源，path 僅含 record id（不含 playerId）；不存在後端回 404 → cmsRequest 拋 ApiError(404)。
 */
import { cmsRequest } from '@/lib/api-client/cms';
import { toDepositRecord, type RawDepositRecord } from './transform';
import type { DepositRecord } from './types';

export async function getDeposit(id: string): Promise<DepositRecord> {
  const { data } = await cmsRequest<RawDepositRecord>(`/cms/deposit-records/${id}`);
  return toDepositRecord(data);
}
