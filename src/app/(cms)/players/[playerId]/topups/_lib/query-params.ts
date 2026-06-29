/**
 * URL ↔ DepositListQuery 解析與序列化（spec 10 §9）。
 * URL 是篩選狀態的唯一來源；空欄位不寫入；解析失敗 fall back 預設（不 throw）。
 *
 * 對齊後端 GET /api/cms/deposit-records：offset 分頁（page/page_size）、
 * 多值篩選採「重複 key」（?status=pending&status=failed），非逗號分隔。
 */
import type { DepositListQuery, DepositStatus, DepositSort, PaymentMethod } from './types';

type ParamsLike = {
  get(name: string): string | null;
  getAll(name: string): string[];
};

const VALID_SORTS: readonly DepositSort[] = ['created_at', '-created_at', 'amount', '-amount'];
const DEFAULT_SORT: DepositSort = '-created_at';

function nonEmpty(value: string | null): string | undefined {
  if (value == null) return undefined;
  return value.trim().length > 0 ? value.trim() : undefined;
}

function parseIntField(value: string | null): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined; // 非整數 → undefined（不 throw）
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : undefined;
}

/** 重複 key 多值（getAll）；逐值 trim + 去空，全空回 undefined。 */
function parseRepeated(values: string[]): string[] | undefined {
  const arr = values.map((v) => v.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

export function parseListQuery(params: ParamsLike): DepositListQuery {
  const query: DepositListQuery = {};

  const page = parseIntField(params.get('page'));
  if (page !== undefined) query.page = page;

  const pageSize = parseIntField(params.get('pageSize'));
  if (pageSize !== undefined) query.pageSize = pageSize;

  const status = parseRepeated(params.getAll('status'));
  if (status) query.status = status as DepositStatus[];

  const paymentMethod = parseRepeated(params.getAll('paymentMethod'));
  if (paymentMethod) query.paymentMethod = paymentMethod as PaymentMethod[];

  const startDate = nonEmpty(params.get('startDate'));
  if (startDate) query.startDate = startDate;

  const endDate = nonEmpty(params.get('endDate'));
  if (endDate) query.endDate = endDate;

  const sort = nonEmpty(params.get('sort'));
  if (sort && VALID_SORTS.includes(sort as DepositSort)) query.sort = sort as DepositSort;

  return query;
}

export function serializeListQuery(query: DepositListQuery): string {
  const sp = new URLSearchParams();

  if (query.page != null) sp.set('page', String(query.page));
  if (query.pageSize != null) sp.set('pageSize', String(query.pageSize));
  if (query.startDate) sp.set('startDate', query.startDate);
  if (query.endDate) sp.set('endDate', query.endDate);
  // 多值：每個值各自附加一個 key（重複 key），對齊後端 OR 篩選語意
  for (const s of query.status ?? []) sp.append('status', s);
  for (const m of query.paymentMethod ?? []) sp.append('paymentMethod', m);
  // 預設排序不寫入 URL（spec §4.1）
  if (query.sort && query.sort !== DEFAULT_SORT) sp.set('sort', query.sort);

  const str = sp.toString();
  return str ? `?${str}` : '';
}
