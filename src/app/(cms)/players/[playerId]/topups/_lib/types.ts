/**
 * 列表頁查詢型別（spec 10 §9.2）。直接複用資料層 `@/lib/topups/types` 的契約，
 * 避免畫面層與資料層型別漂移（SDD：Schema 為唯一契約）。
 */
export type {
  DepositListQuery,
  DepositStatus,
  DepositSort,
  PaymentMethod,
} from '@/lib/topups/types';
