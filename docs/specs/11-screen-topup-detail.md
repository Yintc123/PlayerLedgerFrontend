# 單筆儲值明細頁規格書

## 1. 概覽

CMS 後台「單筆儲值明細頁」——從 [`10`](./10-screen-topup-list.md) 列表頁或 [`09`](./09-screen-player-detail.md) 詳情頁的最近紀錄進入，顯示一筆儲值交易的完整資訊、狀態時間軸與相關連結。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 三個主要區塊：交易資訊卡、狀態時間軸、相關連結
- 狀態（loading / not-found / forbidden / 5xx）
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- 業務邏輯與 API 契約——見 [`06-topup-records-domain.md`](./06-topup-records-domain.md)
- 列表頁——見 [`10-screen-topup-list.md`](./10-screen-topup-list.md)
- 退款／補單等動作（v1 純查詢）

### 核心原則

- **Server-first**：純展示頁，無 client-side fetch；首屏 SSR 即完成
- **資料驅動**：欄位 `null` 不渲染或顯示 `—`；不依角色判斷
- **時間軸即狀態歷史**：後端模型僅有 `createdAt` + `updatedAt` + `status`（無付款／退款時間戳），時間軸以「建立 → 目前狀態」兩節點視覺化，非互動元件

---

## 2. 路由與檔案結構

### 2.1 路由

```
/players/[playerId]/topups/[recordId]
```

URL 同時含 `playerId` 與 `recordId`（前端路由慣例；保留 `playerId` 以利 breadcrumb 與返回列表）：

- **後端端點為扁平資源** `GET /api/cms/deposit-records/{id}`（[`06 §6`](./06-topup-records-domain.md)），**僅需 `recordId`（= record `id`）**，不需 `playerId`
- 前端從 URL 取 `recordId` 呼叫 `getDeposit(recordId)`；`playerId` 僅供前端導覽，不傳給後端
- record 不存在 → 後端回 404 `resource not found`

### 2.2 檔案結構

```
src/app/(cms)/players/[playerId]/topups/[recordId]/
├── page.tsx                       # 明細頁（Server Component）
├── page.test.tsx
├── not-found.tsx
├── error.tsx
└── _components/
    ├── transaction-card.tsx       # 交易資訊卡（Server）
    ├── transaction-card.test.tsx
    ├── status-timeline.tsx        # 狀態時間軸（Server）
    ├── status-timeline.test.tsx
    ├── related-links.tsx          # 相關連結區（Server）
    ├── related-links.test.tsx
    ├── status-badge.tsx           # 大型狀態徽章（Server）
    ├── status-badge.test.tsx
    └── forbidden-state.tsx
```

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `page.tsx` | Server | 呼叫 `getDeposit`、render |
| `TransactionCard` | Server | 純展示 |
| `StatusTimeline` | Server | 純展示，靜態時間軸 |
| `RelatedLinks` | Server | 連結為 `<a>`，不需 client |
| `StatusBadge` | Server | 純樣式 |
| `CopyButton`（recordId / referenceNo） | Client | 與 [`09 §4.2`](./09-screen-player-detail.md) 共用；目前各自實作，第三處出現時抽 |

> **狀態元件分工**：大型徽章 `StatusBadge` 維持本頁專用實作（見 §4.2）；小型行內狀態 tag 則用共用的 `@/components/topups/status-tag`（`TopupStatusTag`，與螢幕 10 共用）。

> **Next.js 16 備註**：`page.tsx` 的 `params` 為 `Promise`，於頂端 `await` 取出（`{ params }: { params: Promise<{ playerId: string; recordId: string }> }` → `const { playerId, recordId } = await params`）；後端查詢僅用 `recordId`。

---

## 4. 頁面組成

### 4.1 整體 layout

```
┌────────────────────────────────────────────────────────────────────┐
│  Breadcrumb: 玩家 / [playerName] / 儲值紀錄 / [recordId 縮短]     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐    │
│  │   StatusBadge（大）          │  │  StatusTimeline          │    │
│  │   ✅ completed               │  │   ● 建立    2026-06-20.. │    │
│  │   amount + currency 主標     │  │   │                      │    │
│  │   (右對齊大金額)             │  │   ● 目前狀態 completed   │    │
│  └──────────────────────────────┘  │     @ 2026-06-20 ...     │    │
│                                    │  （updatedAt）           │    │
│  ┌──────────────────────────────┐  └──────────────────────────┘    │
│  │  TransactionCard             │                                  │
│  │  - id（+ copy）              │  ┌──────────────────────────┐    │
│  │  - playerId（+ 連結 09）     │  │  RelatedLinks            │    │
│  │    + playerName              │  │  - 玩家詳情              │    │
│  │  - referenceNo（+ copy）     │  │  - 玩家儲值列表           │    │
│  │  - paymentMethod (label)     │  └──────────────────────────┘    │
│  │  - internalNote / displayNote│                                  │
│  │  - operatorId / operatorIp   │                                  │
│  │  - createdAt / updatedAt     │                                  │
│  └──────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
```

- 桌機：左側 StatusBadge + TransactionCard 直排，右側時間軸 + RelatedLinks 直排，兩欄並排（≥ 1024px）
- 行動裝置：全直排
- **Breadcrumb 顯示 `playerName`**：後端 `DepositRecord` 已含 `playerName`（建立當下快照，server 填入），故 breadcrumb 第二段直接顯示 `playerName`，末段顯示縮短後的 `recordId`——**取代**先前「僅能顯示 playerId」的限制（先前 `TopupRecord` 不含玩家名稱，現已修正）

### 4.2 StatusBadge

| status | 視覺 | 副標 |
|--------|------|------|
| pending | 黃，時鐘圖示 | 「等待確認入帳」 |
| completed | 綠，勾號 | 「入帳完成」 |
| failed | 紅，警示 | 「入帳失敗」（後端模型無 `failureReason`，不顯示細節原因） |
| cancelled | 灰 | 「已取消」 |
| refunded | 紅，回旋圖示 | 「已退款」 |

**金額顯示**：

- 主標為 `amount` 換算為主貨幣單位後格式化（`Intl.NumberFormat` 含 currency 符號）
- 大字級（如 `text-4xl`），視覺重點
- `refunded` 狀態下加刪除線並另起一行顯示「退款 −金額」

### 4.3 TransactionCard

| 欄位 | 顯示規則 |
|------|---------|
| id | 等寬字型；右側 CopyButton |
| playerId | `<a href="/players/[playerId]">` 連到玩家詳情；同列顯示 `playerName` |
| playerName | 與 playerId 同列顯示（快照） |
| referenceNo | `null` → 隱藏整列；其餘等寬字型 + CopyButton |
| paymentMethod | 中文 label（`lib/topups/labels.ts`） |
| internalNote | `null` → 隱藏整列；多行文字（staff 內部備註）|
| displayNote | `null` → 隱藏整列；對玩家顯示的說明 |
| operatorId | `null` → 隱藏整列；建立此筆的 CMS staff（等寬字型）|
| operatorIp | `null` → 隱藏整列；操作者 IP |
| createdAt | 使用者時區 `YYYY-MM-DD HH:mm:ss` |
| updatedAt | 使用者時區 `YYYY-MM-DD HH:mm:ss`；最後異動時間 |

> 後端 `DepositRecord` **不含** `orderId` / `paymentChannel` / `failureReason` / `paidAt` / `refundedAt`，相關列已移除。

**為何 `null` 列隱藏而非顯示 `—`**：

- 此頁是「完整明細」，與列表頁的「對齊欄位」需求不同
- 隱藏可避免「為什麼這個欄位是空」的疑惑

### 4.4 StatusTimeline

後端模型只有 `createdAt` + `updatedAt` + `status`（無付款／退款等中間時間戳），故時間軸為**兩節點**：

```
● 建立        2026-06-20 03:11:22  ← createdAt（永遠實心 + 主色）
│
● 目前狀態     completed             ← status
              @ 2026-06-20 03:12:00  ← updatedAt
```

- 「建立」節點：永遠實心 + 主色，時間為 `createdAt`
- 「目前狀態」節點：顯示 `status`（中文 label）+ `updatedAt`；顏色依狀態（completed 綠 / failed・refunded 紅 / cancelled 灰 / pending 黃）
- `pending` 時 `updatedAt` 可能等於 `createdAt`（尚未異動）——仍顯示「目前狀態：等待確認入帳」
- 時間軸不需互動，純展示；**不再**推斷付款／退款等不存在的時間點

### 4.5 RelatedLinks

| 連結 | URL | 條件 |
|------|-----|------|
| 玩家詳情 | `/players/[playerId]` | 永遠顯示 |
| 玩家儲值列表 | `/players/[playerId]/topups` | 永遠顯示 |
| 對帳參考號查詢（v2） | — | 暫不實作；後端模型無 `orderId`，僅有 `referenceNo`（金流商外部交易號），未來如需以 referenceNo 反查由後端決定 |

---

## 5. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Loading** | route transition | skeleton 卡片 + skeleton 時間軸 |
| **Has data** | `getDeposit` 成功 | §4 layout |
| **404 not-found** | `getDeposit` 拋 404 | Next.js `not-found.tsx`：「找不到此筆紀錄」+「回儲值列表」CTA（連到 `/players`，因 `not-found.tsx` 取不到 route params 無法拼出 `playerId`） |
| **403 forbidden** | `getDeposit` 拋 403（非 CMS staff） | `ForbiddenState`：「您的角色無權查看此筆紀錄」 |
| **5xx** | upstream 失敗 | Next.js `error.tsx`：通用錯誤 + 重試 |

> **無「rate-limited」整頁狀態**：明細頁是輕量讀取（單筆），被限流的可能性低於列表頁；若仍 429 → 走 `error.tsx`，無需特別 UI

---

## 6. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| Breadcrumb | `<nav aria-label="breadcrumb">`；最後一段為當前頁（無連結） |
| 主標金額 | `<h1>`；螢幕閱讀器讀「金額 New Taiwan Dollar 199」 |
| StatusBadge | `<div role="status">`；副標可被讀 |
| TransactionCard | `<dl>` + `<dt>` / `<dd>`（描述列表語意） |
| 複製按鈕 | `<button aria-label="複製參考號">`；複製後 `aria-live="polite"` 宣告 |
| StatusTimeline | `<ol>`（時間順序）；每步 `<li>`；「目前狀態」節點標 `aria-current` |
| RelatedLinks | `<nav aria-label="related links">` |
| 對比度 | 所有狀態色 ≥ 4.5:1；不單靠顏色 |

---

## 7. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | layout 已處理 redirect |
| [`03-observability.md`](./03-observability.md) | metric：`topups.detail.viewed`、`topups.detail.error{code}` |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源：`getDeposit(recordId)`（扁平資源 `GET /api/cms/deposit-records/{id}`） |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 讀取限 CMS staff（全角色可 GET）；本頁不檢查角色 |
| [`09-screen-player-detail.md`](./09-screen-player-detail.md) | 上游入口（RecentTopups 列點擊） + 下游 RelatedLinks |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 上游入口（列表列點擊） |

---

## 8. 測試清單（TDD）

### 8.1 `_components/status-badge.test.tsx`

```ts
it('should render pending variant with clock icon and "等待確認入帳" subtitle')
it('should render completed variant with check icon and "入帳完成"')
it('should render failed variant with warning icon and "入帳失敗" subtitle')
it('should render cancelled variant with neutral color and "已取消"')
it('should render refunded variant with refund icon and "已退款"')
it('should render amount with Intl.NumberFormat using currency-specific minor unit (TWD=0 decimals)')
it('should add strikethrough on amount when status is refunded')
it('should render "-amount" refund line when status is refunded')
```

### 8.2 `_components/transaction-card.test.tsx`

```ts
// 顯示
it('should render id in monospace with Copy button')
it('should render playerId as link to /players/[playerId] and show playerName')
it('should hide referenceNo row when value is null')
it('should render referenceNo in monospace with Copy button when not null')
it('should render paymentMethod with chinese label from labels.ts')
it('should hide internalNote row when value is null')
it('should hide displayNote row when value is null')
it('should hide operatorId / operatorIp rows when value is null')
it('should render createdAt in user timezone with seconds precision')
it('should render updatedAt in user timezone with seconds precision')

// 語意
it('should use <dl><dt><dd> structure for field list')
```

### 8.3 `_components/status-timeline.test.tsx`

```ts
it('should render two steps: 建立 / 目前狀態')
it('should render filled marker for 建立 step with createdAt (always present)')
it('should render 目前狀態 step with status label and updatedAt')
it('should color the 目前狀態 marker per status (completed green / failed・refunded red / cancelled grey / pending yellow)')
it('should use <ol> + <li> structure with aria-current on the 目前狀態 step')
```

### 8.4 `_components/related-links.test.tsx`

```ts
it('should render link to /players/[playerId]')
it('should render link to /players/[playerId]/topups')
it('should expose role="navigation" with aria-label="related links"')
```

### 8.5 `page.test.tsx`（整合）

```ts
// 主流程
it('should call getDeposit(recordId) with the URL recordId (no playerId sent to backend)')
it('should render TransactionCard / StatusTimeline / StatusBadge / RelatedLinks on success')
it('should render breadcrumb second segment with playerName')
it('should call notFound() when getDeposit throws 404')
it('should render ForbiddenState when getDeposit throws 403')
it('should bubble 5xx to error.tsx')

// metric
it('should emit topups.detail.viewed metric on successful render')
```

### 8.6 E2E（Playwright）

```ts
test('clicking a row on topup list navigates to detail and shows correct data')
test('clicking a row in RecentTopups (player detail) navigates to detail')
test('breadcrumb player link navigates back to player detail')
test('breadcrumb topups link navigates back to topup list')
test('forbidden role sees ForbiddenState on /players/[id]/topups/[recordId]')
test('navigating to /players/[id]/topups/<bogus-record> shows not-found page')
```

---

## 9. 開放問題

- [ ] StatusTimeline 僅有兩節點（建立 + 目前狀態）：若業務需要完整狀態變更歷史（含中間時間戳），需後端提供 audit / 狀態歷史端點並更新 [`06 §2.1`](./06-topup-records-domain.md)
- [ ] 是否需要「複製整筆 JSON」按鈕（便於客服回報問題）？需評估資安（含 internalNote / operatorIp 等敏感欄位）；v1 不做
- [ ] 退款金額（部分退款 vs 全額退款）後端目前**不區分**（僅 `completed → refunded` 單一轉換，無退款金額欄位）；§4.2 退款顯示以全額處理
- [ ] Breadcrumb 顯示 `playerName`（已解決）：後端 `DepositRecord` 已含 `playerName` 快照，無需另抓玩家資料；先前「僅能顯示 playerId / 延後」的決議已不適用
