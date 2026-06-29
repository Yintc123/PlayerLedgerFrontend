/**
 * getPlayerTopupSummary — 玩家儲值彙總（spec 06 §7）。Mock 實作。
 */
import { mockSummaryFor, errorTriggerFor } from '@/lib/mock/dataset';
import type { TopupSummary } from './types';

export async function getPlayerTopupSummary(playerId: string): Promise<TopupSummary> {
  const trigger = errorTriggerFor(playerId);
  if (trigger) throw trigger;
  return mockSummaryFor(playerId);
}
