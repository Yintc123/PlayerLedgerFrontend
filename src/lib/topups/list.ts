/**
 * listDeposits — 列出儲值紀錄（GET /api/cms/deposit-records，對齊後端 deposit-records-api §4.2）。
 *
 * Mock 實作。後端為扁平資源 + offset 分頁（page/page_size/total），多值篩選用重複 key。
 * 介面（input/output 型別）對齊後端契約；後端就緒後抽換內部即可。
 */
import { ApiError } from '@/lib/api/errors';
import { mockTopupsFor, MOCK_ALL_DEPOSITS, errorTriggerFor, MOCK_PLAYERS } from '@/lib/mock/dataset';
import { listCreatedDeposits } from './create';
import type { DepositListQuery, DepositListResult, DepositRecord } from './types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function applyFilters(records: DepositRecord[], q: DepositListQuery): DepositRecord[] {
  return records.filter((r) => {
    if (q.status && q.status.length && !q.status.includes(r.status)) return false;
    if (q.paymentMethod && q.paymentMethod.length && !q.paymentMethod.includes(r.paymentMethod))
      return false;
    if (q.startDate && r.createdAt < `${q.startDate}T00:00:00Z`) return false;
    if (q.endDate && r.createdAt > `${q.endDate}T23:59:59Z`) return false;
    return true;
  });
}

function sortRecords(records: DepositRecord[], sort: DepositListQuery['sort']): DepositRecord[] {
  const copy = [...records];
  switch (sort) {
    case 'created_at':
      return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'amount':
      return copy.sort((a, b) => a.amount - b.amount);
    case '-amount':
      return copy.sort((a, b) => b.amount - a.amount);
    case '-created_at':
    default:
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export async function listDeposits(query: DepositListQuery = {}): Promise<DepositListResult> {
  const trigger = errorTriggerFor(query.playerId);
  if (trigger) throw trigger;

  // 日期區間驗證（後端：end_date 不可早於 start_date）
  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    throw new ApiError(400, 'invalid_input', 'end_date 不可早於 start_date');
  }

  const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = query.page ?? DEFAULT_PAGE;

  // player 篩選：有 playerId 時取該玩家紀錄，否則全部；含執行期建立的紀錄
  const base = query.playerId
    ? [...mockTopupsFor(query.playerId), ...listCreatedDeposits(query.playerId)]
    : [...MOCK_ALL_DEPOSITS, ...listCreatedDeposits()];

  // 若 playerId 指定但不存在於 members → 後端會回 404（建立時才檢查；列表允許空結果）
  if (query.playerId && !MOCK_PLAYERS.some((p) => p.playerId === query.playerId)) {
    // 對齊後端：列表的 player_id 篩選找不到時回空集合，而非 404
    return { records: [], page, pageSize, total: 0 };
  }

  const filtered = sortRecords(applyFilters(base, query), query.sort);
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const records = filtered.slice(start, start + pageSize);

  return { records, page, pageSize, total };
}
