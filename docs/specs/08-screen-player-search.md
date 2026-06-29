# 玩家搜尋頁規格書

> **✅ 後端已提供搜尋端點（2026-06-29）**：後端 OpenAPI 已定案 `GET /api/cms/players`，本頁的搜尋資料層
> 可由 mock **抽換為真實串接**（`cmsRequest('/cms/players')`，見 [`05`](./05-player-query-domain.md) 已對齊規格）。
> 搜尋語意（email 前綴 lowercase、phone E.164、暱稱前綴 NFC）由後端執行；viewer 角色的 email/phone 遮罩亦在後端。
> 本頁 UI 規格（表單、結果列表、空態、ErrorState variant）不受抽換影響——`searchPlayers` 簽章與回傳型別不變。

## 1. 概覽

CMS 後台「玩家搜尋頁」——管理員快速以 playerId / externalId / 暱稱 / Email / 手機定位玩家、進入詳情。

範圍：

- 路由與 layout 歸屬
- Server Component / Client Component 切割原則
- 搜尋表單欄位、驗證、提交行為
- 結果列表欄位、互動、空態／載入態／錯誤態
- URL 與搜尋狀態同步
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- 後端 API 契約、欄位定義、遮罩規則——見 [`05-player-query-domain.md`](./05-player-query-domain.md)
- 玩家詳情頁畫面——見 [`09-screen-player-detail.md`](./09-screen-player-detail.md)
- 角色可見性、稽核——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)

### 核心原則

- **URL 是搜尋狀態的唯一來源**：query string 變化驅動結果重抓；重新整理 / 分享連結應重現相同畫面
- **Server-first**：初次載入與 query 改變時走 Server Component / Server Action 取資料，避免 client-side fetch waterfall 與 layout shift
- **無 client-side 過濾**：列表完全由 server 回；不在 client 做二次篩選或排序
- **每個狀態都有明確 UI**：loading / empty（未搜尋）/ empty（搜尋無結果）/ error / multi-match 各有對應 component，不混用同一 placeholder
- **鍵盤可達**：搜尋表單可純鍵盤操作；結果列表可上下鍵選取、Enter 進詳情

---

## 2. 路由與 layout

### 2.1 路由

```
/players                    # 玩家搜尋頁（本規格）
/players/[playerId]         # 玩家詳情頁 → 見 spec 09
```

- 屬於 `(cms)` route group，繼承 [`02 §2.5`](./02-auth-session.md) 的 `SessionProvider` 與 layout
- 未登入訪問 → `(cms)/layout.tsx` 觸發 `redirect('/login')`，本頁不另設 guard

### 2.2 檔案結構

```
src/app/(cms)/players/
├── page.tsx                       # 玩家搜尋頁（Server Component）
├── page.test.tsx                  # 頁面層整合測試（RTL）
├── _components/
│   ├── search-form.tsx            # 搜尋表單（Client Component）
│   ├── search-form.test.tsx
│   ├── result-list.tsx            # 結果列表（Server Component，接收 server-fetched data）
│   ├── result-list.test.tsx
│   ├── result-row.tsx             # 單列（Client Component，處理 hover / 鍵盤選取）
│   ├── result-row.test.tsx
│   ├── empty-state.tsx            # 空態（無搜尋 / 無結果）
│   ├── empty-state.test.tsx
│   ├── error-state.tsx            # 錯誤態（4xx / 5xx）
│   ├── error-state.test.tsx
│   └── load-more.tsx             # 「載入更多」按鈕（Client；§5.3）；分頁以 useTransition + aria-busy；無獨立測試，由 page.test.tsx 覆蓋
└── _lib/
    ├── query-params.ts            # URL → PlayerSearchQuery 解析與序列化
    ├── query-params.test.ts
    └── types.ts                   # 頁面本地共用型別
```

> `_components` / `_lib` 前綴底線：Next.js App Router 慣例，**不視為路由**——只是 collocate 給本頁的 component 與 helper。

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `app/(cms)/players/page.tsx` | Server | 解析 search params、呼叫 `lib/players/search.ts`、render server-side 結果列表 |
| `SearchForm` | Client | 受控表單、Enter 提交、欄位互動需 `useState` |
| `ResultList` | Server | 純展示 props，無互動；放 Server Component 減少 JS bundle |
| `ResultRow` | Client | 鍵盤選取、hover、`onClick` 導頁需 client |
| `EmptyState` | Client | `no-results` variant 的 CTA 呼叫 `document.getElementById('playerId')?.focus()`（DOM 互動） |
| `ErrorState` | Client | 使用 `useRouter().refresh()` / 倒數計時器（`rate-limited` variant 以 `setInterval` 自動 retry） |

> **為何 `ResultList` 是 Server 但 `ResultRow` 是 Client**：列表外殼純展示資料；單列需互動（hover、focus、`router.push`）才需 client。Server `ResultList` 接到 Player[] 後 `map` render Client `ResultRow`，這是 RSC + Client 的標準混搭。

> **Next.js 16 `searchParams` 為 Promise**：`page.tsx` 須先 `const resolved = await searchParams` 再交給 `parseSearchQuery` 解析。

---

## 4. 搜尋表單（`SearchForm`）

### 4.1 欄位

| label | input 名稱 | type | placeholder | 驗證（client） |
|-------|-----------|------|------------|---------------|
| 玩家 ID | `playerId` | text | `01HABCD...` | 非空白；trim 後 length ≥ 1 |
| 外部 ID | `externalId` | text | 遊戲端 ID | 同上 |
| 暱稱 | `displayName` | text | 玩家暱稱前綴 | trim 後 length ≥ 1 |
| Email | `email` | email | `name@example.com` | 含 `@`，或 `@` 前段（前綴搜尋） |
| 手機 | `phone` | tel | `+886912345678` | trim 後僅含數字、`+`、`-`、空白、`()` |

- **不在 client 做後端等價驗證**——後端會回 `invalid_input`，client 只擋明顯錯字
- **大小寫**：UI 不改使用者輸入大小寫；正規化（如 Email 轉小寫）由 BFF `lib/players/search.ts` 處理（見 [`05 §3.1`](./05-player-query-domain.md)）

### 4.2 行為

| 行為 | 對應 |
|------|------|
| 按 Enter 或點「搜尋」按鈕 | `router.push(/players?<query>)`——**不打 API**，由 page.tsx 因 URL 變化重新 server-render |
| 點「清除」按鈕 | `router.push('/players')`，回到「未搜尋」空態 |
| 至少要填一欄才能提交 | 「搜尋」按鈕在所有欄位 trim 後皆空時 `disabled`；不靠 server 回 400 才提示 |
| 表單值來源 | initial value 由 URL search params hydrate（Server `page.tsx` 以 `_lib/query-params.parseSearchQuery` 解析 URL，再把結果透過 `initialQuery` prop 傳入 Client `SearchForm`，由其 `useState` 從該 prop 初始化）——避免 client 端 `useSearchParams()` + Suspense；之後使用者編輯為 client state |
| 提交後不清空欄位 | 保留填入值方便修正再搜 |

### 4.3 鍵盤

- Tab 順序：欄位由上而下、最後到「搜尋」按鈕、再到「清除」按鈕
- Enter（焦點在任一文字輸入時）：等同點「搜尋」
- Esc：若任一欄位有值 → 清空當前焦點欄位（不清整表）；無值 → 無動作（**不**等同「清除」按鈕，避免誤觸）

---

## 5. 結果列表（`ResultList` + `ResultRow`）

### 5.1 欄位

每列顯示：

| 欄位 | 來源 | 顯示規則 |
|------|------|---------|
| 玩家 ID | `player.playerId` | 等寬字型；長 ID 截斷顯示，hover tooltip 顯示完整值 |
| 暱稱 | `player.displayName` | 主視覺欄位 |
| Email | `player.email` | `null` → `—`；遮罩值（含 `*`）原樣顯示 |
| 手機 | `player.phone` | 同上；E.164 顯示為 `+886 912 345 678`（純展示，不改後端值） |
| 狀態 | `player.status` | tag 樣式：active=綠 / frozen=橘 / closed=灰 |
| 註冊時間 | `player.registeredAt` | 顯示為使用者時區的 `YYYY-MM-DD HH:mm`（不顯示秒） |
| 最近活動 | `player.lastActiveAt` | `null` → `—`；其餘同上 |

> **狀態 tag 為共用 component**：`ResultRow` 不內嵌 tag 樣式，而是 import 共用的 `@/components/players/status-tag`（`PlayerStatusTag`）。CMS 08–11 四個畫面皆需玩家／儲值狀態 tag，已達 [`09 §3.2`](./09-screen-player-detail.md) 預期的「第三處出現即提升」條件，故已從各畫面本地實作提升為共用 component。

> **時間顯示時區（實作補充，全 CMS 共用）**：時間欄位的「使用者時區」由共用 helper `src/lib/format/datetime.ts`（`formatDateTime` / `formatDateTimeSeconds` / `formatShortDateTime`）實作，**固定以 `APP_TIME_ZONE = 'Asia/Taipei'` 顯示**，而非讀瀏覽器系統時區。原因：日期格式化發生在 Client Component（會經 SSR → hydration），若用伺服器系統時區（多為 UTC）與瀏覽器時區會算出不同字串 → React hydration mismatch。本系統為單一地區內部後台，固定台北時區等同「使用者時區」且伺服器／客戶端輸出一致。08 / 09 / 11 各畫面的「使用者時區」時間欄位皆依此。

### 5.2 互動

- **整列可點**：點任意位置 `router.push('/players/<playerId>')`
- **鍵盤**：列獲焦時 Enter 同上；上下鍵移焦下一／上一列；Home/End 跳第一／最後一列
- **單筆完全匹配自動跳轉？** **不自動**——避免操作者誤以為「沒搜尋成功」。即使只有 1 筆結果也只是顯示該列，使用者明確點擊／Enter 才導頁

### 5.3 分頁

- 列表底部「載入更多」按鈕；點擊發另一個 `router.push` 帶 `cursor=<nextCursor>`——同樣由 page.tsx 重新 server render
- `nextCursor` 為 `null` 時不渲染按鈕
- v1 **不做** infinite scroll：後台場景多筆瀏覽少，按鈕語意更清楚也便於鍵盤操作

---

## 6. 狀態

每個狀態各自有 component，**禁止**用同一 placeholder + props variant。

| 狀態 | 觸發 | UI |
|------|------|-----|
| **Idle**（未搜尋） | URL 無任何搜尋欄位 query param | `EmptyState variant="idle"`：圖示 + 文案「輸入玩家資訊以開始查詢」 |
| **Loading** | 搜尋中（route transition pending） | 沿用 [Next.js loading.tsx 慣例](https://nextjs.org/docs/app/api-reference/file-conventions/loading) 或顯示 skeleton 列；不全頁 spinner |
| **Empty results** | API 回 `players: []` | `EmptyState variant="no-results"`：文案「找不到符合條件的玩家」+「修改搜尋條件」CTA（focus 跳回表單第一欄） |
| **Has results** | `players.length > 0` | `ResultList` |
| **Error 400 `invalid_input`** | client 已過濾，理論不會走到；若仍出現代表前後端 schema 不同步 | `ErrorState variant="bad-request"`：顯示 `message`、引導回表單修正 |
| **Error 403 `forbidden`** | 後端拒絕本角色查詢 | `ErrorState variant="forbidden"`：文案「您的角色無權使用玩家查詢功能」；不顯示表單 |
| **Error 429** | 後端限流 | `ErrorState variant="rate-limited"`：顯示 `Retry-After` 秒數倒數，倒數結束自動 retry 一次 |
| **Error 5xx / network** | upstream 失敗 | `ErrorState variant="server-error"`：通用錯誤 + 「重試」按鈕（client 動作：呼叫 `router.refresh()`） |

### 6.1 載入態的 layout shift

- skeleton 列高度與真實 `ResultRow` 一致；避免結果切換時 list 跳動
- 搜尋表單不在 loading 時 disable（使用者可在等資料時繼續修改條件）

### 6.2 為何錯誤態不全部用同一個 component 接 `error code` switch

每個錯誤 variant 的 CTA 與文案都不同（forbidden 沒有重試意義、rate-limited 需倒數、bad-request 要引導回表單）。共用 component 寫 switch 會迅速膨脹成 god-component；分開定義使行為與測試清楚。

---

## 7. URL 與搜尋狀態同步

### 7.1 Query params

| URL param | 對應欄位 |
|-----------|---------|
| `playerId` | 玩家 ID |
| `externalId` | 外部 ID |
| `displayName` | 暱稱 |
| `email` | Email |
| `phone` | 手機 |
| `cursor` | 分頁游標 |
| `limit` | 單頁筆數（v1 預設不帶，等同預設 20） |

- **參數名與 BFF 對 Browser 的 query 名一致**（camelCase）——`lib/players/search.ts` 內部再轉 snake_case 給後端，見 [`05 §4`](./05-player-query-domain.md)
- 空字串欄位**不寫入 URL**：使用者只填 `email` 時 URL 應只有 `?email=...`，避免長 query string

### 7.2 解析（`_lib/query-params.ts`）

```ts
import type { ReadonlyURLSearchParams } from 'next/navigation'

export type PlayerSearchQuery = {
  playerId?:    string
  externalId?:  string
  displayName?: string
  email?:       string
  phone?:       string
  cursor?:      string
  limit?:       number
}

export function parseSearchQuery(params: URLSearchParams | ReadonlyURLSearchParams): PlayerSearchQuery
export function serializeSearchQuery(query: PlayerSearchQuery): string  // 回 "?a=b&c=d"，空欄位不寫入
export function hasAnySearchField(query: PlayerSearchQuery): boolean    // 用於判斷 idle 態
```

- `parseSearchQuery` 對 `limit` 做數字驗證；解析失敗 → 忽略（fall back 預設值），**不** throw（避免使用者貼錯誤連結就看到全頁錯誤）
- 解析後的 query 物件型別與 `lib/players/types.ts` 中的 `PlayerSearchQuery` 應**相同 shape**——但兩個檔案各自定義以避免 client → server 雙向依賴（Next.js client component 不能直接 import server-only module）

---

## 8. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| 表單欄位 | 每個 `<input>` 有 `<label htmlFor>` 對應；不依靠 placeholder 作為唯一 label |
| 按鈕 | `<button type="submit">`；不使用 `<div onClick>` |
| Disabled 狀態 | 用 `disabled` 屬性；不靠 `pointer-events: none` 偽 disable |
| 結果列表 | `role="list"` + 每列 `role="listitem"`；列可獲焦（`tabIndex={0}`） |
| 鍵盤導覽 | §5.2 規格；focus indicator 必須清楚可見（不可只用 hover style） |
| 狀態文字 | Loading 用 `aria-live="polite"` 宣告「搜尋中」；錯誤用 `role="alert"` |
| 色彩對比 | 狀態 tag（active/frozen/closed）的文字對比 ≥ 4.5:1（WCAG AA） |
| 螢幕閱讀器 | 結果列 announce 順序：「暱稱、ID、狀態」（最重要先讀） |

---

## 9. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | `(cms)/layout.tsx` 已處理未登入 redirect；本頁不另寫 guard。`useSession()` 可取得 `userId` 用於 client log |
| [`03-observability.md`](./03-observability.md) | 結果列表 render 時 emit metric `players.search.result_count`；錯誤態 emit `players.search.error{code}` |
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 業務邏輯與 API 契約；本頁所有資料層呼叫走 `lib/players/search.ts` |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 角色決定本頁是否可進入；403 處理依該規格 |
| [`09-screen-player-detail.md`](./09-screen-player-detail.md) | 點列導向；URL 移交 `playerId` |

---

## 10. 測試清單（TDD）

### 10.1 `_lib/query-params.test.ts`

```ts
// parseSearchQuery
it('should parse all known fields from URLSearchParams')
it('should treat empty string values as undefined')
it('should parse limit as number when valid integer string')
it('should ignore limit when non-integer (no throw)')
it('should ignore limit when out of [1, 50] range')
it('should preserve cursor opaque string verbatim')

// serializeSearchQuery
it('should omit undefined and empty-string fields from output')
it('should produce stable key order for snapshot diffability')
it('should return empty string when query has no fields')

// hasAnySearchField
it('should return false when only cursor / limit are present')
it('should return true when any of playerId / externalId / displayName / email / phone present')
```

### 10.2 `_components/search-form.test.tsx`

```ts
// 渲染
it('should render all five search fields with labels')
it('should hydrate field values from URL search params on initial mount')
it('should render Submit button as disabled when all fields are empty after trim')
it('should render Submit button as enabled when any field has non-whitespace value')

// 提交
it('should call router.push with serialized query when Enter pressed in any field')
it('should call router.push with serialized query when Submit button clicked')
it('should NOT include empty fields in the pushed URL')
it('should NOT call API directly on submit (relies on page.tsx re-render)')

// 清除
it('should call router.push("/players") when Clear button clicked')

// 鍵盤
it('should clear current field value when Esc pressed with focused non-empty field')
it('should NOT trigger Clear-All when Esc pressed with empty field')

// 無障礙
it('should associate each input with a label via htmlFor')
it('should expose Submit as <button type="submit">')
```

### 10.3 `_components/result-row.test.tsx`

```ts
// 顯示
it('should render displayName, playerId, email, phone, status, registeredAt')
it('should render "—" when email is null')
it('should render "—" when phone is null')
it('should render "—" when lastActiveAt is null')
it('should render masked email value (a***@example.com) verbatim without transformation')
it('should render E.164 phone with spacing for readability without mutating value sent to API')
it('should render status tag with active/frozen/closed visual variant')

// 互動
it('should navigate to /players/<playerId> when row clicked')
it('should navigate to /players/<playerId> when Enter pressed with row focused')
it('should be focusable (tabIndex 0)')
it('should NOT navigate when row is disabled (e.g., status closed) [if future variant added]')
```

### 10.4 `_components/result-list.test.tsx`

```ts
it('should render one ResultRow per player')
it('should render no rows when players array is empty (delegates to EmptyState elsewhere)')
it('should expose role="list" on the container')
```

### 10.5 `_components/empty-state.test.tsx`

```ts
it('should render idle variant copy when variant="idle"')
it('should render no-results variant copy with CTA when variant="no-results"')
it('should focus the first form field when CTA clicked (no-results variant)')
```

### 10.6 `_components/error-state.test.tsx`

```ts
it('should render bad-request copy when variant="bad-request"')
it('should render forbidden copy and hide form-affordance when variant="forbidden"')
it('should render countdown using Retry-After when variant="rate-limited"')
it('should auto-trigger refresh once when countdown reaches zero (rate-limited)')
it('should render server-error copy with Retry button when variant="server-error"')
it('should call router.refresh() when Retry clicked')
it('should expose role="alert" on the error container')
```

### 10.7 `page.test.tsx`（整合）

```ts
// 路由 / 狀態切換
it('should render idle EmptyState when URL has no search params')
it('should call searchPlayers with parsed query when URL has search params')
it('should render ResultList when searchPlayers returns players')
it('should render no-results EmptyState when searchPlayers returns empty array')

// 錯誤分支
it('should render forbidden ErrorState when searchPlayers throws 403')
it('should render rate-limited ErrorState when searchPlayers throws 429 with Retry-After')
it('should render server-error ErrorState when searchPlayers throws 500')

// 分頁
it('should render "Load more" button when nextCursor is not null')
it('should NOT render "Load more" button when nextCursor is null')
it('should push URL with cursor param when "Load more" clicked')

// metric
it('should emit players.search.result_count metric on successful render')
it('should emit players.search.error metric with normalized code on error render')
```

### 10.8 E2E（Playwright）

最小集合，覆蓋頁面層 server↔client 整合：

```ts
test('search by displayName prefix returns matching players and clicking a row navigates to detail')
test('reload after search preserves query state and re-fetches results')
test('navigating from /players?... back to /players (clear) returns to idle state')
test('forbidden role sees forbidden error state on /players')
```

E2E 須 mock 後端（透過 BFF 對接 mock server）或在 dev 環境跑真實後端；不可 mock `lib/players/search.ts`（內部模組），詳見 [`CLAUDE.md` TDD 規則](../../CLAUDE.md#規則)。

---

## 11. 開放問題（TODO）

> 與 UX / PM 對齊後更新本規格：

- [ ] 結果列是否顯示「最近一次儲值時間」（玩家詳情前的快速資訊）——若是，要在 [`05`](./05-player-query-domain.md) Player schema 加欄位
- [ ] 暱稱欄位是否支援萬用字元（如 `林*`）——v1 假設純前綴；確認後更新 §4.1 / §10.2
- [ ] forbidden 錯誤是否需要「申請權限」連結（連到內部工單）——影響 §6 ErrorState 的 CTA
- [ ] 結果列 hover 是否顯示快速操作（如「複製 playerId」），或全部交由詳情頁——影響 ResultRow 互動測試
