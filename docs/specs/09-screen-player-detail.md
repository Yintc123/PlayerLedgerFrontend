# 玩家詳情頁規格書

> **對齊後端（2026-06-30）**：本頁三個區塊的後端契約皆已定案。
> - 「基本資料卡」：`getPlayer` → `cmsRequest('/cms/players/{id}')`（[`05`](./05-player-query-domain.md) 已對齊）。
> - 「最近紀錄」：扁平 `GET /api/cms/deposit-records?player_id=<id>`（[`06`](./06-topup-records-domain.md)）。
> - **「儲值彙總卡」：後端已定案 `GET /api/cms/players/{id}/deposit-summary`**（[`06 §7`](./06-topup-records-domain.md)，
>   契約見後端 `players-deposit-summary-api.md`）。`getPlayerTopupSummary` 由 mock 改串真後端；
>   **後端 handler 實作排程中**，端點上線前該卡暫顯 mock / 載入失敗態（§5 部分失敗已涵蓋）。
> 注意 `last_active_at` 本期恆為 `null`、`status` 本期恆為 `active`，UI 須能處理。

## 1. 概覽

CMS 後台「玩家詳情頁」——從 [`08`](./08-screen-player-search.md) 玩家搜尋頁進入後，顯示單一玩家的基本資料、儲值彙總，並提供進入儲值紀錄列表（[`10`](./10-screen-topup-list.md)）的入口。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 三個主要區塊：基本資料卡、儲值彙總卡、最近紀錄區塊
- 狀態（loading / not-found / forbidden / server-error）
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- 玩家／儲值資料模型——見 [`05`](./05-player-query-domain.md)、[`06`](./06-topup-records-domain.md)
- 儲值紀錄列表——見 [`10`](./10-screen-topup-list.md)
- 角色與欄位可見性——見 [`07`](./07-admin-rbac-audit.md)

### 核心原則

- **Server-first 渲染**：頁面首屏完全 SSR；不出現「先空殼再 client fetch」的瀑布
- **兩個 API 並行**：玩家詳情與儲值彙總獨立並行（`Promise.all`）；任一失敗不阻塞另一個
- **資料驅動顯示**：遮罩 / `null` 由後端決定（[`07 §6`](./07-admin-rbac-audit.md)），UI 只依資料 render
- **入口而非詳情**：本頁不嘗試嵌入完整儲值列表；用「最近 5 筆」+「查看全部」連結引導到 [`10`](./10-screen-topup-list.md)

---

## 2. 路由與檔案結構

### 2.1 路由

```
/players/[playerId]                # 本規格
/players/[playerId]/topups         # → spec 10
/players/[playerId]/topups/[recordId]  # → spec 11
```

`playerId` 為 URL 唯一識別子；不接受 Email / 手機作為 path 參數（同 [`05 §2.1`](./05-player-query-domain.md)）。

### 2.2 檔案結構

```
src/app/(cms)/players/[playerId]/
├── page.tsx                       # 玩家詳情頁（Server Component）
├── page.test.tsx
├── not-found.tsx                  # 404 by notFound()
├── error.tsx                      # 5xx / 未預期錯誤（client component, Next.js 慣例）
└── _components/
    ├── profile-card.tsx           # 基本資料卡（Server）
    ├── profile-card.test.tsx
    ├── topup-summary-card.tsx     # 儲值彙總卡（Server）
    ├── topup-summary-card.test.tsx
    ├── recent-topups.tsx          # 最近紀錄區塊（Server）
    ├── recent-topups.test.tsx
    ├── error-block.tsx            # SummaryErrorBlock / RecentErrorBlock（Client；role="alert" + 重試 router.refresh()）
    ├── status-tag.tsx             # 玩家狀態 tag — re-export 共用元件，見 §3.2
    └── forbidden-state.tsx        # 403 整頁錯誤態（Server）
```

> **共用 component 放哪（已解決）**：`status-tag` 在 [`08`](./08-screen-player-search.md) 結果列也用到。原設計判斷為「過早抽象比重複更危險」——v1 各自實作，待出現第三處時再提升。現 08–11 四個畫面皆已實作，提升已完成：共同實作集中於 `src/components/players/status-tag.tsx`（`PlayerStatusTag`），本目錄的 `_components/status-tag.tsx` 僅 re-export 維持本 spec §2.2 檔案結構：`export { PlayerStatusTag as StatusTag } from '@/components/players/status-tag'`。

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `page.tsx` | Server | 並行呼叫 `getPlayer` / `getPlayerTopupSummary`；catch → notFound() / forbidden / error |
| `ProfileCard` | Server | 純展示，無互動 |
| `TopupSummaryCard` | Server | 純展示；金額格式化用 `Intl.NumberFormat`（server-safe） |
| `RecentTopups` | Server | 列表，但每列可點 → Client 子元件處理導頁 |
| `RecentTopupRow` | Client | 鍵盤導覽、`router.push`；位置 `_components/recent-topup-row.tsx` |
| `StatusTag` | Server | 純樣式 |
| `ForbiddenState` | Server | 純文案 |

---

## 4. 頁面組成

### 4.1 整體 layout

```
┌────────────────────────────────────────────────────────────────────┐
│  Breadcrumb: 玩家 / 詳情                                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────────────┐  ┌────────────────────────────────────┐  │
│  │  ProfileCard         │  │  TopupSummaryCard                  │  │
│  │  - displayName       │  │  - 多幣別分區                       │  │
│  │  - status tag        │  │    - 成功總額 / 筆數                │  │
│  │  - playerId          │  │    - 退款總額 / 退款率              │  │
│  │  - email / phone     │  │  - firstTopupAt / lastTopupAt       │  │
│  │  - registeredAt      │  │  - lifetimeDays                    │  │
│  │  - lastActiveAt      │  └────────────────────────────────────┘  │
│  └──────────────────────┘                                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  RecentTopups（最近 5 筆）           [ 查看全部紀錄 → ]     │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │ 2026-06-25 14:00  TWD 199  credit_card  ✅ completed  │  │  │
│  │  │ ...                                                    │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

- 桌機：ProfileCard / TopupSummaryCard 並排兩欄（≥ 1024px）；行動裝置：直排
- 區塊間距用統一 spacing token，不混用 `mt-4` / `mb-6` 等寫死值

### 4.2 ProfileCard

| 欄位 | 顯示 |
|------|------|
| `displayName` | 大標 |
| `status` | `StatusTag` 視覺化（active=綠 / frozen=橘 / closed=灰） |
| `playerId` | 等寬字型；右側「複製」按鈕（Client 子元件） |
| `externalId` | `null` → 隱藏整列 |
| `email` | `null` → `—`；遮罩值（`a***@example.com`）原樣 |
| `phone` | `null` → `—`；E.164 顯示為 `+886 912 345 678`（純展示分組） |
| `registeredAt` | 使用者時區 `YYYY-MM-DD HH:mm` |
| `lastActiveAt` | `null` → `—`；其餘同上 |

**複製 playerId 按鈕**：

- Client 子元件 `<CopyButton value={playerId} />`，用 `navigator.clipboard.writeText`
- 複製後顯示 1.5s 的「已複製」提示（`aria-live="polite"`）
- 不在 server render；按鈕本身一律存在（不依角色顯隱）

### 4.3 TopupSummaryCard

| 區塊 | 來源 | 顯示 |
|------|------|------|
| 多幣別總額 | `summary.totalsByCurrency[]` | 每幣別一個 sub-card：成功總額（`Intl.NumberFormat` 換算為主貨幣單位）、成功筆數、退款總額、退款率 (%) |
| 首末次儲值 | `firstTopupAt` / `lastTopupAt` | `null` → 「尚未儲值」 |
| 生命週期天數 | `lifetimeDays` | 「儲值生涯 N 天」 |
| 空狀態 | `totalsByCurrency.length === 0` | 「此玩家尚未有任何儲值紀錄」 + 隱藏退款率區塊 |

**退款率顯示**：

- `refundRate` 由後端回傳（金額比，[`06 §7.3`](./06-topup-records-domain.md)），前端不在 client 算除法
- 顯示為百分比（`(refundRate * 100).toFixed(2) + '%'`）；`refundRate === 0` 時顯示「0%」而非「—」
- `> 30%` 時 tag 用警示色（業務認定為異常）；門檻寫進 `_lib/thresholds.ts`，便於 PM 調整

### 4.4 RecentTopups

- 後端呼叫：與彙總共用？**不**——彙總端點不回明細列。本區塊額外呼叫 `listTopups(playerId, { limit: 5, sort: 'created_at_desc' })`
- 三個 API 呼叫（`getPlayer` / `getPlayerTopupSummary` / `listTopups(limit:5)`）並行
- 每列顯示：`createdAt`（簡短時間）/ `amount currency` / `paymentMethod` / `status` tag
- 點列 → `router.push('/players/[playerId]/topups/[recordId]')`
  - 實作：外層 `div role="listitem"`（`tabIndex 0`，click / Enter 觸發 `router.push`）包一個真實的 `<a href="/players/[playerId]/topups/[recordId]">`（`display:contents`），內層 anchor 的 click 被攔截以避免雙重導頁。同時滿足 §8.4（push 導頁）與 §8.3（每列渲染語意連結，漸進增強）。
- 「查看全部紀錄」連結 → `/players/[playerId]/topups`
- 空狀態：「最近無儲值紀錄」（與彙總空狀態語意可能重複，但兩區塊是獨立來源——彙總算成功＋退款累積，列表回最近 5 筆原始紀錄；理論一致但**不假設**）

> **為何 RecentTopups 不和列表頁 `ResultRow` 共用元件**：欄位數量、欄位排序、互動行為都不同（詳情頁不需排序、不需選取批次）。先各自實作，待 spec 10 完成後再評估 row component 抽取。

---

## 5. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Loading** | route transition / SSR 進行中 | Next.js `loading.tsx`：三個區塊 skeleton |
| **Has data**（正常） | 三個 API 全成功 | §4 layout |
| **Has data**（部分失敗） | 詳情 OK、彙總/最近紀錄失敗 | 詳情正常 + 失敗區塊內顯示「載入失敗 [重試]」（重試呼叫 `router.refresh()`） |
| **404 not-found** | `getPlayer` 拋 404 | Next.js `not-found.tsx`：「找不到此玩家」+「回搜尋頁」CTA |
| **403 forbidden** | `getPlayer` 拋 403 | `ForbiddenState`：「您的角色無權查看此玩家」（不另顯示玩家資訊） |
| **5xx server-error** | `getPlayer` 拋 5xx | Next.js `error.tsx`：通用錯誤 + 「重試」按鈕 |

### 5.1 部分失敗的設計理由

- 詳情頁的「主要資訊」是玩家基本資料；彙總與最近紀錄是**輔助**
- 彙總 API 失敗 → 詳情頁仍可顯示玩家是誰、客服仍能繼續回覆問題
- 用 `Promise.allSettled` 而非 `Promise.all`，個別處理每個 result

```tsx
// app/(cms)/players/[playerId]/page.tsx
export default async function Page({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params              // Next.js 16：params 為 Promise，需先 await
  const playerResult = await getPlayer(playerId)  // 主資料；失敗整頁錯
  // 上面拋出時，由 not-found.tsx / forbidden 處理 / error.tsx 接住

  const [summaryResult, recentResult] = await Promise.allSettled([
    getPlayerTopupSummary(playerId),
    listTopups(playerId, { limit: 5, sort: 'created_at_desc' }),
  ])

  return (
    <>
      <ProfileCard player={playerResult} />
      {summaryResult.status === 'fulfilled'
        ? <TopupSummaryCard summary={summaryResult.value} />
        : <SummaryErrorBlock />}
      {recentResult.status === 'fulfilled'
        ? <RecentTopups records={recentResult.value.records} />
        : <RecentErrorBlock />}
    </>
  )
}
```

### 5.2 為何詳情用 `not-found.tsx` 而非 ErrorState

`getPlayer` 拋 404 時呼叫 Next.js `notFound()` → 渲染 `not-found.tsx`：

- URL 仍為 `/players/<不存在 id>`，使用者重新整理仍見錯誤態（語意正確）
- HTTP status 為 404，SEO / log / metric 正確分類

---

## 6. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| Breadcrumb | `<nav aria-label="breadcrumb">` |
| 卡片標題 | `<h2>` 層級；不靠 font-size 偽標題 |
| 複製按鈕 | `<button aria-label="複製玩家 ID">`；複製後 `aria-live="polite"` 宣告「已複製」 |
| RecentTopups 列 | `role="listitem"`，可獲焦；Enter 導頁 |
| 「查看全部紀錄」 | `<a>` 而非 `<button>`——是導航非動作 |
| 狀態 tag | 文字 + 顏色（不只靠顏色傳達語意）；對比 ≥ 4.5:1 |
| 退款率警示 tag | 文字含「警示」字樣，不只用紅色 |
| 部分失敗區塊 | `role="alert"`，「重試」按鈕可獲焦 |

---

## 7. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | layout 已處理未登入 redirect |
| [`03-observability.md`](./03-observability.md) | metric：`players.detail.viewed`、`players.detail.error{code}` |
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 資料來源：`getPlayer` |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源：`getPlayerTopupSummary` / `listTopups(limit:5)` |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 遮罩欄位由後端處理；本頁不檢查角色顯隱欄位 |
| [`08-screen-player-search.md`](./08-screen-player-search.md) | 上游入口，breadcrumb 對接 |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 下游連結「查看全部紀錄」+ RecentTopupRow 導頁 |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | RecentTopupRow 點擊導頁 |

---

## 8. 測試清單（TDD）

### 8.1 `_components/profile-card.test.tsx`

```ts
it('should render displayName as primary heading')
it('should render status tag with active/frozen/closed visual variant')
it('should render playerId in monospace with Copy button')
it('should hide externalId row when value is null')
it('should render "—" when email is null')
it('should render "—" when phone is null')
it('should render masked email verbatim (a***@example.com)')
it('should render E.164 phone with grouping for display only (does not mutate value)')
it('should render registeredAt in user timezone format')
it('should render "—" when lastActiveAt is null')
```

### 8.2 `_components/topup-summary-card.test.tsx`

```ts
it('should render one sub-card per currency in totalsByCurrency')
it('should render empty-state copy when totalsByCurrency is empty array')
it('should format amount using Intl.NumberFormat with currency-specific minor unit')
it('should render refundRate as percentage (0.0523 → "5.23%")')
it('should render "0%" when refundRate is 0 (not "—")')
it('should render warning tag when refundRate > threshold (0.3)')
it('should render firstTopupAt / lastTopupAt in user timezone')
it('should render "尚未儲值" when firstTopupAt is null')
it('should render lifetimeDays as "儲值生涯 N 天" when not null')
```

### 8.3 `_components/recent-topups.test.tsx`

```ts
it('should render up to 5 rows')
it('should render empty-state copy when records array is empty')
it('should render "查看全部紀錄" link to /players/[playerId]/topups')
it('should render link to /players/[playerId]/topups/[recordId] for each row')
it('should expose role="list" on the container')
```

### 8.4 `_components/recent-topup-row.test.tsx`

```ts
it('should render createdAt, amount with currency, paymentMethod, status tag')
it('should navigate to /players/[playerId]/topups/[recordId] when clicked')
it('should navigate when Enter pressed with row focused')
it('should be focusable (tabIndex 0)')
```

### 8.5 `_components/copy-button.test.tsx`

```ts
it('should call navigator.clipboard.writeText with the given value when clicked')
it('should display "已複製" feedback for 1.5s after click')
it('should expose aria-label describing the action')
```

### 8.6 `page.test.tsx`（整合）

```ts
// 主資料分支
it('should call notFound() when getPlayer throws 404')
it('should render ForbiddenState when getPlayer throws 403')
it('should bubble 5xx errors to error.tsx (Next.js error boundary)')

// 部分失敗
it('should render summary error block when getPlayerTopupSummary fails')
it('should render recent error block when listTopups fails')
it('should still render ProfileCard when summary and recent both fail')
it('should call router.refresh when summary error retry button clicked')

// 並行性
it('should call getPlayer / getPlayerTopupSummary / listTopups concurrently (Promise.allSettled)')

// metric
it('should emit players.detail.viewed metric on successful render')
```

### 8.7 E2E（Playwright）

```ts
test('clicking a result row on /players navigates to /players/[playerId] and shows profile')
test('clicking "查看全部紀錄" navigates to /players/[playerId]/topups')
test('clicking a row in RecentTopups navigates to /players/[playerId]/topups/[recordId]')
test('forbidden role sees ForbiddenState on /players/[playerId]')
test('navigating to /players/<bogus-id> shows not-found page with Back-to-search CTA')
```

---

## 9. 開放問題

- [ ] 退款率警示門檻（30%）由誰維護？建議放 `_lib/thresholds.ts` 並標註「業務認定異常」；長期可放遠端 config
- [ ] RecentTopups 數量（5）是否由 PM 確認？太少看不出趨勢、太多和列表頁重複
- [ ] 玩家若為「closed」狀態，是否需在頁面上方加大警示橫幅？目前僅在 `StatusTag` 視覺化
- [ ] `lifetimeDays` 是否顯示精確值（如 `367 天`）或粗略（`1 年`）？影響 UX 細節
- [ ] 複製 playerId 是否需要稽核？v1 不需（純前端動作未經後端），未來若有合規要求再加 client-side beacon
