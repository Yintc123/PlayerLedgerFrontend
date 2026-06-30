# 儲值紀錄列表頁規格書

## 1. 概覽

CMS 後台「玩家儲值紀錄列表頁」——從 [`09`](./09-screen-player-detail.md) 玩家詳情頁或直接連結進入，提供日期區間 / 狀態 / 支付方式等篩選、排序、分頁，以及「建立儲值」入口。

> **後端契約已定案（2026-06）**：列表改打扁平資源 `GET /api/cms/deposit-records`（以 `?player_id=` 聚焦玩家），
> **OFFSET 分頁**（`page` / `page_size` + `meta.total`），多值篩選用**重複 key**（`?status=pending&status=failed`）。
> 後端**無匯出端點**——CSV 匯出改為**前端 client 端**從當前頁列表 `data` 產檔（UTF-8 BOM，見 [`06 §8`](./06-topup-records-domain.md) / §7.3）；幣別／金額篩選後端不支援，已移除。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 篩選列（日期、狀態、支付方式）
- 排序與列表
- 分頁（OFFSET，`page` / `page_size` / `meta.total`）
- 建立儲值入口（admin / user）
- 狀態（idle 不存在；無篩選即顯示預設結果）
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- 業務邏輯與 API 契約——見 [`06-topup-records-domain.md`](./06-topup-records-domain.md)
- 單筆明細頁——見 [`11-screen-topup-detail.md`](./11-screen-topup-detail.md)
- 角色權限（建立按鈕顯隱）——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)

### 核心原則

- **URL 為篩選狀態唯一來源**：與 [`08`](./08-screen-player-search.md) 相同模式；分享連結／重整可重現
- **Server-first**：篩選變更觸發 `router.push` → page.tsx 重新 SSR
- **空篩選 = 預設查詢**：本頁不存在「請輸入條件」的 idle 態；URL 無篩選時顯示「最近全部紀錄」（依預設排序）
- **建立受角色控制**：「建立儲值」按鈕僅顯示給 admin / user；viewer 不顯示，後端最終把關（[`07 §6`](./07-admin-rbac-audit.md)）

---

## 2. 路由與檔案結構

### 2.1 路由

```
/players/[playerId]/topups
/players/[playerId]/topups/new          # 建立儲值表單（admin / user）
/players/[playerId]/topups/[recordId]   # → spec 11
```

### 2.2 檔案結構

```
src/app/(cms)/players/[playerId]/topups/
├── page.tsx                       # 列表頁（Server Component）
├── page.test.tsx
├── error.tsx                      # 5xx
├── new/
│   └── page.tsx                   # 建立儲值表單（POST /api/cms/deposit-records）
└── _components/
    ├── filter-bar.tsx             # 篩選列（Client）
    ├── filter-bar.test.tsx
    ├── date-range-picker.tsx      # 日期區間（Client）
    ├── date-range-picker.test.tsx
    ├── multi-select.tsx           # 多選下拉（Client） — 用於狀態 / 支付方式
    ├── multi-select.test.tsx
    ├── sort-select.tsx            # 排序下拉（Client）
    ├── sort-select.test.tsx
    ├── result-table.tsx           # 結果表（Server）
    ├── result-table.test.tsx
    ├── result-row.tsx             # 單列（Client）
    ├── result-row.test.tsx
    # pagination 已提升至 @/components/topups/pagination.tsx（頁碼導航，與 spec 14 共用）
    ├── pagination.test.tsx
    ├── create-deposit-button.tsx  # 「建立儲值」入口（Client，依角色顯隱）
    ├── create-deposit-button.test.tsx
    ├── export-button.tsx          # 「匯出 CSV」入口（Client，依角色顯隱；client 端產檔）
    ├── export-button.test.tsx
    ├── empty-state.tsx
    ├── empty-state.test.tsx
    └── error-state.tsx
└── _lib/
    ├── query-params.ts
    └── query-params.test.ts

# CSV 產生純函式提升至 src/lib/topups/export-csv.ts（測試見 06 §11.7）
```

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `page.tsx` | Server | 解析 search params、呼叫 `listDeposits`、render |
| `FilterBar` | Client | 受控表單；包多個子 Client 元件 |
| `DateRangePicker` / `MultiSelect` / `SortSelect` | Client | 互動 + state |
| `ResultTable` | Server | 純展示 |
| `ResultRow` | Client | 鍵盤導覽、`router.push` |
| `Pagination` | Client | 點擊行為（OFFSET page+1） |
| `CreateButton` | Client | 依角色顯隱（admin / user）；連到建立表單 |
| `EmptyState` / `ErrorState` | Server | 純文案 |

> **Next.js 16 備註**：`page.tsx` 的 `params` 與 `searchParams` 皆為 `Promise`，於檔案頂端 `await` 取出（`const { playerId } = await params` / `const resolved = await searchParams`）。

---

## 4. 篩選列（`FilterBar`）

### 4.1 欄位

```
┌──────────────────────────────────────────────────────────────────┐
│  [日期區間 ▼] [狀態 (多選) ▼] [支付方式 (多選) ▼] [排序 ▼]      │
│                                          [清除] [套用]            │
└──────────────────────────────────────────────────────────────────┘
```

| 欄位 | 元件 | URL param | 後端 query | 預設值 |
|------|------|----------|-----------|--------|
| 日期區間 | `DateRangePicker` | `startDate`、`endDate` | `start_date`、`end_date` | 不帶（後端回最近） |
| 狀態 | `MultiSelect` | `status`（重複 key） | `status`（重複 key OR） | 不帶 |
| 支付方式 | `MultiSelect` | `paymentMethod`（重複 key） | `payment_method`（重複 key OR） | 不帶 |
| 排序 | `SortSelect` | `sort` | `sort` | `-created_at`（不寫 URL，UI 顯示為「最新優先」） |

> 幣別下拉與金額區間已移除——後端 `GET /api/cms/deposit-records` 不支援 `currency` / `min_amount` / `max_amount` 篩選（見 [`06 §3.2`](./06-topup-records-domain.md)）。

### 4.2 行為

| 行為 | 對應 |
|------|------|
| 任一欄位變更 | 暫存在 client state；**不**立即送出 |
| 點「套用」按鈕 | `router.push('/players/[id]/topups?<query>')`；URL 變更觸發 page.tsx 重新 SSR |
| 點「清除」按鈕 | `router.push('/players/[id]/topups')`；回到預設 |
| 任一欄位按 Enter | 等同點「套用」 |
| 日期區間驗證 | client 端驗證 `startDate <= endDate`，失敗時顯示行內錯誤、套用按鈕 disable |

> **為何不「即時套用」**：使用者連續調整多欄位時即時套用會造成多次 server roundtrip。後台場景對「按下確認」操作較自然。

### 4.3 日期區間

- 後端**允許單邊**（僅 `start_date` 或僅 `end_date`），前端篩選 UI 不強制成對
- UI 採兩個 `<input type="date">` 並排；若兩者皆有值，限制 `endDate >= startDate`
- 顯示時區：日期區間 *輸入* 用原生 `<input type="date">`，本就以瀏覽器本地日期收受；序列化到 URL / 後端 query 時轉為 `YYYY-MM-DD`
- **不附時間部分**：日期粒度即可；後端把 `start_date` 視為當日 00:00:00 UTC、`end_date` 視為當日 23:59:59 UTC（含端點，見 [`06 §3.2`](./06-topup-records-domain.md)）

> **時間 *顯示* 時區**：列表 `createdAt` 等時間 *欄位* 的顯示與篩選 *輸入* 不同——欄位顯示走共用 helper `lib/format/datetime.ts`，固定 `APP_TIME_ZONE = 'Asia/Taipei'`（避免 SSR hydration mismatch，見 [`08 §5.1`](./08-screen-player-search.md)）；日期區間 *picker* 為原生輸入元件，維持瀏覽器本地。

### 4.4 狀態 / 支付方式多選

- `MultiSelect` 顯示 checkbox 清單；選中項以 chip 顯示在欄位內
- **多值編碼為重複 key**（`?status=pending&status=failed`），對齊後端 OpenAPI（`type: array`，重複出現做 OR）
- 選項來源：
  - 狀態：五個值（`pending` / `completed` / `failed` / `cancelled` / `refunded`）+ 中文 label
  - 支付方式：五個值（`bank_transfer` / `credit_card` / `manual` / `convenience_store` / `e_wallet`）；中文 label 來自 `lib/topups/labels.ts`（[`06 §12`](./06-topup-records-domain.md) 開放問題）

---

## 5. 列表（`ResultTable` + `ResultRow`）

### 5.1 欄位

| 欄位 | 來源 | 顯示 |
|------|------|------|
| 建立時間 | `createdAt` | `MM-DD HH:mm`（本年）/ `YYYY-MM-DD HH:mm`（跨年） |
| 玩家 | `playerName` | 玩家暱稱快照；過長截斷 + tooltip |
| 參考號 | `referenceNo` | `null` → `—`；過長截斷 + tooltip |
| 金額 | `amount` + `currency` | `Intl.NumberFormat` 換算為主貨幣單位（依 [`06 §2.1`](./06-topup-records-domain.md) 各幣別最小單位規則）；右對齊 |
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
| completed | 綠 | — |
| failed | 紅 | — |
| cancelled | 灰 | — |
| refunded | 紅 | tag 文字「已退款」 |

> **實作備註**：狀態 tag 為共用元件 `@/components/topups/status-tag`（`TopupStatusTag`），由 `result-row.tsx` 引用、跨螢幕 10／11 共用。`pending` 渲染時鐘圖示。後端模型無 `failureReason` 欄位，failed 不再顯示失敗原因 tooltip。

---

## 6. 分頁（`Pagination`，OFFSET）

後端採 **OFFSET 分頁**（`page` / `page_size` + `meta.total`，見 [`06 §5`](./06-topup-records-domain.md)）。
分頁採**頁碼導航**（`1 2 3 … N`），由共用元件 `@/components/topups/pagination.tsx` 提供（提升自本 spec，與 [`14`](./14-screen-global-deposit-records.md) 共用；介面見 [`14 §B1.3`](./14-screen-global-deposit-records.md)）。

- **總頁數** = `Math.ceil(total / pageSize)`；`<= 1` 時不渲染分頁（單頁無需導航）。
- 渲染：`上一頁` ‧ 頁碼按鈕（含省略號 `…`）‧ `下一頁`。
  - 頁碼視窗：恆顯示第 1 頁與最末頁 + 目前頁 ±1，其餘以 `…` 省略。
  - 目前頁標 `aria-current="page"`；`上一頁` 於第 1 頁、`下一頁` 於最末頁 `disabled`。
- 點任一頁碼 / 上一頁 / 下一頁 → `router.push(`${basePath}${serializeListQuery({ ...query, page: N })}`)`，**其餘篩選不變**；`page === 1` 時省略 `page` 參數（URL 不寫預設值）。
- **跳到新頁**語意：URL 帶 `page`、新頁覆蓋舊頁（**不** append、**不** infinite scroll，同 [`08 §5.3`](./08-screen-player-search.md) 理由）——維持「URL 為唯一狀態」。
- `page.tsx` 把 `meta { page, pageSize, total }` 傳給 `Pagination`（serializable `basePath` + `query`，見 [`14 §B1.3`](./14-screen-global-deposit-records.md)）。
- 載入中（route transition）以 `aria-busy` 標示。

---

## 7. 角色感知入口（`CreateDepositButton` / `ExportButton`）

> 兩顆按鈕都依 `session.role` 顯隱（純 UX，非安全邊界）。建立儲值經後端 POST；匯出為 client 端產檔（後端**無**匯出端點，見 [`06 §8`](./06-topup-records-domain.md)）。

### 7.1 建立儲值 — 按鈕條件顯示

- `session.role === 'viewer'` 時**不**渲染；admin / user 顯示「建立儲值」按鈕（[`07 §4.1`](./07-admin-rbac-audit.md)：POST 限 admin / user）
- 用 `useSession()` 取 `role`（單一字串，**非**陣列）；client component
- 後端最終把關（POST 對 viewer 回 403）——按鈕渲染與否不是安全邊界

### 7.2 行為

- 點按鈕 → `router.push('/players/[playerId]/topups/new')`，進入建立儲值表單頁
- 表單頁送 `POST /api/cms/deposit-records`（`createDeposit`，見 [`06 §6A`](./06-topup-records-domain.md)）；成功後導回列表頁並顯示新建紀錄
- 表單欄位：`amount`（依幣別最小單位）/ `currency`（預設 TWD）/ `paymentMethod` / `internalNote` / `displayNote` / `referenceNo`；`playerId` 由路由帶入
- `status` 由後端固定為 `pending`，表單不提供；`playerName` / `operatorId` / `operatorIp` 由 server 填入

> **建立表單詳細欄位驗證與錯誤態**（404 player 不存在、409 reference_no 重複）屬建立表單頁規格；本列表頁僅負責入口按鈕的角色顯隱與導頁。

### 7.3 匯出 CSV — `ExportButton`

- **角色顯隱**：`role !== 'admin' && role !== 'user'` 時**不**渲染（viewer 隱藏）；純 UX，非安全邊界（[`07 §3.4`](./07-admin-rbac-audit.md)）。
- **資料來源**：當前已渲染的列表 `records`（一次 `GET /api/cms/deposit-records` 回應，≤ `page_size` 筆）。`ExportButton` 接 `records` prop；**僅匯出當前頁**，不跨頁重抓（範圍限制見 [`06 §8`](./06-topup-records-domain.md)）。
- **產檔**：呼叫純函式 `toDepositCsv(records)`（`src/lib/topups/export-csv.ts`）得含 UTF-8 BOM 的 CSV 字串 → `Blob` → `URL.createObjectURL` → 觸發 `<a download>` 下載。檔名建議 `deposit-records-<yyyymmdd>.csv`。
- **匯出欄位（螢幕可見）**：`createdAt` / `playerName` / `referenceNo` / `amount`（**整數原值**，不格式化）/ `currency` / `paymentMethod`（中文 label）/ `status`（中文 label）。**不含** `internalNote` / `operatorId` / `operatorIp`——後端對 viewer 未遮罩，前端不主動匯出這些以避免放大外洩（[`07 §5`](./07-admin-rbac-audit.md)）。
- **空列表**：`records.length === 0` 時頁面顯示 EmptyState（§8），不渲染 `ExportButton`（無資料可匯出）。

> **為何接 `records` prop 而非自行 fetch**：列表頁是 RSC，`records` 已在 server 端取得並傳給 `ResultTable`；`ExportButton` 與 `ResultTable` 同層接同一份 `records`，避免重複請求與資料不一致。

---

## 8. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Loading** | route transition | skeleton 篩選列 + skeleton 表格列 |
| **Has results** | `records.length > 0` | `ResultTable` |
| **Empty results** | `records.length === 0` | `EmptyState`：「無符合條件的儲值紀錄」+「清除篩選」CTA |
| **400 invalid input** | 不應發生（client 已驗）；若仍出現 → schema 不同步 | `ErrorState variant="bad-request"` |
| **403 forbidden** | 後端拒絕本角色（非 CMS staff） | `ErrorState variant="forbidden"`（整頁） |
| **空 player_id** | `player_id` 不存在於 members | 列表端點不 404，僅回空陣列 → 顯示 `EmptyState`（後端無玩家詳情端點可預先驗證，見 [`09`](./09-screen-player-detail.md)） |
| **429** | 限流 | `ErrorState variant="rate-limited"`：倒數重試 |
| **5xx** | upstream 失敗 | Next.js `error.tsx`：通用錯誤 + 重試 |

---

## 9. URL 與篩選同步

### 9.1 Query params

對應 §4.1 表格；URL param 採 camelCase（與 [`08 §7.1`](./08-screen-player-search.md) 相同慣例），多值欄位用**重複 key**（無逗號），序列化到後端時轉為 snake_case（`startDate`→`start_date` 等）：

```
/players/01HABCD/topups?startDate=2026-06-01&endDate=2026-06-28&status=completed&status=refunded&paymentMethod=credit_card&paymentMethod=bank_transfer&sort=-amount&page=1
```

對應後端請求：

```
GET /api/cms/deposit-records?player_id=01HABCD&start_date=2026-06-01&end_date=2026-06-28&status=completed&status=refunded&payment_method=credit_card&payment_method=bank_transfer&sort=-amount&page=1&page_size=20
```

### 9.2 解析（`_lib/query-params.ts`）

```ts
export type TopupListQuery = {
  startDate?:      string          // YYYY-MM-DD
  endDate?:        string
  status?:         DepositStatus[] // pending | completed | failed | cancelled | refunded
  paymentMethod?:  string[]
  sort?:           DepositSort     // 'created_at' | '-created_at' | 'amount' | '-amount'
  page?:           number          // 1-based
  pageSize?:       number          // 上限 100，預設 20
}

export function parseListQuery(params: URLSearchParams | ReadonlyURLSearchParams): TopupListQuery
export function serializeListQuery(query: TopupListQuery): string
```

- 多值欄位（`status` / `paymentMethod`）用**重複 key**；`parseListQuery` 以 `params.getAll(key)` 取多值
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
| 分頁導航 | `<nav aria-label="分頁">`；頁碼 `<button>`，目前頁 `aria-current="page"`；route transition 時 `aria-busy` |
| 「建立儲值」 | `<a>` / `<button>`；可鍵盤聚焦 |
| 狀態 tag | 文字 + 顏色（不單靠顏色） |
| 載入態 | `aria-live="polite"` |

---

## 11. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | layout 已處理 redirect |
| [`03-observability.md`](./03-observability.md) | metric：`topups.list.result_count`、`topups.create.clicked`、`topups.list.error{code}` |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源；URL 篩選參數 ↔ §3.2 後端 query 對應 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 建立按鈕角色判斷（admin / user） |
| [`09-screen-player-detail.md`](./09-screen-player-detail.md) | 上游入口 |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | 列點擊導頁 |

---

## 12. 測試清單（TDD）

### 12.1 `_lib/query-params.test.ts`

```ts
it('should parse all known fields from URLSearchParams')
it('should parse status as array via getAll (repeated keys)')
it('should parse paymentMethod as array via getAll (repeated keys)')
it('should parse page / pageSize as integers')
it('should fall back to undefined when pageSize is non-integer (no throw)')
it('should accept single-sided startDate or endDate (not required as a pair)')
it('serializeListQuery should emit repeated keys for arrays (no comma)')
it('serializeListQuery should omit undefined and empty arrays')
it('serializeListQuery should map camelCase to snake_case backend params (startDate→start_date)')
```

### 12.2 `_components/date-range-picker.test.tsx`

```ts
it('should allow single-sided date (only startDate or only endDate)')
it('should show inline error when endDate < startDate')
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
it('should list status options: pending / completed / failed / cancelled / refunded')
```

### 12.4 `_components/filter-bar.test.tsx`

```ts
it('should hydrate all sub-controls from URL search params')
it('should NOT call router.push when fields change before Apply is clicked')
it('should call router.push with serialized query (repeated keys) when Apply clicked')
it('should call router.push("/players/[id]/topups") when Clear clicked')
it('should disable Apply when any inline validation error is present')
it('should call Apply when Enter pressed in any text input field')
```

### 12.5 `_components/result-row.test.tsx`

```ts
it('should render createdAt with short format for in-year and full format for cross-year')
it('should render playerName column')
it('should render "—" when referenceNo is null')
it('should right-align amount column')
it('should format amount with Intl.NumberFormat using per-currency minor unit (TWD=0 decimals)')
it('should render status tag with correct visual variant per status (completed, not success)')
it('should navigate to /players/[id]/topups/[recordId] when row clicked')
it('should be focusable and navigate on Enter')
```

### 12.6 `@/components/topups/pagination.test.tsx`（共用元件，頁碼導航）

```ts
it('should NOT render when total <= pageSize (single page)')
it('should render numbered page buttons when multiple pages exist')
it('should mark the current page with aria-current="page"')
it('should disable 上一頁 on the first page and 下一頁 on the last page')
it('should push basePath with page=N (filters preserved) when a page is clicked')
it('should omit the page param when navigating to page 1 (clean default URL)')
it('should render ellipsis (…) when pages exceed the visible window')
it('should expose aria-busy during the route transition')
```

### 12.7 `_components/create-deposit-button.test.tsx`

```ts
it('should NOT render when session.role is "viewer"')
it('should render when session.role is "user"')
it('should render when session.role is "admin"')
it('should navigate to /players/[id]/topups/new when clicked')
```

### 12.8 `_components/export-button.test.tsx`

```ts
it('should NOT render when session.role is "viewer"')
it('should render when session.role is "user"')
it('should render when session.role is "admin"')
it('should generate a CSV blob download from the provided records on click')
```

> CSV 產生純函式 `toDepositCsv` 的測試（BOM / 表頭 / 跳脫 / 金額整數原值 / 不含敏感欄）見 [`06 §11.7`](./06-topup-records-domain.md)。

### 12.9 `page.test.tsx`（整合）

> **測試模式**：async Server Component 的資料分支抽為內層 async 元件 `TopupsResult` 並 export，測試直接 `await` 後 render 該元件（RTL 無法解析巢狀 RSC）。

```ts
// 主流程
it('should call listDeposits with parsed query (player_id + filters) on initial render')
it('should render ResultTable when data.length > 0')
it('should render no-results EmptyState when data is empty array')
it('should pass meta {page, pageSize, total} to Pagination')
it('should render rate-limited ErrorState on 429 with Retry-After')
it('should render forbidden ErrorState on 403')

// metric
it('should emit topups.list.result_count metric on render')
```

### 12.9 E2E（Playwright）

```ts
test('filter by date range + status (repeated keys) returns matching records and URL reflects state')
test('clicking Clear resets URL to /players/[id]/topups and shows default results')
test('clicking a row navigates to /players/[id]/topups/[recordId]')
test('clicking page 2 advances results and reflects page=2 in the URL')
test('admin role sees Create button and reaches /players/[id]/topups/new')
test('viewer role does not see Create button')
test('reload preserves filter state via URL')
```

---

## 13. 開放問題

- [x] **CSV 匯出**：v1 採前端 client 端從當前頁 `data` 產檔（§7.3）；「匯出全部符合篩選」（跨頁）與伺服器端稽核待後端 export 端點（見 [`06 §8`](./06-topup-records-domain.md)）
- [ ] 後端**無玩家詳情端點**：無法在進入列表前驗證 `player_id` 是否存在（不存在僅回空陣列）；待後端補 members 詳情端點
- [x] OFFSET 分頁改頁碼 UI（`1 2 3 … N`，因有 `meta.total`）：已實作（共用 `@/components/topups/pagination.tsx`，§6）。
- [ ] 列表新增「最近活動」等冗餘欄位？v1 純儲值欄位
- [ ] 多幣別：後端目前僅 TWD；開放多幣別後再評估金額排序 / 顯示細節（[`06 §12`](./06-topup-records-domain.md)）
