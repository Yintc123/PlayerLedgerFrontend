/**
 * URL ↔ PlayerSearchQuery 解析與序列化（spec 08 §7）。
 * URL 是搜尋狀態的唯一來源；空欄位不寫入 URL；解析失敗 fall back，不 throw。
 */
import type { PlayerSearchQuery } from './types';

type ParamsLike = { get(name: string): string | null };

const STRING_FIELDS = [
  'playerId',
  'externalId',
  'displayName',
  'email',
  'phone',
  'cursor',
] as const;
const SEARCH_FIELDS = ['playerId', 'externalId', 'displayName', 'email', 'phone'] as const;

function nonEmpty(value: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

export function parseSearchQuery(params: ParamsLike): PlayerSearchQuery {
  const query: PlayerSearchQuery = {};
  for (const field of STRING_FIELDS) {
    const value = nonEmpty(params.get(field));
    if (value !== undefined) query[field] = value;
  }

  const rawLimit = params.get('limit');
  if (rawLimit != null && /^\d+$/.test(rawLimit)) {
    const n = Number(rawLimit);
    if (Number.isInteger(n) && n >= 1 && n <= 50) query.limit = n;
  }

  return query;
}

export function serializeSearchQuery(query: PlayerSearchQuery): string {
  const sp = new URLSearchParams();
  // 固定鍵序，便於 snapshot diff
  for (const field of STRING_FIELDS) {
    const value = query[field];
    if (value && value.trim().length > 0) sp.set(field, value);
  }
  if (query.limit != null) sp.set('limit', String(query.limit));
  const str = sp.toString();
  return str ? `?${str}` : '';
}

export function hasAnySearchField(query: PlayerSearchQuery): boolean {
  return SEARCH_FIELDS.some((field) => {
    const value = query[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}
