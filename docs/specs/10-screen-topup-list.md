# 儲值紀錄列表頁規格書

## 1. 概覽

CMS 後台「玩家儲值紀錄列表頁」——從 [`09`](./09-screen-player-detail.md) 玩家詳情頁或直接連結進入，提供日期區間 / 狀態 / 支付方式等篩選、排序、分頁、CSV 匯出功能。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 篩選列（日期、狀態、支付方式、金額、幣別）
- 排序與列表
- 分頁（cursor-based）
- 匯出 CSV（同步 vs async job）
- 狀態（idle 不存在；無篩選即顯示預設結果）
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- 業務邏輯與 API 契約——見 [`06-topup-records-domain.md`](./06-topup-records-domain.md)
- 單筆明細頁——見 [`11-screen-topup-detail.md`](./11-screen-topup-detail.md)
- 角色權限（匯出按鈕顯隱）——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)

### 核心原則

- **URL 為篩選狀態唯一來源**：與 [`08`](./08-screen-player-search.md) 相同模式；分享連結／重整可重現
- **Server-first**：篩選變更觸發 `router.push` → page.tsx 重新 SSR
- **空篩選 = 預設查詢**：本頁不存在「請輸入條件」的 idle 態；URL 無篩選時顯示「最近全部紀錄」（依預設排序）
- **匯出受角色控制**：按鈕僅顯示給有匯出權限的角色；後端最終把關（[`07 §6`](./07-admin-rbac-audit.md)）

---

## 2. 路由與檔案結構

### 2.1 路由

```
/players/[playerId]/topups
/players/[playerId]/topups/[recordId]  # → spec 11
```

### 2.2 檔案結構

```
src/app/(cms)/players/[playerId]/topups/
├── page.tsx                       # 列表頁（Server Component）
├── page.test.tsx
├── error.tsx                      # 5xx
└── _components/
    ├── filter-bar.tsx             # 篩選列（Client）
    ├── filter-bar.test.tsx
    ├── date-range-picker.tsx      # 日期區間（Client）
    ├── date-range-picker.test.tsx
    ├── multi-select.tsx           # 多選下拉（Client） — 用於狀態 / 支付方式
    ├── multi-select.test.tsx
    ├── amount-range.tsx           # 金額區間（Client）
    ├── amount-range.test.tsx
    ├── currency-select.tsx        # 幣別下拉（Client）
    ├── currency-select.test.tsx
    ├── sort-select.tsx            # 排序下拉（Client）
    ├── sort-select.test.tsx
    ├── result-table.tsx           # 結果表（Server）
    ├── result-table.test.tsx
    ├── result-row.tsx             # 單列（Client）
    ├── result-row.test.tsx
    ├── pagination.tsx             # 「載入更多」按鈕（Client）
    ├── pagination.test.tsx
    ├── export-button.tsx          # 匯出（Client，含 sync / async 分流）
    ├── export-button.test.tsx
    ├── export-job-status.tsx      # async job 輪詢與下載連結（Client）
    ├── export-job-status.test.tsx
    ├── empty-state.tsx
    ├── empty-state.test.tsx
    └── error-state.tsx
└── _lib/
    ├── query-params.ts
    ├── query-params.test.ts
    └── thresholds.ts              # 大量資料門檻（同步 vs async）
```

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `page.tsx` | Server | 解析 search params、呼叫 `listTopups`、render |
| `FilterBar` | Client | 受控表單；包多個子 Client 元件 |
| `DateRangePicker` / `MultiSelect` / `AmountRange` / `CurrencySelect` / `SortSelect` | Client | 互動 + state |
| `ResultTable` | Server | 純展示 |
| `ResultRow` | Client | 鍵盤導覽、`router.push` |
| `Pagination` | Client | 點擊行為 |
| `ExportButton` | Client | 依角色顯隱、處理 sync / async 分流 |
| `ExportJobStatus` | Client | 輪詢 |
| `EmptyState` / `ErrorState` | Server | 純文案 |

---

## 4. 篩選列（`FilterBar`）

### 4.1 欄位

```
┌──────────────────────────────────────────────────────────────────┐
│  [日期區間 ▼] [狀態 (多選) ▼] [支付方式 (多選) ▼]                │
│  [幣別 ▼] [金額 min-max] [排序 ▼]  [清除] [套用]                │
└──────────────────────────────────────────────────────────────────┘
```

| 欄位 | 元件 | URL param | 預設值 |
|------|------|----------|--------|
| 日期區間 | `DateRangePicker` | `from`、`to` | 不帶（後端回最近） |
| 狀態 | `MultiSelect` | `status`（逗號分隔） | 不帶 |
| 支付方式 | `MultiSelect` | `paymentMethod`（逗號分隔） | 不帶 |
| 幣別 | `CurrencySelect`（單選） | `currency` | 不帶 |
| 金額區間 | `AmountRange` | `minAmount`、`maxAmount`（整數最小貨幣單位） | 不帶 |
| 排序 | `SortSelect` | `sort` | `created_at_desc`（不寫 URL，UI 顯示為「最新優先」） |

### 4.2 行為

| 行為 | 對應 |
|------|------|
| 任一欄位變更 | 暫存在 client state；**不**立即送出 |
| 點「套用」按鈕 | `router.push('/players/[id]/topups?<query>')`；URL 變更觸發 page.tsx 重新 SSR |
| 點「清除」按鈕 | `router.push('/players/[id]/topups')`；回到預設 |
| 任一欄位按 Enter | 等同點「套用」 |
| 日期區間驗證 | client 端驗證 `from <= to` 與「區間 ≤ 366 天」，失敗時顯示行內錯誤、套用按鈕 disable |
| 金額區間驗證 | client 端驗證 `minAmount <= maxAmount` |

> **為何不「即時套用」**：使用者連續調整多欄位時即時套用會造成多次 server roundtrip。後台場景對「按下確認」操作較自然。

### 4.3 日期區間

- 採「不可單邊」（同 [`06 §3.2`](./06-topup-records-domain.md)）：必須同時帶 `from` 與 `to`，或皆不帶
- UI 採兩個 `<input type="date">` 並排，限制 `to >= from`
- 顯示時區：以**使用者瀏覽器時區**顯示與接收輸入；序列化到 URL 時轉為 UTC `YYYY-MM-DD`
- **不附時間部分**：日期粒度即可；後端會把 `from` 視為當日 00:00:00、`to` 視為次日 00:00:00（exclusive）

> **時區陷阱**：使用者在 GMT+8 選「2026-06-28」其實是 UTC `2026-06-27T16:00:00Z` 起算。前端送給後端的應該是「使用者意圖的當地日」，後端依其時區政策決定如何展開為 UTC 區間。本規格採「前端送 UTC 日期字串、後端按其協定解釋」；具體協定待後端 OpenAPI 提供（[§11](#11-開放問題)）。

### 4.4 狀態 / 支付方式多選

- `MultiSelect` 顯示 checkbox 清單；選中項以 chip 顯示在欄位內
- 選項來源：
  - 狀態：硬編五個值（`pending` / `success` / `failed` / `refunded` / `cancelled`）+ 中文 label
  - 支付方式：從 OpenAPI enum 動態產生；中文 label 來自 `lib/topups/labels.ts`（[`06 §12`](./06-topup-records-domain.md) 開放問題）

### 4.5 金額區間

- 兩個 `<input type="number">`：「最小」「最大」
- **以使用者主貨幣為單位輸入**（如 TWD `199` 元）；提交時前端轉成最小單位（19900 分）
- 必須在篩選列指定 `currency` 才允許輸入金額；未選 currency 時 disable + tooltip「請先選幣別」
- 為何強制：跨幣別的金額篩選沒有業務意義（USD 100 ≠ TWD 100）

---

## 5. 列表（`ResultTable` + `ResultRow`）

### 5.1 欄位

| 欄位 | 來源 | 顯示 |
|------|------|------|
| 建立時間 | `createdAt` | `MM-DD HH:mm`（本年）/ `YYYY-MM-DD HH:mm`（跨年） |
| 訂單 ID | `orderId` | `null` → `—`；過長截斷 + tooltip |
| 金額 | `amount` + `currency` | `Intl.NumberFormat` 換算為主貨幣單位；右對齊 |
| 幣別 | `currency` | 與金額共顯 |
| 支付方式 | `paymentMethod` | 中文 label（`labels.ts`） |
| 狀態 | `status` | tag |
| 操作 | — | `<a href="/players/[id]/topups/[recordId]">明細</a>` |

### 5.2 互動

- **整列可點**進明細（同 [`08 §5.2`](./08-screen-player-search.md) 慣例）
- 操作欄的「明細」連結為 redundancy（鍵盤可達、語意明確），與整列點擊行為相同

### 5.3 狀態 tag 視覺

| status | 顏色 | 額外 |
|--------|------|------|
| pending | 黃 | 顯示時鐘圖示 |
| success | 綠 | — |
| failed | 紅 | hover tooltip 顯示 `failureReason`（若非 null） |
| refunded | 紅 | tag 文字「已退款」 |
| cancelled | 灰 | — |

---

## 6. 分頁（`Pagination`）

- 列表底「載入更多」按鈕；點擊 `router.push` 帶 `cursor=<nextCursor>`
- `nextCursor === null` → 不渲染按鈕
- **不做** infinite scroll（同 [`08 §5.3`](./08-screen-player-search.md) 理由）
- 載入新頁時 append 在原表格下方？**否**——v1 採「跳到新頁」語意：URL 帶 cursor、新頁覆蓋舊頁。原因：簡化 server-first model；累積 append 需 client state，與「URL 為唯一狀態」原則衝突。

> **未來考慮**：若客服反映「翻第 5 頁後忘記前面看到什麼」，再評估改 append 模式。屆時 URL 改記 `cursors[]` 多個游標或改 offset；非 v1 範圍。

---

## 7. 匯出 CSV（`ExportButton` + `ExportJobStatus`）

### 7.1 按鈕條件顯示

- `session.role === 'viewer'` 時**不**渲染（[`07 §4.1`](./07-admin-rbac-audit.md)：admin / user 可匯出，viewer 不可）
- 用 `useSession()` 取 `role`（單一字串，**非**陣列）；client component
- 後端最終把關——按鈕渲染與否不是安全邊界

### 7.2 同步 vs async 分流

```
使用者點「匯出」
       │
       ▼
┌──────────────────────────┐
│ 估算結果筆數              │
│ （前端目前無精確值；      │
│  以已載入頁數 × limit 估）│
└──────────┬───────────────┘
           │
   ≤ 1000 ?
   ┌───────┴────────┐
   ▼                ▼
 同步              async
 直接觸發           觸發 job
 `<a href=         接收 jobId
  "/api/.../       開 Modal 顯示
  export?...">`    輪詢狀態
                   完成後顯示
                   下載連結
```

> **筆數估算不精準**：前端只知道「已載入幾頁」，總筆數後端不回。v1 策略：若使用者從未翻頁 → 預設視為「少」走同步；若已翻過 → 視為「多」走 async。
>
> 更穩健的做法：點「匯出」時先 `HEAD` 或 `?count_only=true` 端點預檢——但這需後端支援，先記入 [§11 開放問題](#11-開放問題)。

### 7.3 同步匯出

- `<a href="/api/players/[id]/topups/export?<query>&format=csv" download>` 直接觸發瀏覽器下載
- 瀏覽器處理 file save 對話框；前端不需特別 handle response body
- 失敗 → 瀏覽器顯示錯誤頁；前端不另顯示錯誤態（接受瀏覽器原生行為，因 `<a download>` 無 `fetch` API 可監聽）

### 7.4 Async 匯出

- 點按鈕 → `POST /api/players/[id]/topups/export/async`，body 為當前篩選
- 取得 `jobId` → 開 `ExportJobStatus` Modal
- Modal 內以 `setInterval` 輪詢 `GET /api/exports/[jobId]`，backoff `2s, 4s, 8s, ... max 30s`
- `status === 'succeeded'` → 顯示「下載」按鈕（`<a href={downloadUrl}>`）
- `status === 'failed'` → 顯示失敗訊息 + 「關閉」按鈕
- 使用者關閉 Modal → 停止輪詢；下一次點匯出將觸發新 job

> **不持久化 jobId**：v1 假設使用者全程等待。若關閉分頁 / 重整即放棄該 job；未來若有「我等會兒再下載」需求，再考慮持久化或 push notification。

### 7.5 匯出按鈕的篩選對應

匯出**使用當前 URL 篩選**——不是「使用者剛在 FilterBar 編輯但未套用」的狀態：

- 直觀（所見即所得）
- 避免「使用者改了篩選但忘記套用，匯出與看到的列表不一致」

實作：`ExportButton` 從 `useSearchParams()` 取當前 query，不從 FilterBar state 取。

---

## 8. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Loading** | route transition | skeleton 篩選列 + skeleton 表格列 |
| **Has results** | `records.length > 0` | `ResultTable` |
| **Empty results** | `records.length === 0` | `EmptyState`：「無符合條件的儲值紀錄」+「清除篩選」CTA |
| **400 invalid_input** | 不應發生（client 已驗）；若仍出現 → schema 不同步 | `ErrorState variant="bad-request"` |
| **403 forbidden** | 後端拒絕本角色 | `ErrorState variant="forbidden"`（整頁）；其他玩家連結不可進入此頁 |
| **404 player-not-found** | `playerId` 不存在 | Next.js `notFound()`：「找不到此玩家」+「回搜尋頁」 |
| **429** | 限流 | `ErrorState variant="rate-limited"`：倒數重試 |
| **5xx** | upstream 失敗 | Next.js `error.tsx`：通用錯誤 + 重試 |

---

## 9. URL 與篩選同步

### 9.1 Query params

對應 §4.1 表格；採 camelCase（與 [`08 §7.1`](./08-screen-player-search.md) 相同慣例）：

```
/players/01HABCD/topups?from=2026-06-01&to=2026-06-28&status=success,refunded&paymentMethod=credit_card,apple_pay&currency=TWD&minAmount=10000&maxAmount=100000&sort=amount_desc
```

### 9.2 解析（`_lib/query-params.ts`）

```ts
export type TopupListQuery = {
  from?:           string         // YYYY-MM-DD
  to?:             string
  status?:         TopupStatus[]
  paymentMethod?:  string[]
  currency?:       string
  minAmount?:      number
  maxAmount?:      number
  sort?:           TopupSort
  cursor?:         string
  limit?:          number
}

export function parseListQuery(params: URLSearchParams | ReadonlyURLSearchParams): TopupListQuery
export function serializeListQuery(query: TopupListQuery): string
```

- 多值欄位（`status` / `paymentMethod`）逗號分隔；`parseListQuery` 用 `.split(',')`
- 解析失敗欄位 → fall back 預設（不 throw）

---

## 10. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| FilterBar | 每欄位有 label；Tab 順序由左至右 |
| 套用 / 清除按鈕 | `<button type="submit">` / `<button type="button">` |
| MultiSelect | 鍵盤可開合（Space / Enter）、上下鍵移焦、Space 切換選取 |
| DateRangePicker | 原生 `<input type="date">` 已支援鍵盤；不另外實作 |
| 表格 | `<table>` 語意；表頭 `<th scope="col">`；列 `<tr role="row">` |
| 排序狀態 | `<th aria-sort="descending">` |
| 「載入更多」 | `<button>` + `aria-busy="true"` 載入中 |
| 匯出 Modal | `<dialog>` 或 React Aria；focus trap；Esc 關閉 |
| 退款率警示 / 狀態 tag | 文字 + 顏色 |
| 載入態 | `aria-live="polite"` |

---

## 11. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | layout 已處理 redirect |
| [`03-observability.md`](./03-observability.md) | metric：`topups.list.result_count`、`topups.export.triggered{mode}`、`topups.list.error{code}` |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源；URL 篩選參數 ↔ §3.2 後端 query 對應 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 匯出按鈕角色判斷 |
| [`09-screen-player-detail.md`](./09-screen-player-detail.md) | 上游入口 |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | 列點擊導頁 |

---

## 12. 測試清單（TDD）

### 12.1 `_lib/query-params.test.ts`

```ts
it('should parse all known fields from URLSearchParams')
it('should parse status as array by splitting comma-separated value')
it('should parse paymentMethod as array by splitting comma-separated value')
it('should parse minAmount / maxAmount as integers')
it('should fall back to undefined when minAmount is non-integer (no throw)')
it('should ignore from-only or to-only (must come as a pair)')
it('should preserve cursor opaque string verbatim')
it('serializeListQuery should join arrays with comma')
it('serializeListQuery should omit undefined and empty arrays')
```

### 12.2 `_components/date-range-picker.test.tsx`

```ts
it('should require both from and to to enable Apply')
it('should show inline error when from > to')
it('should show inline error when range > 366 days')
it('should serialize selected dates as YYYY-MM-DD in user local timezone')
it('should hydrate values from URL search params on mount')
```

### 12.3 `_components/multi-select.test.tsx`

```ts
it('should render checkbox per option')
it('should render selected chips inside the trigger')
it('should toggle selection with Space when option is focused')
it('should be keyboard-navigable (Up/Down) within options list')
it('should close on Esc and return focus to trigger')
```

### 12.4 `_components/amount-range.test.tsx`

```ts
it('should disable inputs when currency is not selected')
it('should show tooltip "請先選幣別" when disabled')
it('should validate minAmount <= maxAmount with inline error')
it('should convert user input (199.00 TWD) to minor unit integer (19900) on submit')
it('should hydrate values from URL search params on mount (minor unit → display unit)')
```

### 12.5 `_components/filter-bar.test.tsx`

```ts
it('should hydrate all sub-controls from URL search params')
it('should NOT call router.push when fields change before Apply is clicked')
it('should call router.push with serialized query when Apply clicked')
it('should call router.push("/players/[id]/topups") when Clear clicked')
it('should disable Apply when any inline validation error is present')
it('should call Apply when Enter pressed in any text input field')
```

### 12.6 `_components/result-row.test.tsx`

```ts
it('should render createdAt with short format for in-year and full format for cross-year')
it('should render "—" when orderId is null')
it('should right-align amount column')
it('should format amount with Intl.NumberFormat using currency minor unit')
it('should render status tag with correct visual variant per status')
it('should render failureReason tooltip when status is failed')
it('should navigate to /players/[id]/topups/[recordId] when row clicked')
it('should be focusable and navigate on Enter')
```

### 12.7 `_components/pagination.test.tsx`

```ts
it('should NOT render button when nextCursor is null')
it('should render button when nextCursor is non-null')
it('should call router.push with cursor param when clicked')
it('should expose aria-busy on click until route transition completes')
```

### 12.8 `_components/export-button.test.tsx`

```ts
// 條件顯示
it('should NOT render when session.role is "viewer"')
it('should render when session.role is "user"')
it('should render when session.role is "admin"')

// 同步流程
it('should render as <a download> link when sync mode is chosen')
it('should include current URL search params in the export URL')
it('should use href to /api/players/[id]/topups/export?... when sync')

// async 流程
it('should POST to /api/players/[id]/topups/export/async when async mode chosen')
it('should open ExportJobStatus modal with returned jobId')
it('should NOT include unsubmitted FilterBar state — uses current URL search params')

// 判斷模式
it('should choose sync mode when no cursor is present (first page only)')
it('should choose async mode when cursor is present (user already paginated)')
```

### 12.9 `_components/export-job-status.test.tsx`

```ts
it('should poll GET /api/exports/[jobId] starting at 2s interval')
it('should backoff polling interval (2s, 4s, 8s, max 30s)')
it('should render download link when status becomes succeeded')
it('should render failure copy when status becomes failed')
it('should stop polling when modal is closed')
it('should trap focus inside modal')
it('should close on Esc and return focus to trigger button')
```

### 12.10 `page.test.tsx`（整合）

```ts
// 主流程
it('should call listTopups with parsed query on initial render')
it('should render ResultTable when records.length > 0')
it('should render no-results EmptyState when records is empty array')
it('should render rate-limited ErrorState on 429 with Retry-After')
it('should render forbidden ErrorState on 403')
it('should call notFound() on 404 (player not found)')

// metric
it('should emit topups.list.result_count metric on render')
```

### 12.11 E2E（Playwright）

```ts
test('filter by date range + status returns matching records and URL reflects state')
test('clicking Clear resets URL to /players/[id]/topups and shows default results')
test('clicking a row navigates to /players/[id]/topups/[recordId]')
test('user role can sync-export CSV from first page')
test('admin role can async-export after paginating; modal shows progress and download link')
test('viewer role does not see Export button')
test('reload preserves filter state via URL')
```

---

## 13. 開放問題

- [ ] 是否新增 `count_only` 預檢端點供 ExportButton 判斷 sync/async？影響 §7.2 流程；建議是
- [ ] 列表新增「最近活動」「玩家暱稱」等冗餘欄位？v1 純儲值欄位；若財務常需「我看到一筆 199 是誰的玩家」可考慮
- [ ] 退款率警示是否在列表頁也顯示（如玩家層級 banner）？目前在 [`09`](./09-screen-player-detail.md) TopupSummaryCard 顯示；列表頁不重複
- [ ] 多幣別玩家篩選時是否預設「currency=玩家主貨幣」？目前不預設；UX 需求待 PM 確認
- [ ] 排序 `amount_desc/asc` 跨幣別意義不大，是否在未選 currency 時 disable？目前不 disable，由提示處理
- [ ] async 匯出未完成時關閉分頁，是否提示「Job 仍在後端執行，可去 [job 中心] 查看」？v1 無 job 中心，先不提示
