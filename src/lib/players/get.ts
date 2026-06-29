/**
 * getPlayer — 玩家詳情（spec 05 §4.5）。Mock 實作。
 */
import { ApiError } from '@/lib/api/errors';
import { MOCK_PLAYERS, errorTriggerFor } from '@/lib/mock/dataset';
import type { Player } from './types';

export async function getPlayer(playerId: string): Promise<Player> {
  const trigger = errorTriggerFor(playerId);
  if (trigger) throw trigger;

  const player = MOCK_PLAYERS.find((p) => p.playerId === playerId);
  if (!player) {
    throw new ApiError(404, 'resource_not_found', '找不到此玩家');
  }
  return player;
}
