/**
 * createDeposit — 建立儲值紀錄（POST /api/cms/deposit-records，對齊 deposit-records-api §4.1）。
 * 權限：admin / user（viewer 不可）。後端最終把關；前端按鈕顯隱非安全邊界。
 *
 * Mock 實作：初始 status 固定 pending；player_name / operator_* 由 server 填入（此處模擬）。
 * 建立的紀錄存在記憶體，供同一執行期的列表 / 明細查得。
 */
import { ApiError } from '@/lib/api/errors';
import { MOCK_PLAYERS, errorTriggerFor } from '@/lib/mock/dataset';
import type { CreateDepositInput, DepositRecord } from './types';

const created: DepositRecord[] = [];
let seq = 0;

const MOCK_OPERATOR_ID = '01HCMSADMIN0000000000000001';
const MOCK_OPERATOR_IP = '203.0.113.10';
const MOCK_NOW = '2026-06-29T03:00:00Z';

/** 取執行期建立的紀錄（可選擇依 playerId 過濾）。 */
export function listCreatedDeposits(playerId?: string): DepositRecord[] {
  return playerId ? created.filter((r) => r.playerId === playerId) : created;
}

export async function createDeposit(input: CreateDepositInput): Promise<DepositRecord> {
  const trigger = errorTriggerFor(input.playerId);
  if (trigger) throw trigger;

  // player_id 必須存在於 members（後端 404）
  const player = MOCK_PLAYERS.find((p) => p.playerId === input.playerId);
  if (!player) {
    throw new ApiError(404, 'resource_not_found', 'player_id 不存在於 members');
  }

  // reference_no 唯一性（後端 409）
  if (
    input.referenceNo &&
    [...created].some((r) => r.referenceNo === input.referenceNo)
  ) {
    throw new ApiError(409, 'resource_already_exists', 'reference_no 已被其他紀錄使用');
  }

  if (!Number.isInteger(input.amount) || input.amount < 1) {
    throw new ApiError(400, 'invalid_input', 'amount 須為正整數');
  }

  seq += 1;
  const record: DepositRecord = {
    id: `01HXYZNEW${String(seq).padStart(17, '0')}`,
    playerId: input.playerId,
    playerName: player.displayName, // server 由 members 快照填入
    amount: input.amount,
    currency: input.currency ?? 'TWD',
    status: 'pending', // 後端固定初始 pending
    paymentMethod: input.paymentMethod,
    operatorId: MOCK_OPERATOR_ID,
    operatorIp: MOCK_OPERATOR_IP,
    internalNote: input.internalNote ?? null,
    displayNote: input.displayNote ?? null,
    referenceNo: input.referenceNo ?? null,
    createdAt: MOCK_NOW,
    updatedAt: MOCK_NOW,
  };
  created.unshift(record);
  return record;
}
