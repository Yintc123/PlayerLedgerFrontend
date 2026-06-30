/**
 * getPlayerTopupSummary — 玩家儲值彙總（GET /api/cms/players/{id}/deposit-summary，
 * 對齊後端 players-deposit-summary-api / spec 06 §7）。
 *
 * 真實串接：透過 `cmsRequest`（帶 session access token）呼叫後端巢狀於 players 的彙總端點，
 * 非分頁（回應無 meta）；回傳 envelope 解開 + snake_case → camelCase transform。
 */
import { cmsRequest } from '@/lib/api-client/cms';
import { toTopupSummary, type RawTopupSummary } from './transform';
import type { TopupSummary } from './types';

export async function getPlayerTopupSummary(playerId: string): Promise<TopupSummary> {
  const { data } = await cmsRequest<RawTopupSummary>(`/cms/players/${playerId}/deposit-summary`);
  return toTopupSummary(data);
}
