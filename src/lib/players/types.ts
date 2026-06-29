/**
 * 玩家查詢資料模型（spec 05 §2.1 / §4.3）
 * 對外（含 Browser）一律 camelCase；遮罩 / null 由後端決定，前端只依資料 render。
 */
export type PlayerStatus = 'active' | 'frozen' | 'closed';

export type Player = {
  playerId: string;
  externalId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: PlayerStatus;
  registeredAt: string; // ISO 8601 UTC
  lastActiveAt: string | null;
};

export type PlayerSearchQuery = {
  playerId?: string;
  externalId?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  cursor?: string;
  limit?: number;
};

export type PlayerSearchResult = {
  players: Player[];
  nextCursor: string | null;
};
