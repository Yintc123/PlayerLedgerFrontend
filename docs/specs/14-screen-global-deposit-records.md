# 全玩家儲值紀錄頁規格書

> 跨玩家的儲值紀錄總覽頁。與 [`10-screen-topup-list.md`](./10-screen-topup-list.md)（**單一玩家**視角 `/players/[playerId]/topups`）互補，本頁為**頂層、跨玩家**視角 `/deposit-records`，支援「列出所有 pending」「依玩家聚焦」等後台稽核情境。
>
> 後端契約與資料模型完全沿用 [`06-topup-records-domain.md`](./06-topup-records-domain.md)：列表端點 `GET /api/cms/deposit-records` 為**扁平資源**，`player_id` 為**可選 query 篩選**——**不帶即回全玩家紀錄**（[`06 §3.1`](./06-topup-records-domain.md)）。本頁因此不需新後端端點，僅是既有 domain 層 `listDeposits()` 在「不帶 `playerId`」下的 UI 呈現。
>
> 本文件依需求分為兩大部分：**Part A 業務邏輯** 與 **Part B UI 元件**。

---

# Part A — 業務邏輯

## A1. 概覽

| 項目 | 內容 |
|------|------|
| 目的 | 讓 CMS staff 跨玩家檢視 / 篩選 / 排序 / 分頁所有儲值紀錄 |
| 路由 | `/deposit-records`（頂層，非掛在 player 下） |
| 資料來源 | `listDeposits(query)`（[`06 §3`](./06-topup-records-domain.md)），`query.playerId` 省略 → 全玩家 |
| 與 spec 10 關係 | **互補非取代**；spec 10 聚焦單一玩家、含「建立儲值」入口，本頁為跨玩家總覽 |
| 後端新端點 | **無需**——重用既有扁平資源 |

### 核心原則

- **URL 為篩選狀態唯一來源**：與 [`08`](./08-screen-player-search.md) / [`10 §核心原則`](./10-screen-topup-list.md) 相同；分享連結 / 重整可重現。
- **Server-first**：篩選變更 `router.push` → `page.tsx` 重新 SSR。
- **空篩選 = 預設查詢**：本頁無 idle 態；URL 無篩選時顯示「最近全部玩家紀錄」（預設排序 `-created_at`）。
- **跨玩家為預設**：`playerId` 是可選聚焦條件，不是進入頁面的前提。
- **權限後端最終把關**：角色顯隱僅為 UX，安全邊界在後端（[`07`](./07-admin-rbac-audit.md)）。

## A2. 資料模型

完全沿用 [`06 §2 DepositRecord`](./06-topup-records-domain.md)（`src/lib/topups/types.ts`）。本頁因跨玩家，特別倚賴以下兩欄（單玩家頁可省略顯示）：

| 欄位 | 用途 |
|------|------|
| `playerId` | 列點擊導頁、玩家篩選回填 |
| `playerName` | 列表「玩家」欄顯示（server 由 members 快照填入） |

> 不新增任何型別；`DepositRecord` / `DepositListQuery` / `DepositListResult` 已足夠。

## A3. 列表查詢

### A3.1 端點與參數

沿用 [`06 §3.1 / §3.2`](./06-topup-records-domain.md)：

```
GET /api/cms/deposit-records?<query>        # 不帶 player_id → 全玩家
```

| 參數 | 型別 | 預設 | 本頁差異 |
|------|------|------|----------|
| `page` | integer | `1` | 同 spec 10 |
| `page_size` | integer | `20`（上限 100） | 同 spec 10 |
| `player_id` | string(UUID) | —（**不帶 = 全玩家**） | **可選篩選**（spec 10 為路由必帶） |
| `status` | string[]（重複 key OR） | — | 同 spec 10 |
| `payment_method` | string[]（重複 key OR） | — | 同 spec 10 |
| `start_date` / `end_date` | date `YYYY-MM-DD` | — | 同 spec 10（單邊允許；`end < start` → 400） |
| `sort` | `created_at \| -created_at \| amount \| -amount` | `-created_at` | 同 spec 10 |

### A3.2 與 spec 10 的唯一語意差

- spec 10：`player_id` 由**路由** `[playerId]` 帶入，恆存在。
- 本頁：`player_id` 由**選用篩選**帶入；省略時 `listDeposits({})` 回 `MOCK_ALL_DEPOSITS`（後端則回全玩家），見 `src/lib/topups/list.ts:60-62`。

### A3.3 Response / 分頁

沿用 [`06 §3.3`](./06-topup-records-domain.md)（envelope `data` + `meta{page,page_size,total}`，BFF camelCase）與 [`06 §5` OFFSET 分頁](./06-topup-records-domain.md)。`page.tsx` 由 `meta` 推導下一頁是否存在。

## A4. 權限（RBAC）

沿用 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)，**不新增例外**：

| 角色 | 本頁 |
|------|------|
| `admin` / `user` | 可讀全玩家列表；PII 由後端依角色回傳 |
| `viewer` | 可讀；PII 由**後端**遮罩（BFF 不二次遮罩，[`07 §1`](./07-admin-rbac-audit.md)）；不可匯出 |
| `member` | 玩家端 token，`(cms)/layout.tsx` 已擋（[`02`](./02-auth-session.md)） |

- **無「建立儲值」按鈕**：建立需指定目標玩家（`playerId`），語意屬單玩家流程（spec 10 / `topups/new`）。本頁不提供建立入口，避免「先建立才選玩家」的逆向流程。（見 A7 開放問題）
- **匯出 CSV（當前頁）**：見 A4.1。

## A4.1 匯出 CSV（當前頁）

沿用 [`10 §7.3`](./10-screen-topup-list.md) 的 **client 端、純當前頁** 匯出——**非**後端端點。spec 06 §8 指的是「後端無 export endpoint」，與此處 client 端匯出不衝突：`toDepositCsv(records)` 只把**已在畫面上的當前頁 `records`** 轉成 CSV blob 下載（[`06 §11.7`](./06-topup-records-domain.md)）。

| 項目 | 本頁決定 | 理由 |
|------|----------|------|
| 範圍 | **僅當前頁**（最多 `pageSize` 筆） | 本系統除 `/api/login` 外不做 client fetch（[`08`](./08-screen-player-search.md)）；逐頁抓全集需 client 多次 fetch 或新後端端點，皆超出 v1 範圍 |
| 觸發 | 結果區右上「匯出 CSV」按鈕（`ExportButton`，文案與 spec 10 一致） | `records.length === 0`（Empty 態）不渲染按鈕 |
| RBAC | **僅 `admin` / `user` 可見**，`viewer` 隱藏 | 對齊 A4 權限表「viewer 不可匯出」；純 UX 顯隱，安全邊界仍在後端 |
| 欄位 | spec 10 七欄 **+「玩家 ID」**（插於「玩家」欄後） | 跨玩家頁玩家名可能重複，UUID 才唯一可對帳（對齊 B5.1「玩家 ID」獨立欄）；藉 `toDepositCsv(records, { includePlayerId: true })` 帶出 |
| 安全欄位 | **不含** `internalNote` / `operatorId` / `operatorIp` | 沿用 [`07 §5`](./07-admin-rbac-audit.md)；前端不主動匯出敏感欄 |
| 檔名 | `deposit-records-<yyyymmdd>.csv` | 沿用 spec 10 |

> **已知限制**：僅匯出當前頁（與 spec 10 相同行為），按鈕文案不另加「(本頁)」以維持共用元件一致。「匯出整個篩選結果」列為開放問題（見 A7；需先有後端 export 端點或放寬 client fetch 原則）。

## A5. 錯誤處理

對齊 [`10 §8`](./10-screen-topup-list.md) 狀態表，跨玩家情境下調整：

| 狀態 | 觸發 | UI |
|------|------|----|
| Has results | `records.length > 0` | `ResultTable` |
| Empty results | `records.length === 0` | `EmptyState`：「無符合條件的儲值紀錄」+「清除篩選」CTA |
| 400 invalid input | client 已驗仍出現 → schema 不同步 | `ErrorState variant="bad-request"` |
| 403 forbidden | 後端拒絕本角色 | `ErrorState variant="forbidden"`（整頁） |
| 篩選 `playerId` 不存在 | 列表端點不 404，回空陣列 | `EmptyState`（同 [`10 §8`](./10-screen-topup-list.md)） |
| 429 | 限流 | `ErrorState variant="rate-limited"`：倒數重試 |
| 5xx | upstream 失敗 | `error.tsx`：通用錯誤 + 重試 |

## A6. 與既有規格的對接

| 規格 | 對接點 |
|------|--------|
| [`02-auth-session.md`](./02-auth-session.md) | `(cms)/layout.tsx` 已處理 session / role redirect |
| [`03-observability.md §6.1`](./03-observability.md) | 畫面層 metric（`recordMetric`，定義於本 spec、對接前端遙測）：`deposits.list.result_count`、`deposits.list.error{code}`、`deposits.list.player_focus`（聚焦特定玩家時發布） |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源；URL 篩選 ↔ §3.2 後端 query 對應；**本頁為 §3.1「跨玩家檢視」動機的實現** |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 讀取角色與 PII 遮罩邊界；匯出 RBAC（admin/user 可見、viewer 隱藏，[`07 §4.1`](./07-admin-rbac-audit.md)） |
| [`08-screen-player-search.md`](./08-screen-player-search.md) | v1：列內玩家連結之後可導去玩家搜尋；**v1.1** 站內玩家搜尋下拉才重用 `searchPlayers`（見 A7） |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 共用元件來源（FilterBar 子元件、StatusTag、Pagination、**ExportButton** §7.3 / `toDepositCsv`） |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | 列點擊導頁目的地 |

## A7. 開放問題

- [ ] 跨玩家頁是否需要「建立儲值」入口？v1 不提供（建立屬單玩家流程）；若客服需求高，考慮「先選玩家 → 導 `topups/new`」。
- [ ] 是否提供跨玩家**彙總列**（如「本頁 completed 總額」）？v1 不做；後端無對應 aggregate 端點（[`06 §7`](./06-topup-records-domain.md)）。
- [ ] **匯出整個篩選結果（跨頁全集）**：v1 僅匯出當前頁（A4.1）。全集匯出需後端 export 端點（[`06 §8`](./06-topup-records-domain.md) 目前無）或 client 逐頁 fetch（違反 [`08`](./08-screen-player-search.md) no-client-fetch 原則）；待後端提供 export 端點後再評估。
- [x] OFFSET 分頁頁碼 UI（`1 2 3 … N`）：已實作（共用 `@/components/topups/pagination.tsx`，§B6）。
- [ ] **站內玩家搜尋下拉（typeahead）= v1.1**：需先定義 client 可呼叫的玩家搜尋端點（如 `GET /api/players/search`，經 catch-all proxy → 上游；mock 階段需對應 HTTP mock route），並對齊後端 OpenAPI。v1 不做，玩家聚焦靠 `?playerId=` + 列內連結（B4.2 / B5.2）。後端 `player_id` 僅單值，故不支援多玩家 OR。

---

# Part B — UI 元件

## B1. 路由與檔案結構

### B1.1 路由

```
/deposit-records                  # 全玩家儲值紀錄列表（Server Component）
```

> 單筆明細沿用 spec 11 既有路由 `/players/[playerId]/topups/[recordId]`（不另建頂層明細頁，避免雙重明細實作）。列點擊以該紀錄的 `playerId` + `id` 組成連結。

### B1.2 檔案結構

```
src/app/(cms)/deposit-records/
├── page.tsx                      # 列表頁（Server Component）
├── page.test.tsx
├── loading.tsx                   # skeleton（篩選列 + 表格列）
├── error.tsx                     # 5xx
├── _components/
│   ├── filter-bar.tsx            # 篩選列（Client）— 日期/狀態/支付方式/排序
│   ├── filter-bar.test.tsx
│   ├── active-player-chip.tsx    # 已聚焦玩家 chip + 清除（Client，server-first）
│   ├── active-player-chip.test.tsx
│   ├── result-table.tsx          # 結果表（Server）— 含「玩家」欄
│   ├── result-table.test.tsx
│   ├── result-row.tsx            # 單列（Client）— 玩家欄含聚焦連結
│   ├── result-row.test.tsx
│   ├── empty-state.tsx
│   └── error-state.tsx
# 不另建 export-button.tsx：提升 spec 10 既有 ExportButton 至 @/components/topups/（見 B1.3）
# 不另建 _lib/query-params.ts：重用並「提升」spec 10 既有那套（見 B1.3 / B7.2）
```

> **無 `player-filter` typeahead**：依 server-first 原則（見 B4.2），玩家聚焦以 URL `?playerId=` + 列內連結達成，不做 client 即時搜尋；站內玩家搜尋下拉降為 v1.1（見 A7）。

### B1.3 元件重用策略（重要）

spec 10 的子元件目前位於 `players/[playerId]/topups/_components/`。為避免複製，**先抽取與玩家無關的純展示 / 互動元件至共用位置**，兩頁共用：

| 元件 | 現況 | 動作 |
|------|------|------|
| `TopupStatusTag` | 已共用 `@/components/topups/status-tag`（[`10 §5.3`](./10-screen-topup-list.md)） | 直接重用 |
| `labels.ts`（支付方式 / 狀態中文） | `@/lib/topups/labels.ts` | 直接重用 |
| `DateRangePicker` / `MultiSelect` / `SortSelect` | 已實作於 spec 10 `_components` | **提升**至 `@/components/topups/`（與玩家無關）後兩頁共用 |
| `Pagination`（OFFSET page+1，filter-preserving） | 已實作；現寫死路徑（`pagination.tsx:35` `/players/${playerId}/topups` + import topups `serializeListQuery`） | **提升**至 `@/components/topups/`，並把「下一頁連結建構」抽成 prop（見下） |
| `_lib/query-params.ts`（`parseListQuery`/`serializeListQuery`/`TopupListQuery`） | 已實作於 spec 10 `_lib` | **提升**至 `@/lib/topups/query-params.ts`，型別**擴一個可選 `playerId`**（見 B7.2），兩頁共用同一套解析 |
| `ExportButton`（client，角色顯隱，吃 `records`） | 已實作於 spec 10 `players/[playerId]/topups/_components/export-button.tsx`；與玩家無關 | **提升**至 `@/components/topups/export-button.tsx`，新增可選 `includePlayerId` prop（預設 `false`＝spec 10 行為不變；本頁傳 `true`）。提升後 spec 10 import 路徑同步更新（該重構 PR 範圍） |
| `toDepositCsv`（`@/lib/topups/export-csv.ts`，純函式） | 已實作；固定七欄 | **參數化**：`toDepositCsv(records, { includePlayerId }?)`；`includePlayerId` 時於「玩家」欄後插入「玩家 ID」(`playerId`)。spec 10 不傳 → 輸出不變 |
| `FilterBar` / `ResultTable` / `ResultRow` | 含頁面專屬欄位（玩家欄聚焦） | **不共用**，各頁自有（差異見 B4 / B5） |

**Pagination 提升介面**（避免寫死路徑；以 **serializable** props 參數化）：

```ts
// @/components/topups/pagination.tsx（提升後）
type PaginationProps = {
  basePath: string;            // 各頁注入：'/players/{id}/topups' 或 '/deposit-records'
  query: DepositListQuery;     // 現有篩選（本頁含 playerId）；client 端組下一頁
  page: number; pageSize: number; total: number;
};
// client 內部（頁碼導航）：router.push(`${basePath}${serializeListQuery({ ...query, page: N })}`)
```

> **為何不用 `hrefForPage: (page) => string` 函式 prop**：`Pagination` 是 Client Component，而呼叫端 `page.tsx` 是 Server Component——**函式無法跨 Server→Client 邊界傳遞**（RSC 限制，會 throw）。故改傳 serializable 的 `basePath` + `query`，序列化邏輯（`serializeListQuery`）留在 client 元件內。

- spec 10 端：`<Pagination basePath={`/players/${playerId}/topups`} query={query} … />`
- 本頁端：`<Pagination basePath="/deposit-records" query={query} … />`（`query` 含 `playerId`）
- 渲染條件不變（`page * pageSize < total` 才顯示）。

> 提升屬小型重構，須在既有 spec 10 測試保護下進行（行為等價、Red 不變）。本規格採「直接提升」而非「先複製後收斂」，以免兩套發散。提升後 spec 10 的對應 import 路徑同步更新（屬該重構 PR 範圍）。

## B2. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `page.tsx` | Server | 解析 searchParams、呼叫 `listDeposits`、render |
| `FilterBar` | Client | 受控表單；含子 Client 元件 |
| `ActivePlayerChip` | Client | 顯示目前聚焦玩家 + 清除（`router.push` 去除 `playerId`）；**無搜尋**，純 server-first |
| `DateRangePicker` / `MultiSelect` / `SortSelect` | Client | 互動 + state（共用） |
| `ResultTable` | Server | 純展示 |
| `ResultRow` | Client | 鍵盤導覽、`router.push` 至明細 |
| `ExportButton` | Client | 角色顯隱（`useSession`）、client 端產 CSV blob 下載（共用，`includePlayerId` 參數化） |
| `Pagination` | Client | OFFSET 頁碼導航（共用，`basePath` 參數化） |
| `EmptyState` / `ErrorState` | Server | 純文案 |

> **Next.js 16**：`page.tsx` 的 `searchParams` 為 `Promise`，頂端 `await` 取出。async Server Component 的資料分支抽為內層 async 元件 `DepositsResult` 並 export，供測試 `await` 後 render（RTL 無法解析巢狀 RSC，同 [`10 §12.8`](./10-screen-topup-list.md)）。

## B3. 導覽入口（CmsShell）

於 `src/app/(cms)/_components/cms-shell.tsx` 主導覽新增一項（現有僅「玩家搜尋」）：

```
玩家搜尋   →  /players
儲值紀錄   →  /deposit-records      ← 新增
```

- 連結文案「儲值紀錄」；放在「玩家搜尋」之後。
- 不依角色顯隱（admin/user/viewer 皆可讀）。

## B4. 篩選列（`FilterBar`）+ 玩家聚焦（`ActivePlayerChip`）

> **設計原則：server-first，玩家聚焦不靠 client 即時搜尋。** 玩家欄位**不是**輸入框 / typeahead——本系統除 `/api/login` 外不做 client fetch（[`08`](./08-screen-player-search.md) 搜尋表單亦只 `router.push` 重新 SSR），且 deposit-records 後端**只能用 `player_id`(uuid) 篩選、無法用名字**。因此「依玩家聚焦」由 **URL `?playerId=` + 列內玩家連結**（B5.2）達成，FilterBar 本身**不含玩家欄**。

### B4.1 篩選列欄位（與 spec 10 一致）

```
┌──────────────────────────────────────────────────────────────────┐
│  [日期區間 ▼] [狀態 (多選) ▼] [支付方式 (多選) ▼] [排序 ▼]      │
│                                          [清除] [套用]            │
└──────────────────────────────────────────────────────────────────┘
```

欄位與行為**完全沿用** [`10 §4.1–§4.4`](./10-screen-topup-list.md)（`DateRangePicker` / `MultiSelect` ×2 / `SortSelect`；變更暫存、按「套用」才 `router.push('/deposit-records?<query>')`、「清除」→ `router.push('/deposit-records')`；日期單邊允許、`endDate >= startDate` client 驗證失敗 disable「套用」；多值重複 key；時間顯示走 `lib/format/datetime.ts` `Asia/Taipei`）。

| 欄位 | 元件 | URL param | 後端 query | 預設 |
|------|------|-----------|-----------|------|
| 日期區間 | `DateRangePicker` | `startDate`/`endDate` | `start_date`/`end_date` | 不帶 |
| 狀態 | `MultiSelect` | `status`（重複 key） | `status`（OR） | 不帶 |
| 支付方式 | `MultiSelect` | `paymentMethod`（重複 key） | `payment_method`（OR） | 不帶 |
| 排序 | `SortSelect` | `sort` | `sort` | `-created_at`（不寫 URL） |

> 「清除」只清 FilterBar 的篩選，**保留** `playerId`（聚焦不被篩選清除沖掉）：`router.push('/deposit-records' + (playerId ? '?playerId=' + playerId : ''))`。玩家聚焦的清除由 `ActivePlayerChip` 負責。

### B4.2 玩家聚焦（`ActivePlayerChip`，server-first）

- **無聚焦時**（URL 無 `playerId`）：不渲染；列表為全玩家。
- **有聚焦時**（URL 帶 `?playerId=`，通常來自 B5.2 列內玩家連結，或外部連入）：在篩選列上方渲染 chip：

  ```
  目前聚焦玩家：玩家小王  ✕      ← ✕ → router.push 去除 playerId（保留其他篩選）
  ```

- **名稱來源（免新端點）**：`page.tsx` 把目前 `playerId` 對應的 `playerName` 傳入——優先取本頁結果中任一筆 `records.find(r => r.playerId === playerId)?.playerName`（每列都帶 `playerName`）；若結果為空（該玩家本區間無紀錄）則退顯示 `playerId` 片段。**不**呼叫玩家詳情端點（後端目前無，見 [`10 §13`](./10-screen-topup-list.md)）。
- 清除 ✕：`router.push` 去除 `playerId`、保留其餘篩選（回到全玩家、同條件）。
- **後端僅支援單一 `player_id`**，故僅單玩家聚焦（不做多玩家 OR）。

## B5. 列表（`ResultTable` + `ResultRow`）

### B5.1 欄位

在 [`10 §5.1`](./10-screen-topup-list.md) 基礎上，**「玩家」與「玩家 ID」為主要新增**（跨玩家頁需同時可讀名稱與唯一識別碼；玩家名稱可能重複，UUID 才唯一）。**名稱與 UUID 拆成兩獨立欄位**：

| 欄位 | 來源 | 顯示 |
|------|------|------|
| 建立時間 | `createdAt` | `MM-DD HH:mm`（本年）/ `YYYY-MM-DD HH:mm`（跨年） |
| **玩家** | `playerName` | 暱稱快照；過長截斷 + tooltip；**可點擊聚焦**（見 B5.2） |
| **玩家 ID** | `playerId` | 後端 `members` UUID；等寬字、過長截斷 + tooltip（hover 看完整）；獨立欄位，與名稱分開 |
| 參考號 | `referenceNo` | `null` → `—`；截斷 + tooltip |
| 金額 | `amount` + `currency` | `Intl.NumberFormat` 依幣別最小單位；右對齊 |
| 支付方式 | `paymentMethod` | 中文 label（`labels.ts`） |
| 狀態 | `status` | `TopupStatusTag`（[`10 §5.3`](./10-screen-topup-list.md)） |
| 操作 | — | `<a href="/players/[playerId]/topups/[id]">明細</a>` |

### B5.2 互動

- **整列可點**進該紀錄明細：`/players/${playerId}/topups/${id}`（沿用 spec 11）。
- 「玩家」欄是**玩家聚焦的主要入口**（取代 typeahead）：點玩家名 → 在當前列表**聚焦該玩家**並**保留現有篩選**：`router.push('/deposit-records' + serializeListQuery({ ...currentQuery, playerId, page: 1 }))`（聚焦改變結果集，`page` 重置為 1）。
  - 為避免與「整列導明細」衝突：玩家欄內以明確的 `<a>`／按鈕承載聚焦動作並 `stopPropagation`；列其餘區域維持導明細。聚焦後由 `ActivePlayerChip`（B4.2）顯示目前玩家 + 清除。
- 操作欄「明細」連結為 redundancy（鍵盤可達）。

### B5.3 狀態 tag

完全沿用 [`10 §5.3`](./10-screen-topup-list.md)（`TopupStatusTag`；`pending` 黃 + 時鐘、`completed` 綠、`failed`/`refunded` 紅、`cancelled` 灰）。

### B5.4 匯出 CSV 按鈕（`ExportButton`，共用）

對齊 A4.1。`page.tsx`（`DepositsResult`）在**有結果時**於結果區右上渲染共用 `ExportButton`：

```tsx
{records.length === 0 ? (
  <EmptyState />
) : (
  <div className="space-y-2">
    <div className="flex justify-end">
      <ExportButton records={records} includePlayerId />
    </div>
    <ResultTable records={records} query={query} />
    <Pagination basePath="/deposit-records" query={query} … />
  </div>
)}
```

- `records` 為**當前頁**資料（A4.1：僅當前頁）；按鈕內部 `toDepositCsv(records, { includePlayerId: true })`。
- 角色顯隱由 `ExportButton` 內部 `useSession()` 處理（`viewer` 回 `null`）；本頁不再二次判斷。
- Empty 態（`records.length === 0`）不渲染按鈕（無資料可匯出）。
- 與 spec 10 的唯一差異：本頁傳 `includePlayerId`（CSV 多一欄「玩家 ID」）。

## B6. 分頁（`Pagination`，OFFSET）

沿用 [`10 §6`](./10-screen-topup-list.md)：**頁碼導航**（`1 2 3 … N`，上一頁 / 下一頁 + 省略號）。總頁數 `Math.ceil(total / pageSize)`，`<= 1` 不渲染；點頁碼 → `router.push` 帶 `page=N`（其餘篩選含 `playerId` 不變，`page === 1` 省略參數）。共用元件以 `basePath="/deposit-records"` 參數化。

## B7. URL 與篩選同步

### B7.1 Query params

對應 B4.1；camelCase、多值重複 key、序列化轉 snake_case（同 [`10 §9.1`](./10-screen-topup-list.md)），**新增 `playerId`**：

```
/deposit-records?playerId=01HABCD&startDate=2026-06-01&status=pending&status=failed&paymentMethod=credit_card&sort=-amount&page=1
```

對應後端：

```
GET /api/cms/deposit-records?player_id=01HABCD&start_date=2026-06-01&status=pending&status=failed&payment_method=credit_card&sort=-amount&page=1&page_size=20
```

### B7.2 解析（重用並提升 spec 10 的 `query-params`）

**不另開平行型別**。提升 spec 10 既有 `_lib/query-params.ts` 至 `@/lib/topups/query-params.ts`，將 `TopupListQuery` **擴一個可選 `playerId`**（spec 10 因 `playerId` 在路由故原本無此欄；新增為可選，對 spec 10 行為無影響）：

```ts
export type TopupListQuery = {
  playerId?:      string           // ← 新增（可選）；spec 10 不帶、本頁帶
  startDate?:     string
  endDate?:       string
  status?:        DepositStatus[]
  paymentMethod?: string[]
  sort?:          DepositSort
  page?:          number
  pageSize?:      number
}

export function parseListQuery(params: URLSearchParams | ReadonlyURLSearchParams): TopupListQuery
export function serializeListQuery(query: TopupListQuery): string
```

- `parseListQuery` 以 `getAll` 取多值；解析失敗欄位 fall back 預設（不 throw）。**新增**：`playerId` 直接 `params.get('playerId')`。
- `serializeListQuery` 新增 `playerId` 的輸出（非空才寫）；spec 10 未帶時不影響其序列化結果。
- 映射至 `listDeposits` 的 `DepositListQuery`：欄位同名直通（`playerId` 省略 → 全玩家）。

> 兩頁共用同一 `parseListQuery`/`serializeListQuery`，避免「兩套解析各自演進」。提升後 spec 10 的 import 路徑同步更新（屬該重構 PR 範圍）。

## B8. 鍵盤與無障礙

沿用 [`10 §10`](./10-screen-topup-list.md)，新增：

| 項目 | 要求 |
|------|------|
| `ActivePlayerChip` | chip 含可聚焦的清除按鈕：`<button aria-label="清除玩家聚焦">`；chip 文字非單靠視覺 |
| 玩家欄聚焦連結 | 以 `<a>`／`<button>` 承載（鍵盤可達）；與整列導明細不衝突（`stopPropagation`）；明確 `aria-label`（如「聚焦玩家小王」） |

## B9. 狀態（Loading / Empty / Error）

| 狀態 | 觸發 | UI |
|------|------|----|
| Loading | route transition | `loading.tsx`：skeleton 篩選列 + skeleton 表格列 |
| Has results | `records.length > 0` | `ResultTable` |
| Empty | `records.length === 0` | `EmptyState`：「無符合條件的儲值紀錄」+「清除篩選」 |
| 403 / 429 / 5xx / 400 | 見 A5 | 對應 `ErrorState` / `error.tsx` |

---

## B10. 測試清單（TDD）

> 命名以本 spec 為準（[CLAUDE.md SDD/TDD](../../CLAUDE.md)）。共用元件（DateRangePicker / MultiSelect / SortSelect / Pagination / StatusTag）的測試沿用 spec 10，提升時行為等價、不重寫。

### B10.1 `@/lib/topups/query-params.test.ts`（提升後的共用模組，新增 `playerId` 案例）

> 提升前 spec 10 既有測試全數保留並維持綠燈；以下為**本次新增**的 `playerId` 覆蓋。

```ts
it('should parse playerId via params.get')
it('should leave playerId undefined when absent (all-players)')
it('serializeListQuery should emit playerId when present')
it('serializeListQuery should omit playerId when undefined (spec 10 output unchanged)')
it('should still parse status / paymentMethod as arrays via getAll (regression)')
```

### B10.2 `_components/active-player-chip.test.tsx`

```ts
it('should NOT render when no playerId is focused')
it('should render the focused playerName when provided')
it('should fall back to a playerId fragment when playerName is unavailable (empty results)')
it('should router.push without playerId (preserving other filters) when clear is clicked')
it('should expose an accessible clear button (aria-label)')
```

### B10.3 `_components/filter-bar.test.tsx`

```ts
it('should hydrate all sub-controls (incl. playerId) from URL search params')
it('should NOT call router.push when fields change before Apply')
it('should call router.push("/deposit-records?<query>") with playerId + repeated keys on Apply')
it('should call router.push("/deposit-records") on Clear')
it('should disable Apply when date-range inline validation fails')
```

### B10.4 `_components/result-row.test.tsx`

```ts
it('should render the player column with playerName')
it('should render the player ID (UUID) in its own column')
it('should navigate to /players/[playerId]/topups/[id] when the row is clicked')
it('should focus the player (push ?playerId=, preserving other filters, page reset to 1) when the player link is clicked, without navigating to detail')
it('should render "—" when referenceNo is null')
it('should right-align amount and format with per-currency minor unit (TWD=0 decimals)')
it('should render status tag with correct variant per status (completed, not success)')
it('should be focusable and navigate on Enter')
```

### B10.5 `_components/result-table.test.tsx`

```ts
it('should render a column header "玩家"')
it('should render a separate column header "玩家 ID"')
it('should render one ResultRow per record')
it('should mark sorted column with aria-sort')
```

### B10.6 `@/lib/topups/export-csv.test.ts`（提升後的共用模組，新增 `includePlayerId` 案例）

> 既有七欄案例全數保留並維持綠燈（spec 10 行為不變）；以下為**本次新增**的 `includePlayerId` 覆蓋。

```ts
it('should insert a "玩家 ID" header column after "玩家" when includePlayerId is true')
it('should output the playerId (UUID) value in the player-ID column')
it('should keep the spec-10 seven-column output unchanged when includePlayerId is omitted/false')
```

### B10.7 `@/components/topups/export-button.test.tsx`（提升後，新增 `includePlayerId` 案例）

> 既有角色顯隱（viewer 隱藏 / user / admin）與 blob 下載案例全數保留。

```ts
it('should pass includePlayerId through to toDepositCsv when set (CSV contains the 玩家 ID column)')
```

### B10.8 `page.test.tsx`（整合）

```ts
it('should call listDeposits with parsed query (NO playerId → all players) on initial render')
it('should call listDeposits with playerId when URL has ?playerId=')
it('should render ResultTable when data.length > 0')
it('should render no-results EmptyState when data is empty array')
it('should pass meta {page, pageSize, total} to Pagination')
it('should render an ExportButton (匯出 CSV) when data.length > 0')
it('should NOT render an ExportButton when data is empty')
it('should render forbidden ErrorState on 403')
it('should render rate-limited ErrorState on 429 with Retry-After')
it('should emit deposits.list.result_count metric on render')
it('should emit deposits.list.player_focus metric when playerId is present')
```

### B10.7 E2E（Playwright）

```ts
test('default view lists records across multiple players (player column varies)')
test('filter by status=pending (repeated keys) returns only pending; URL reflects state')
test('clicking a player link in a row focuses that player (?playerId=) and shows ActivePlayerChip')
test('clearing ActivePlayerChip returns to all-players while preserving other filters')
test('clicking a row navigates to /players/[playerId]/topups/[recordId]')
test('clicking page 2 advances results and reflects page=2 in the URL')
test('Clear resets URL to /deposit-records and shows default results')
test('reload preserves filter state via URL (incl. playerId)')
test('nav "儲值紀錄" entry routes to /deposit-records')
test('admin sees 匯出 CSV and clicking it downloads a CSV containing the 玩家 ID column')
test('viewer does NOT see the 匯出 CSV button')
```

---

## B11. 開放問題（UI）

- [ ] 站內玩家搜尋下拉 = v1.1（見 A7）；屆時評估「最近查詢過的玩家」快取與輸入防抖。
- [ ] 列表「玩家」欄的次級聚焦動作 vs 整列導明細，是否造成誤點？v1 以 `stopPropagation` + 明確連結區分；上線後觀察。
- [ ] 是否在頁首顯示目前篩選摘要（active filter chips 總覽）？v1 由各欄位自身 chip 呈現。
- [ ] 共用元件提升的落點：`@/components/topups/`（建議）vs `@/app/(cms)/_components/`？依現有 `@/components/topups/status-tag` 慣例選前者。
```
