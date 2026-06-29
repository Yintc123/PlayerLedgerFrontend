/**
 * searchPlayers — 玩家搜尋（spec 05 §4）。
 *
 * **Mock 實作**：後端就緒前以記憶體資料模擬。真實版會走 BFF 呼叫上游 GET
 * /players/search 並解開 envelope；介面（input/output 型別）維持不變，
 * 之後抽換內部即可，呼叫端（page.tsx）不需改。
 */
import { ApiError } from '@/lib/api/errors';
import { MOCK_PLAYERS, errorTriggerFor } from '@/lib/mock/dataset';
import type { Player, PlayerSearchQuery, PlayerSearchResult } from './types';

const DEFAULT_LIMIT = 20;

function matches(player: Player, query: PlayerSearchQuery): boolean {
  const conds: boolean[] = [];
  if (query.playerId) conds.push(player.playerId === query.playerId.trim());
  if (query.externalId) conds.push(player.externalId === query.externalId.trim());
  if (query.displayName)
    conds.push(player.displayName.startsWith(query.displayName.trim())); // 前綴模糊
  if (query.email)
    conds.push((player.email ?? '').toLowerCase().includes(query.email.trim().toLowerCase()));
  if (query.phone)
    conds.push((player.phone ?? '').replace(/[\s()-]/g, '').includes(query.phone.replace(/[\s()-]/g, '')));
  // AND 組合：所有提供的欄位都須滿足
  return conds.length > 0 && conds.every(Boolean);
}

export async function searchPlayers(query: PlayerSearchQuery): Promise<PlayerSearchResult> {
  // 手動 demo 用錯誤觸發
  const trigger =
    errorTriggerFor(query.playerId) ??
    errorTriggerFor(query.externalId) ??
    errorTriggerFor(query.displayName) ??
    errorTriggerFor(query.email) ??
    errorTriggerFor(query.phone);
  if (trigger) throw trigger;

  const hasField = Boolean(
    query.playerId || query.externalId || query.displayName || query.email || query.phone
  );
  if (!hasField) {
    throw new ApiError(400, 'invalid_input', '至少提供一個搜尋欄位');
  }

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString()) || 0 : 0;

  const all = MOCK_PLAYERS.filter((p) => matches(p, query));
  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor =
    nextOffset < all.length ? Buffer.from(String(nextOffset)).toString('base64url') : null;

  return { players: page, nextCursor };
}
