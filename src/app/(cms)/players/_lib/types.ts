/**
 * 玩家搜尋頁本地共用型別（spec 08 §7.2）。
 *
 * 與 `lib/players/types.ts` 的 `PlayerSearchQuery` 同 shape；此處 re-export 型別
 * （型別在編譯期被抹除，不會把 server-only 模組帶進 client bundle）。
 */
export type { PlayerSearchQuery } from '@/lib/players/types';
