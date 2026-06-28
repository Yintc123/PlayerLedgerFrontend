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
- **時間軸即狀態歷史**：以建立 / 付款 / 退款時間點視覺化，非互動元件

---

## 2. 路由與檔案結構

### 2.1 路由

```
/players/[playerId]/topups/[recordId]
```

URL 同時含 `playerId` 與 `recordId`：

- 與後端端點對齊（[`06 §6`](./06-topup-records-domain.md)），路徑變數一致
- 後端權限可在 path 層級檢查，不依 query string
- recordId 若不屬於該 playerId，後端統一回 404（不洩漏存在性）

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
| `page.tsx` | Server | 呼叫 `getTopup`、render |
| `TransactionCard` | Server | 純展示 |
| `StatusTimeline` | Server | 純展示，靜態時間軸 |
| `RelatedLinks` | Server | 連結為 `<a>`，不需 client |
| `StatusBadge` | Server | 純樣式 |
| `CopyButton`（recordId / orderId） | Client | 與 [`09 §4.2`](./09-screen-player-detail.md) 共用；目前各自實作，第三處出現時抽 |

---

## 4. 頁面組成

### 4.1 整體 layout

```
┌────────────────────────────────────────────────────────────────────┐
│  Breadcrumb: 玩家 / [displayName] / 儲值紀錄 / [recordId 縮短]    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐    │
│  │   StatusBadge（大）          │  │  StatusTimeline          │    │
│  │   ✅ success                 │  │   ● 建立  2026-06-20 ... │    │
│  │   amount + currency 主標     │  │   │                      │    │
│  │   (右對齊大金額)             │  │   ● 付款  2026-06-20 ... │    │
│  └──────────────────────────────┘  │   │                      │    │
│                                    │   ● 退款  —              │    │
│  ┌──────────────────────────────┐  └──────────────────────────┘    │
│  │  TransactionCard             │                                  │
│  │  - recordId（+ copy）        │  ┌──────────────────────────┐    │
│  │  - playerId（+ 連結到 09）   │  │  RelatedLinks            │    │
│  │  - orderId（+ copy）         │  │  - 玩家詳情              │    │
│  │  - paymentMethod (label)     │  │  - 玩家儲值列表           │    │
│  │  - paymentChannel            │  │  - 外部訂單系統（v2）    │    │
│  │  - failureReason (if any)    │  └──────────────────────────┘    │
│  │  - createdAt / paidAt /      │                                  │
│  │    refundedAt                │                                  │
│  └──────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
```

- 桌機：左側 StatusBadge + TransactionCard 直排，右側時間軸 + RelatedLinks 直排，兩欄並排（≥ 1024px）
- 行動裝置：全直排

### 4.2 StatusBadge

| status | 視覺 | 副標 |
|--------|------|------|
| pending | 黃，時鐘圖示 | 「等待支付」 |
| success | 綠，勾號 | 「付款成功」 |
| failed | 紅，警示 | `failureReason` label（如「卡片餘額不足」） |
| refunded | 紅，回旋圖示 | 「已退款」 |
| cancelled | 灰 | 「已取消」 |

**金額顯示**：

- 主標為 `amount` 換算為主貨幣單位後格式化（`Intl.NumberFormat` 含 currency 符號）
- 大字級（如 `text-4xl`），視覺重點
- `refunded` 狀態下加刪除線並另起一行顯示「退款 −金額」

### 4.3 TransactionCard

| 欄位 | 顯示規則 |
|------|---------|
| recordId | 等寬字型；右側 CopyButton |
| playerId | `<a href="/players/[playerId]">` 連到玩家詳情 |
| orderId | `null` → 隱藏整列；其餘等寬字型 + CopyButton |
| paymentMethod | 中文 label（`lib/topups/labels.ts`） |
| paymentChannel | `null` → 隱藏整列（客服角色後端回 null，自動隱藏） |
| failureReason | 僅 `status === failed` 顯示；紅字 |
| createdAt | 使用者時區 `YYYY-MM-DD HH:mm:ss` |
| paidAt | `null` → 隱藏整列 |
| refundedAt | `null` → 隱藏整列 |

**為何 `null` 列隱藏而非顯示 `—`**：

- 此頁是「完整明細」，與列表頁的「對齊欄位」需求不同
- 隱藏可避免「為什麼這個欄位是空」的疑惑
- 例外：`failureReason` 對 failed 狀態是重要資訊，雖可為 null 仍顯示「無詳細原因」

### 4.4 StatusTimeline

三個時間節點（含未到達者）：

```
● 建立    2026-06-20 03:11:22  ← createdAt
│
● 付款    2026-06-20 03:11:45  ← paidAt（未到達顯示「—」+ 灰）
│
● 退款    —                    ← refundedAt（未到達顯示「—」+ 灰）
```

- 已到達節點：實心 + 主色
- 未到達節點：空心 + 灰
- 對於 `cancelled` / `failed` 狀態：「付款」「退款」皆灰，並在「建立」下方顯示「狀態：failed / cancelled」
- 時間軸不需互動，純展示

### 4.5 RelatedLinks

| 連結 | URL | 條件 |
|------|-----|------|
| 玩家詳情 | `/players/[playerId]` | 永遠顯示 |
| 玩家儲值列表 | `/players/[playerId]/topups` | 永遠顯示 |
| 同訂單其他紀錄（v2） | — | 暫不實作；orderId 可能對應多筆 record（如分期），v1 不處理 |
| 外部訂單系統 | — | v2；需後端決定外部系統 URL pattern |

---

## 5. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Loading** | route transition | skeleton 卡片 + skeleton 時間軸 |
| **Has data** | `getTopup` 成功 | §4 layout |
| **404 not-found** | `getTopup` 拋 404 | Next.js `not-found.tsx`：「找不到此筆紀錄」+「回儲值列表」CTA（連到 `/players/[playerId]/topups`） |
| **403 forbidden** | `getTopup` 拋 403 | `ForbiddenState`：「您的角色無權查看此筆紀錄」 |
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
| 複製按鈕 | `<button aria-label="複製訂單 ID">`；複製後 `aria-live="polite"` 宣告 |
| StatusTimeline | `<ol>`（時間順序）；每步 `<li>`；已達與未達用 `aria-current` 區分當前 |
| RelatedLinks | `<nav aria-label="related links">` |
| 對比度 | 所有狀態色 ≥ 4.5:1；不單靠顏色 |

---

## 7. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | layout 已處理 redirect |
| [`03-observability.md`](./03-observability.md) | metric：`topups.detail.viewed`、`topups.detail.error{code}` |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 資料來源：`getTopup(playerId, recordId)` |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | `paymentChannel` 由後端依角色回 null；本頁不檢查角色 |
| [`09-screen-player-detail.md`](./09-screen-player-detail.md) | 上游入口（RecentTopups 列點擊） + 下游 RelatedLinks |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 上游入口（列表列點擊） |

---

## 8. 測試清單（TDD）

### 8.1 `_components/status-badge.test.tsx`

```ts
it('should render pending variant with clock icon and "等待支付" subtitle')
it('should render success variant with check icon and "付款成功"')
it('should render failed variant with warning icon and failureReason label as subtitle')
it('should render "無詳細原因" subtitle when status=failed but failureReason is null')
it('should render refunded variant with refund icon and "已退款"')
it('should render cancelled variant with neutral color and "已取消"')
it('should render amount with Intl.NumberFormat using currency-specific minor unit')
it('should add strikethrough on amount when status is refunded')
it('should render "-amount" refund line when status is refunded')
```

### 8.2 `_components/transaction-card.test.tsx`

```ts
// 顯示
it('should render recordId in monospace with Copy button')
it('should render playerId as link to /players/[playerId]')
it('should hide orderId row when value is null')
it('should render orderId in monospace with Copy button when not null')
it('should render paymentMethod with chinese label from labels.ts')
it('should hide paymentChannel row when value is null')
it('should render paymentChannel raw value when not null')
it('should render failureReason in red text ONLY when status is failed')
it('should render "無詳細原因" copy when status=failed and failureReason is null')
it('should render createdAt in user timezone with seconds precision')
it('should hide paidAt row when value is null')
it('should hide refundedAt row when value is null')

// 語意
it('should use <dl><dt><dd> structure for field list')
```

### 8.3 `_components/status-timeline.test.tsx`

```ts
it('should render three steps: 建立 / 付款 / 退款')
it('should render filled marker for createdAt step (always present)')
it('should render filled marker for paidAt step when paidAt is not null')
it('should render empty marker with "—" for paidAt when null')
it('should render filled marker for refundedAt when not null')
it('should render empty marker with "—" for refundedAt when null')
it('should render greyed-out 付款 step when status is failed or cancelled')
it('should render status sub-label "狀態：failed" under 建立 when status is failed')
it('should use <ol> + <li> structure with aria-current on the last reached step')
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
it('should call getTopup(playerId, recordId) with URL params')
it('should render TransactionCard / StatusTimeline / StatusBadge / RelatedLinks on success')
it('should call notFound() when getTopup throws 404')
it('should render ForbiddenState when getTopup throws 403')
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

- [ ] StatusTimeline 是否需顯示 `cancelled` 的時間？目前後端沒有 `cancelledAt` 欄位；若有需求請後端加入並更新 [`06 §2.1`](./06-topup-records-domain.md)
- [ ] `failureReason` 是否需「人類可讀」對照表？目前直接顯示後端 enum 字串，需 [`06 §12`](./06-topup-records-domain.md) `lib/topups/labels.ts` 擴充
- [ ] orderId 連結到外部訂單系統（v2）的 URL pattern 由誰維護？建議放後端，由 BFF SSR 階段直接拼接
- [ ] 是否需要「複製整筆 JSON」按鈕（便於客服回報問題）？需評估資安（含敏感欄位）；v1 不做
- [ ] 退款金額（部分退款 vs 全額退款）後端目前是否區分？影響 §4.2 StatusBadge 退款顯示
