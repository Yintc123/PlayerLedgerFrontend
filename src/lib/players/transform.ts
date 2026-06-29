/**
 * 後端 PlayerDTO（snake_case）→ 前端 Player（camelCase）轉換（spec 05 §2.2）。
 * 規則同 06 deposit `transform.ts`：snake→camel、`null` 透傳、不在 transform 層
 * 做格式化／語意正規化／欄位篩選（trust 後端）。採手寫 `Raw*` 型別（專案資料層慣例）。
 */
import type { Player, PlayerStatus } from './types';

/** 後端回傳的單筆 raw 形狀（snake_case，對齊 OpenAPI PlayerDTO）。 */
export type RawPlayerDTO = {
  player_id: string;
  external_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  status: PlayerStatus;
  registered_at: string;
  last_active_at: string | null;
};

/** 搜尋結果 envelope 的 `data`（無 meta；含 opaque keyset cursor）。 */
export type RawPlayerSearchResult = {
  players: RawPlayerDTO[];
  next_cursor: string | null;
};

export function toPlayer(raw: RawPlayerDTO): Player {
  return {
    playerId: raw.player_id,
    externalId: raw.external_id ?? null,
    displayName: raw.display_name,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
    status: raw.status,
    registeredAt: raw.registered_at,
    lastActiveAt: raw.last_active_at ?? null,
  };
}
