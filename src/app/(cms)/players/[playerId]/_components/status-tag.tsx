/**
 * 玩家狀態 tag（spec 09 §3.2）。
 *
 * v1 與 spec 08 共用 `@/components/players/status-tag`；此處僅 re-export 維持
 * spec 09 §2.2 的檔案結構，避免過早抽象。三處出現時再評估提升位置。
 */
export { PlayerStatusTag as StatusTag } from '@/components/players/status-tag';
