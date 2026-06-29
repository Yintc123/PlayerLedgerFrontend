/**
 * 儲值紀錄資料模型 — 對齊後端 OpenAPI（PlayerLedgerBackend schema/openapi.yaml,
 * deposit-records-api.md / deposit-records-model.md）。
 *
 * 後端端點為 /api/cms/deposit-records（扁平資源，非掛在 player 下）；本檔型別對應
 * `DepositRecord` schema，欄位採 camelCase（BFF / Browser 慣例），由 transform 層自
 * snake_case 轉換。金額為「該幣別最小單位」整數（TWD→元、USD→cent、JPY→円）。
 */

/** 狀態機：pending →{completed,failed,cancelled}；completed → refunded（其餘為終態）。 */
export type DepositStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded';

export type PaymentMethod =
  'bank_transfer' | 'credit_card' | 'manual' | 'convenience_store' | 'e_wallet';

/** 排序：對齊後端 enum（欄位名 + 前綴 `-` 為降冪）。預設 `-created_at`。 */
export type DepositSort = 'created_at' | '-created_at' | 'amount' | '-amount';

/** CMS 端完整紀錄（DepositRecordDTO）。operator/note/reference 為 nullable。 */
export type DepositRecord = {
  id: string;
  playerId: string;
  playerName: string; // server 由 members 快照填入
  amount: number; // 幣別最小單位整數
  currency: string;
  status: DepositStatus;
  paymentMethod: PaymentMethod;
  operatorId: string | null;
  operatorIp: string | null;
  internalNote: string | null; // staff 內部備註，不對玩家顯示
  displayNote: string | null; // 對玩家顯示
  referenceNo: string | null; // 金流商外部交易號
  createdAt: string; // RFC 3339
  updatedAt: string;
};

/** 列表查詢參數（GET /cms/deposit-records）。offset 分頁；多值為重複 key。 */
export type DepositListQuery = {
  page?: number; // 1-based，預設 1
  pageSize?: number; // 1..100，預設 20
  playerId?: string; // uuid 篩選
  status?: DepositStatus[]; // 重複 key OR 篩選
  paymentMethod?: PaymentMethod[];
  startDate?: string; // YYYY-MM-DD（created_at >= start 00:00 UTC）
  endDate?: string; // YYYY-MM-DD（created_at <= end 23:59:59 UTC）
  sort?: DepositSort;
};

/** 列表結果：data 陣列 + 後端 meta 分頁（offset 模型，含 total）。 */
export type DepositListResult = {
  records: DepositRecord[];
  page: number;
  pageSize: number;
  total: number;
};

/** 建立儲值（POST /cms/deposit-records；admin/user）。server 自動填 player_name/operator_*。 */
export type CreateDepositInput = {
  playerId: string;
  amount: number; // 正整數，幣別最小單位
  currency?: string; // 預設 TWD
  paymentMethod: PaymentMethod;
  internalNote?: string;
  displayNote?: string;
  referenceNo?: string;
};

// ---------------------------------------------------------------------------
// 玩家儲值彙總（TopupSummary）：後端尚無對應端點，螢幕 09 暫以 mock 呈現。
// 待後端新增 summary 端點後再對齊（見 spec 06 §7 / spec 09）。
// ---------------------------------------------------------------------------
export type CurrencyTotals = {
  currency: string;
  successCount: number;
  successAmount: number;
  refundedCount: number;
  refundedAmount: number;
  failedCount: number;
  refundRate: number;
};

export type TopupSummary = {
  playerId: string;
  totalsByCurrency: CurrencyTotals[];
  firstTopupAt: string | null;
  lastTopupAt: string | null;
  lifetimeDays: number | null;
};
