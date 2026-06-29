/**
 * getDeposit — 取單筆儲值紀錄（GET /api/cms/deposit-records/{id}，對齊 deposit-records-api §4.3）。
 *
 * Mock 實作。後端為扁平資源，path 僅含 record id（不含 playerId）；不存在回 404。
 */
import { ApiError } from '@/lib/api/errors';
import { MOCK_ALL_DEPOSITS, errorTriggerFor } from '@/lib/mock/dataset';
import { listCreatedDeposits } from './create';
import type { DepositRecord } from './types';

export async function getDeposit(id: string): Promise<DepositRecord> {
  const trigger = errorTriggerFor(id);
  if (trigger) throw trigger;

  const record =
    MOCK_ALL_DEPOSITS.find((r) => r.id === id) ?? listCreatedDeposits().find((r) => r.id === id);
  if (!record) {
    throw new ApiError(404, 'resource_not_found', '找不到此筆紀錄');
  }
  return record;
}
