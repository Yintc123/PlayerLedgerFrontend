/**
 * getPlayer — 玩家詳情（GET /api/cms/players/{id}，對齊 spec 05 §4.5）。
 *
 * 真實串接：經 `cmsRequest` 呼叫後端；id 為 UUID，path 須 percent-encode；
 * 玩家不存在後端回 404 → cmsRequest 拋 ApiError(404)，由呼叫端（RSC 頁面）處理。
 */
import { cmsRequest } from '@/lib/api-client/cms';
import { toPlayer, type RawPlayerDTO } from './transform';
import type { Player } from './types';

export async function getPlayer(playerId: string): Promise<Player> {
  const { data } = await cmsRequest<RawPlayerDTO>(`/cms/players/${encodeURIComponent(playerId)}`);
  return toPlayer(data);
}
