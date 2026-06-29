/**
 * listDeposits — 列出儲值紀錄（GET /api/cms/deposit-records，對齊後端 deposit-records-api §4.2）。
 *
 * 真實串接：透過 `cmsRequest`（帶 session access token）呼叫後端扁平資源，
 * offset 分頁（page/page_size + meta.total），多值篩選用重複 key；回傳 envelope 解開 +
 * snake_case → camelCase transform。
 */
import { ApiError } from '@/lib/api/errors';
import { cmsRequest } from '@/lib/api-client/cms';
import { toDepositRecord, type RawDepositRecord } from './transform';
import type { DepositListQuery, DepositListResult } from './types';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** 將 camelCase 查詢序列化為後端 snake_case query（多值用重複 key）。 */
function toBackendParams(query: DepositListQuery): URLSearchParams {
  const sp = new URLSearchParams();
  if (query.playerId) sp.set('player_id', query.playerId);
  if (query.page != null) sp.set('page', String(query.page));
  if (query.pageSize != null) sp.set('page_size', String(query.pageSize));
  for (const s of query.status ?? []) sp.append('status', s);
  for (const m of query.paymentMethod ?? []) sp.append('payment_method', m);
  if (query.startDate) sp.set('start_date', query.startDate);
  if (query.endDate) sp.set('end_date', query.endDate);
  if (query.sort) sp.set('sort', query.sort);
  return sp;
}

export async function listDeposits(query: DepositListQuery = {}): Promise<DepositListResult> {
  // 先行 client 驗證日期區間（避免無謂往返；後端 end_date < start_date 亦回 400）
  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    throw new ApiError(400, 'invalid_input', 'end_date 不可早於 start_date');
  }

  const { data, meta } = await cmsRequest<RawDepositRecord[]>('/cms/deposit-records', {
    searchParams: toBackendParams(query),
  });

  return {
    records: (data ?? []).map(toDepositRecord),
    page: meta?.page ?? query.page ?? DEFAULT_PAGE,
    pageSize: meta?.pageSize ?? query.pageSize ?? DEFAULT_PAGE_SIZE,
    total: meta?.total ?? 0,
  };
}
