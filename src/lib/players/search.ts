/**
 * searchPlayers — 玩家搜尋（GET /api/cms/players，對齊 spec 05 §3 / §4）。
 *
 * 真實串接：經 `cmsRequest`（帶 session access token + trace）呼叫後端，keyset cursor
 * 分頁（`cursor`/`next_cursor`/`limit`，無 meta）。BFF 對輸入的唯一處理是 **trim + 丟空欄位**；
 * 所有語意正規化（lowercase email、NFC 暱稱、E.164 手機）由後端執行（§3.1）。
 */
import { ApiError } from '@/lib/api/errors';
import { cmsRequest } from '@/lib/api-client/cms';
import { toPlayer, type RawPlayerSearchResult } from './transform';
import type { PlayerSearchQuery, PlayerSearchResult } from './types';

const DEFAULT_LIMIT = 20;

/** trim 後丟空欄位；camelCase 搜尋欄位 → 後端 snake_case query param。 */
function toBackendParams(query: PlayerSearchQuery): URLSearchParams {
  const sp = new URLSearchParams();
  const fields: Array<[string, string | undefined]> = [
    ['player_id', query.playerId],
    ['external_id', query.externalId],
    ['display_name', query.displayName],
    ['email', query.email],
    ['phone', query.phone],
  ];
  for (const [key, value] of fields) {
    const trimmed = value?.trim();
    if (trimmed) sp.set(key, trimmed);
  }
  if (query.cursor) sp.set('cursor', query.cursor); // opaque：原樣透傳，不解析
  sp.set('limit', String(query.limit ?? DEFAULT_LIMIT)); // 上限交後端驗證，不 client clamp
  return sp;
}

export async function searchPlayers(query: PlayerSearchQuery): Promise<PlayerSearchResult> {
  const searchParams = toBackendParams(query);
  // 至少一個搜尋欄位（§3.2）；省一次往返，後端全空亦回 400 invalid input
  const hasSearchField = ['player_id', 'external_id', 'display_name', 'email', 'phone'].some((k) =>
    searchParams.has(k)
  );
  if (!hasSearchField) {
    throw new ApiError(400, 'invalid_input', '至少提供一個搜尋欄位');
  }

  const { data } = await cmsRequest<RawPlayerSearchResult>('/cms/players', { searchParams });

  // 防禦性解構（§4.4）：後端異常回 data:null / 缺 players 時不以 TypeError 蓋掉真錯誤
  return {
    players: (data?.players ?? []).map(toPlayer),
    nextCursor: data?.next_cursor ?? null,
  };
}
