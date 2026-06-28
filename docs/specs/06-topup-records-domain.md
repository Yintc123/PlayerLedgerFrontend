# 儲值紀錄業務邏輯規格書

## 1. 概覽

本文件定義 CMS 後台「儲值紀錄查詢」功能的**業務邏輯層**。畫面層規格見 [`10-screen-topup-list.md`](./10-screen-topup-list.md) 與 [`11-screen-topup-detail.md`](./11-screen-topup-detail.md)。

範圍：

- 儲值紀錄資料模型與狀態機
- 列表查詢（必繫結 `playerId`、日期區間、狀態、支付方式篩選）
- 排序與分頁
- 單筆明細
- 玩家層級彙總統計
- 匯出 CSV（含大量資料的 async job 模式）
- TDD 測試清單

**不在本文件範圍**：

- 玩家識別與搜尋——見 [`05-player-query-domain.md`](./05-player-query-domain.md)
- 角色權限與稽核事件結構——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)
- 退款／補單／重發等寫入動作（v1 純查詢）

### 核心原則

- **以玩家為單位**：所有列表查詢必須帶 `playerId`，**不支援**跨玩家全平台瀏覽——後台場景以「定位某玩家後查其紀錄」為主，跨玩家查詢屬於財務報表系統職責
- **金額單位明確**：所有金額欄位以**整數最小貨幣單位**（如 TWD 分、USD cent）傳輸，UI 顯示時除以該幣別 minor unit。**禁止**用 float 表示金額
- **時間統一 UTC**：所有時間欄位以 ISO 8601 UTC 字串傳遞；時區轉換在 UI 層完成
- **狀態唯一來源是後端**：BFF 不嘗試本地推斷「pending 太久 = failed」之類，全部依後端 `status` 欄位
- **匯出有審計責任**：任何匯出動作觸發後端稽核（操作者、條件、時間、匯出筆數）；BFF 不快取匯出結果

---

## 2. 資料模型

### 2.1 `TopupRecord` 欄位

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `recordId` | `string` | ✅ | PlayerLedger 內部主鍵；URL/log/稽核唯一引用 |
| `playerId` | `string` | ✅ | 對應 [`05`](./05-player-query-domain.md) `Player.playerId` |
| `orderId` | `string \| null` | ❌ | 對應遊戲端訂單 ID（外部系統） |
| `amount` | `integer` | ✅ | **最小貨幣單位**（TWD=分、JPY=日圓本身、BTC=satoshi）；以整數表示，避免浮點誤差 |
| `currency` | `string` | ✅ | ISO 4217 三字母代碼（`TWD` / `USD` / `JPY` / ...） |
| `paymentMethod` | `string` | ✅ | 後端定義的 enum（如 `credit_card` / `apple_pay` / `google_pay` / `bank_transfer` / `crypto_usdt`）；前端不寫死 enum，從 OpenAPI 取 |
| `paymentChannel` | `string \| null` | ❌ | 支付通道細節（如 `stripe` / `tappay` / `ecpay`），供財務分潤檢核 |
| `status` | `'pending' \| 'success' \| 'failed' \| 'refunded' \| 'cancelled'` | ✅ | 見 §2.2 狀態機 |
| `failureReason` | `string \| null` | ❌ | 後端定義的失敗代碼（如 `insufficient_funds` / `3ds_failed`）；僅 `status=failed` 時非 null |
| `createdAt` | `string`（ISO 8601 UTC） | ✅ | 訂單建立時間 |
| `paidAt` | `string \| null`（ISO 8601 UTC） | ❌ | 實際付款完成時間；`status=success/refunded` 必有值 |
| `refundedAt` | `string \| null`（ISO 8601 UTC） | ❌ | 退款時間；`status=refunded` 必有值 |

> **`amount` 為何用 integer 最小單位**：JavaScript `number` 對 `0.1 + 0.2` 都會誤差；金額用 float 在後台對帳時是**直接事故**。整數最小單位與後端 / 資料庫對齊，UI 顯示時再用 `Intl.NumberFormat` 還原。

> **退款顯示**：v1 後端對退款採「同筆 record 變更 status 為 refunded」而非另開負金額紀錄；若後端改採另開 record 模型，本欄位設計與 §4.2 篩選邏輯需重整。實作前請與後端確認（[§12 開放問題](#12-開放問題)）。

### 2.2 狀態機

```
        ┌────────────┐
        │  pending   │  訂單建立、等待支付
        └─────┬──────┘
              │
     ┌────────┼────────┬─────────┐
     ▼        ▼        ▼         ▼
┌─────────┐ ┌──────┐ ┌──────┐  ┌──────────┐
│ success │ │failed│ │cancel│  │ (timeout │
└────┬────┘ └──────┘ └──────┘  │  → failed)│
     │                          └──────────┘
     ▼
┌──────────┐
│ refunded │  僅 success → refunded
└──────────┘
```

| 來源 | 終態 | BFF 顯示 |
|------|------|---------|
| pending | success / failed / cancelled | success：綠 tag、可進入退款（v2）；failed：紅 tag、顯示 `failureReason`；cancelled：灰 tag |
| success | refunded | 紅 tag「已退款」；顯示 `refundedAt` |
| failed / cancelled / refunded | （終態） | 不可再轉換；BFF 不顯示「重試」之類動作 |

**BFF 不做的事**：

- 不過濾 `pending`（即使 pending 超過 24h）——僅顯示 + 由 UI 提示「狀態未完成」
- 不嘗試補單／重發——非本功能範圍

### 2.3 後端對應與轉換

```yaml
# OpenAPI（後端維護）
components:
  schemas:
    TopupRecord:
      type: object
      required: [record_id, player_id, amount, currency, payment_method, status, created_at]
      properties:
        record_id:        { type: string }
        player_id:        { type: string }
        order_id:         { type: string, nullable: true }
        amount:           { type: integer, format: int64 }
        currency:         { type: string }
        payment_method:   { type: string }
        payment_channel:  { type: string, nullable: true }
        status:           { type: string, enum: [pending, success, failed, refunded, cancelled] }
        failure_reason:   { type: string, nullable: true }
        created_at:       { type: string, format: date-time }
        paid_at:          { type: string, format: date-time, nullable: true }
        refunded_at:      { type: string, format: date-time, nullable: true }
```

轉換層放 `src/lib/topups/transform.ts`，規則同 [`05 §2.2`](./05-player-query-domain.md)：snake_case → camelCase、`null` 透傳、不在 transform 層做格式化。

---

## 3. 列表查詢

### 3.1 端點

```
GET /api/v1/players/{player_id}/topups?<query>
```

**為何掛在 `/players/{player_id}/topups`** 而非 `/topups?player_id=...`：

- 強制每筆查詢繫結玩家——URL 結構即表達「不允許跨玩家」
- 後端權限檢查可用 path 變數做行級授權
- 與 RESTful resource hierarchy 對齊

### 3.2 Query 參數

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `status` | string \| string[] | ❌ | 單值或多值（逗號分隔，如 `status=success,refunded`）；省略=不篩 |
| `payment_method` | string \| string[] | ❌ | 同上 |
| `from` | string（ISO 8601 date，UTC） | ❌ | `created_at` 下限（含）；省略=不限 |
| `to` | string（ISO 8601 date，UTC） | ❌ | `created_at` 上限（含）；省略=不限 |
| `min_amount` | integer | ❌ | 最小金額（最小貨幣單位） |
| `max_amount` | integer | ❌ | 最大金額（最小貨幣單位） |
| `currency` | string | ❌ | 篩選單一幣別 |
| `sort` | `'created_at_desc' \| 'created_at_asc' \| 'amount_desc' \| 'amount_asc'` | ❌ | 預設 `created_at_desc` |
| `cursor` | string | ❌ | 後端不透明分頁游標 |
| `limit` | integer | ❌ | 1–100，預設 `20`；超過上限 BFF 在 400 攔下 |

**多值參數編碼**：逗號分隔（`status=success,refunded`）而非重複 key（`status=success&status=refunded`）——與後端慣例對齊，避免 BFF 兩種格式都要支援。

**日期區間驗證**：

- `from > to` → BFF 回 400 `invalid_input`
- 區間 > 366 天 → BFF 回 400 `invalid_input`，防止 SQL 全表掃描
- 不允許僅給 `from` 或僅給 `to`（必須成對或皆省略）；單邊區間在後台對帳場景無常見用例，先擋掉避免誤用

> **單邊區間限制可能過嚴**：若客服場景常有「找最近 7 天內某玩家」這類，預設 `from = today - 7d` 比擋掉更友善。實作前與 PM 確認（[§12](#12-開放問題)）。

### 3.3 Response

成功（200）：

```json
{
  "success": true,
  "request_id": "...",
  "data": {
    "records": [
      {
        "record_id": "01HXYZ...",
        "player_id": "01HABCD...",
        "order_id": "GAME-2026-0001",
        "amount": 19900,
        "currency": "TWD",
        "payment_method": "credit_card",
        "payment_channel": "stripe",
        "status": "success",
        "failure_reason": null,
        "created_at": "2026-06-20T03:11:22Z",
        "paid_at": "2026-06-20T03:11:45Z",
        "refunded_at": null
      }
    ],
    "next_cursor": null
  }
}
```

BFF 對 Browser：解開 envelope + camelCase（同 [`05 §4.3`](./05-player-query-domain.md)）。

### 3.4 BFF 端實作分工

```
src/lib/topups/
├── list.ts              # listTopups(playerId, query): Promise<TopupListResult>
├── list.test.ts
├── get.ts               # getTopup(playerId, recordId): Promise<TopupRecord>
├── get.test.ts
├── summary.ts           # getPlayerTopupSummary(playerId): Promise<TopupSummary>
├── summary.test.ts
├── export.ts            # requestExport(playerId, query): Promise<ExportJob>
├── export.test.ts
├── transform.ts
├── transform.test.ts
└── types.ts
```

---

## 4. 排序

| sort 值 | 後端行為 |
|---------|---------|
| `created_at_desc`（預設） | 新到舊；同時間以 `record_id desc` 二級排序穩定 |
| `created_at_asc` | 舊到新 |
| `amount_desc` | 大額在前；同金額以 `created_at desc` 二級 |
| `amount_asc` | 小額在前 |

- **不允許自定義二級排序鍵**：簡化後端 SQL index 設計
- **金額排序需指定幣別**？v1 不強制，但跨幣別排序對使用者意義有限——UI 應預先在篩選列提示「先選幣別再用金額排序」

---

## 5. 分頁

同 [`05 §5`](./05-player-query-domain.md)：cursor-based、無總筆數、單頁上限不同（topup 100、player 50）。

**為何 topup 上限 100 而 player 50**：

- topup 列表是「同一玩家內」分頁，後端可用 `(player_id, created_at)` index 高效翻頁
- player 搜尋跨平台所有玩家，索引選擇性差，上限更保守

---

## 6. 單筆明細

```
GET /api/v1/players/{player_id}/topups/{record_id}
```

- 回 `TopupRecord` 完整欄位（同 §2.1）
- 404 `resource not found`：紀錄不存在或 `record_id` 不屬於該 `player_id`（後端統一回 404 不洩漏「存在但跨玩家」）
- 403 `forbidden`：角色不可查（見 [`07`](./07-admin-rbac-audit.md)）

---

## 7. 玩家儲值彙總

### 7.1 端點

```
GET /api/v1/players/{player_id}/topups/summary
```

供玩家詳情頁（[`09`](./09-screen-player-detail.md)）的「儲值彙總卡」使用。

### 7.2 Response

```ts
type TopupSummary = {
  playerId:            string
  totalsByCurrency: Array<{
    currency:          string
    successCount:      number        // 成功筆數
    successAmount:     number        // 成功總額（最小貨幣單位）
    refundedCount:     number
    refundedAmount:    number
    failedCount:       number
    refundRate:        number        // refundedAmount / successAmount（後端算好，避免前端浮點誤差）
  }>
  firstTopupAt:        string | null  // 首次成功儲值時間
  lastTopupAt:         string | null  // 最近成功儲值時間
  lifetimeDays:        number | null  // 從首次到今天的天數，便於「LTV 評估」
}
```

- `refundRate` 由後端計算回傳——前端不在 client 算除法（精度問題 + 各 currency 分母不同）
- `totalsByCurrency` 為陣列：多幣別玩家分開呈現，不做匯率換算

### 7.3 為何彙總獨立端點

- 彙總在後端可用物化檢視（materialized view）/ 預計算，效能與列表查詢解耦
- 玩家詳情頁不需要拉全部紀錄就能顯示總額
- 列表查詢（§3）不附帶彙總，避免每次分頁都重算

---

## 8. 匯出 CSV

### 8.1 為何需要 async job 而非同步下載

| 場景 | 適用模式 |
|------|---------|
| 結果 ≤ 1000 筆 | **同步**：BFF 直接拉資料、組 CSV、回 `200` + `Content-Disposition: attachment` |
| 結果 > 1000 筆 | **async job**：BFF 觸發後端 job，回 `202` + `jobId`；前端輪詢狀態，完成後下載 |

> **1000 筆是經驗值**，影響 BFF route handler 的記憶體佔用上限（每筆 ~500 byte → 500KB CSV）。實際門檻在後端決定，BFF 從 OpenAPI schema 取得。

### 8.2 同步匯出端點

```
GET /api/v1/players/{player_id}/topups/export?<同 §3.2 query>&format=csv
```

- `format=csv`（v1 唯一支援；XLSX 待 v2）
- 回 `200 text/csv; charset=utf-8` + `Content-Disposition: attachment; filename="topups-{playerId}-{yyyymmdd}.csv"`
- BFF Proxy 對此端點**特殊處理**：不嘗試 envelope 解開、原樣透傳 body 與 headers

> **BFF Proxy CSV 透傳例外**：[`01 §4.2`](./01-bff-architecture.md) 預設假設 upstream 為 JSON envelope；CSV 端點需在 Proxy 中辨識（依 `Content-Type` 或 path pattern）並繞過 envelope 拆解。建議於 [`01`](./01-bff-architecture.md) 新增 §「非 JSON 透傳路徑」並補 ADR；本規格暫定 path pattern `/players/*/topups/export` 為白名單。

### 8.3 Async job 端點

```
POST /api/v1/players/{player_id}/topups/export/async
Body: { ...same as §3.2 query..., format: "csv" }

→ 202 Accepted
{ "success": true, "data": { "job_id": "EXP-01HXYZ...", "status": "queued" } }
```

```
GET /api/v1/exports/{job_id}
→ 200
{ "success": true, "data": {
    "job_id": "EXP-01HXYZ...",
    "status": "queued" | "running" | "succeeded" | "failed",
    "progress": 0..100,
    "row_count": 12345,           // 完成後
    "download_url": "https://...",// 完成後；S3 presigned URL，後端產生
    "expires_at": "..."           // download_url 過期時間
}}
```

- **下載走 S3 presigned URL，不經 BFF**：避免 BFF 處理大檔
- BFF 不快取 `download_url`；每次輪詢從後端取
- 輪詢間隔由前端控制：建議 backoff `2s, 4s, 8s, ... max 30s`

### 8.4 CSV 欄位

固定順序、UTF-8 BOM 開頭（Excel 中文相容）：

```
record_id,player_id,order_id,amount,currency,payment_method,payment_channel,status,failure_reason,created_at,paid_at,refunded_at
```

- 金額**原樣輸出最小貨幣單位整數**（不做小數轉換）——避免 Excel 自動格式化截斷
- 時間以 ISO 8601 UTC 字串
- `null` 欄位輸出空字串（不寫 `NULL`）
- 跳脫：值含 `,` / `"` / `\n` 時以雙引號包裹、內部 `"` 換成 `""`（RFC 4180）

### 8.5 權限與稽核

- 匯出操作觸發後端稽核事件（[`07 §8`](./07-admin-rbac-audit.md) `topups.export`）；事件含：操作者、playerId、篩選條件、預估／實際筆數
- 部分角色（如「客服-Level 1」）可能不可匯出——後端決定，BFF 不二次檢查
- 大量匯出可能受後端限流，BFF 透傳 `429 too many requests`

### 8.6 BFF 端實作分工

```ts
// src/lib/topups/export.ts

// 觸發 async job（前端在「結果預估 > 1000」時呼叫）
export async function requestExportAsync(playerId: string, query: TopupQuery): Promise<ExportJob>

// 輪詢
export async function getExportJob(jobId: string): Promise<ExportJob>

// 同步匯出：不在 lib 層提供函式，前端直接 `<a href="/api/players/{id}/topups/export?...">下載</a>`
// 由 BFF Proxy 透傳 CSV
```

---

## 9. 錯誤處理

### 9.1 BFF 自行處理

| 條件 | HTTP | error |
|------|------|-------|
| `from > to` | 400 | `invalid_input` |
| 區間 > 366 天 | 400 | `invalid_input` |
| `limit > 100` 或 `< 1` | 400 | `invalid_input` |
| `min_amount > max_amount` | 400 | `invalid_input` |
| 僅給 `from` 或僅給 `to` | 400 | `invalid_input` |
| `currency` 非 ISO 4217 三字母 | 400 | `invalid_input` |

### 9.2 上游透傳

依 [`01 §4.2`](./01-bff-architecture.md) 與 [`05 §7.2`](./05-player-query-domain.md)。常見：

- 403 `forbidden`：角色無權查該玩家／無權匯出
- 404 `resource not found`：玩家不存在 / record 不存在
- 429 `too many requests`：限流；含 `Retry-After`

---

## 10. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | 所有 `/api/players/*/topups/*` 走 BFF Proxy；CSV 透傳需新增非 JSON 白名單（§8.2） |
| [`02-auth-session.md`](./02-auth-session.md) | session 必須有效；refresh / replay 由 session 層處理 |
| [`03-observability.md`](./03-observability.md) | metric tag：`route=/api/players/{id}/topups`、`route=/api/players/{id}/topups/export`；redact 規則覆蓋 `amount` 嗎？預設不（金額非個資），但匯出 log 含 query 條件時須注意 |
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 共享 `playerId` 識別；本規格不重複玩家欄位定義 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 角色與可見欄位（如部分角色看不到 `payment_channel`）；匯出稽核事件 |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 列表頁 UI；本規格資料層；URL 篩選參數與本規格 §3.2 對齊 |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | 明細頁 UI；本規格 §6 是其資料層 |

---

## 11. 測試清單（TDD）

### 11.1 `src/lib/topups/transform.test.ts`

```ts
// snake → camel
it('should map record_id, player_id, payment_method to camelCase')
it('should preserve amount as integer without conversion')
it('should preserve currency code verbatim (uppercase)')
it('should map null nullable fields (order_id, payment_channel, failure_reason, paid_at, refunded_at) to null')
it('should map status enum value through without transformation')

// summary
it('should map totals_by_currency array to totalsByCurrency')
it('should map refund_rate as number through without rounding')
it('should preserve null for first_topup_at when player never topped up')
```

### 11.2 `src/lib/topups/list.test.ts`

```ts
// query 組合
it('should call GET /players/{id}/topups with no query params when all filters omitted')
it('should serialize multi-value status as comma-separated')
it('should serialize multi-value payment_method as comma-separated')
it('should default sort to created_at_desc when omitted')
it('should default limit to 20 when omitted')

// 驗證（BFF 自防）
it('should throw invalid_input when from > to')
it('should throw invalid_input when date range exceeds 366 days')
it('should throw invalid_input when only from is provided without to')
it('should throw invalid_input when only to is provided without from')
it('should throw invalid_input when min_amount > max_amount')
it('should throw invalid_input when limit > 100')
it('should throw invalid_input when currency is not 3-letter ISO 4217')

// 路徑
it('should percent-encode playerId in path')

// envelope / 錯誤
it('should return camelCase TopupRecord array on 200')
it('should propagate 403 forbidden from upstream')
it('should propagate 429 with Retry-After')
it('should NOT include upstream stack in error response')
```

### 11.3 `src/lib/topups/get.test.ts`

```ts
it('should call GET /players/{playerId}/topups/{recordId}')
it('should return camelCase TopupRecord')
it('should propagate 404 resource_not_found from upstream')
it('should treat "resource not found" (space-form) as same code via normalizeErrorCode')
```

### 11.4 `src/lib/topups/summary.test.ts`

```ts
it('should call GET /players/{playerId}/topups/summary')
it('should return camelCase TopupSummary')
it('should return empty totalsByCurrency array when player has no topups')
it('should preserve refundRate as-is (no client-side rounding)')
```

### 11.5 `src/lib/topups/export.test.ts`

```ts
// async
it('should POST to /players/{id}/topups/export/async with query in body')
it('should set format="csv" in body when format not provided')
it('should return ExportJob with jobId on 202')

// polling
it('should call GET /exports/{jobId}')
it('should return downloadUrl when status is succeeded')
it('should return null downloadUrl when status is queued or running')

// 不在 lib 測試（屬 BFF Proxy 範圍）
// - 同步 CSV 透傳行為：見 spec 01 §4.3 BFF Proxy 測試（CSV Content-Type 不解 envelope）
```

### 11.6 不在本規格的測試

- UI 互動（篩選列、列表、匯出按鈕）→ [`10`](./10-screen-topup-list.md)
- 明細頁渲染 → [`11`](./11-screen-topup-detail.md)
- 稽核事件落地 → 後端
- 角色行為矩陣 → [`07`](./07-admin-rbac-audit.md)

---

## 12. 開放問題

> 實作前須與後端／PM 對齊：

- [ ] 退款是「同筆 status 變更」還是「另開負金額紀錄」？影響 §2.1 `refundedAt`、§7.2 `refundRate` 計算邏輯、UI 顯示
- [ ] `from`/`to` 是否允許單邊（如「最近 7 天」場景）？影響 §3.2 BFF 驗證
- [ ] 同步 vs async 匯出的門檻是 1000 還是別的數值？由後端 OpenAPI 提供
- [ ] CSV 是否需 XLSX 變體？v1 假設純 CSV
- [ ] `paymentMethod` enum 完整清單由後端維護，前端不寫死——但 UI 需要對應顯示名稱（「信用卡」/「Apple Pay」），這份對照表放哪？建議放 `lib/topups/labels.ts` 並與 i18n 整合
- [ ] 匯出 `download_url` TTL 長度？影響使用者體驗（過短會「我剛要下載結果連結過期」）
- [ ] BFF Proxy 對 CSV 透傳是否新開一支 ADR？建議是（明文化 envelope 例外路徑）
