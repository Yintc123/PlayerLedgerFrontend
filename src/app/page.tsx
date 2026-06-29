import { redirect } from 'next/navigation';

/**
 * 根路由 `/` redirect shim（spec 02 §2.5）。
 * 本系統無根畫面，入口為 CMS 玩家搜尋頁；直接訪問 `/` 一律導向 `/players`。
 */
export default function RootPage() {
  redirect('/players');
}
