# 後台 RBAC 與稽核規格書

## 1. 概覽

本文件定義 CMS 後台「玩家儲值查詢工具」的：

- 管理員**角色**（roles）與**權限矩陣**（who can do what）
- 各角色的**可見欄位矩陣**（who can see what）
- 角色資訊在 BFF 端的來源與**前後端強制邊界**
- **稽核事件**（audit events）的 schema、觸發點、儲存與檢視責任

範圍**只涵蓋本工具（玩家查詢 + 儲值紀錄）相關的角色**；其他工具（如客服支援、財務報表）的角色與權限自有規格。

**不在本文件範圍**：

- 登入流程、JWT 結構、refresh 機制——見 [`02-auth-session.md`](./02-auth-session.md)
- 玩家／儲值資料模型——見 [`05`](./05-player-query-domain.md)、[`06`](./06-topup-records-domain.md)
- UI 對 403 的呈現——各 screen 規格各自處理

### 核心原則

- **授權單一來源在後端**：後端 JWT claims（或 `/auth/me`）回的 `roles` 為唯一可信來源；前端只用來決定**顯示**，不用來決定**安全邊界**
- **前端遮蔽 ≠ 安全**：任何「藏起按鈕」「不渲染欄位」都只是 UX；後端**必須**獨立驗證每筆請求
- **遮罩在後端執行**：敏感欄位（如手機後 4 碼）依角色由後端決定回什麼；BFF 不二次遮罩，避免「BFF 以為遮了、後端原文已洩漏」的雙重信任問題
- **稽核不可繞過**：所有查詢／匯出在後端記錄；前端 / BFF **不**有「跳過稽核」的旁路
- **稽核 ≠ application log**：稽核是合規證據，後端寫專屬 audit log（如 DynamoDB / CloudWatch Logs 專用 group），與 app log 分離

---

## 2. 角色

v1 提供三個角色，由後端在 user 表維護；JWT claims 內含 `roles: string[]`（多角色可同時擁有，採聯集授權）。

| 角色 | role key | 典型使用者 | 主要職責 |
|------|---------|-----------|---------|
| 客服 | `support` | 第一線客服人員 | 查詢玩家、看儲值狀態回覆玩家問題 |
| 財務 | `finance` | 財務部 / 對帳人員 | 查詢儲值紀錄、彙總、匯出 CSV 做對帳 |
| 管理員 | `admin` | 系統管理員 | 上述全部 + 角色管理（角色管理 UI 本規格不涵蓋） |

> **為何不細分「客服 L1 / L2」**：v1 場景小，再分層只會讓矩陣膨脹卻無實際業務差異。未來若客服 L1 需限制（如不可看完整 Email），新增 `support-l1` role 即可，本規格表格 §4 / §5 對應補列。

> **多角色組合**：使用者同時擁有 `support` 與 `finance` → 任一可見就可見、任一可操作就可操作（**聯集**，不取交集）。後端 JWT 內 `roles` 為陣列，BFF / UI 用 `roles.some()` 判斷。

---

## 3. 取得角色資訊

### 3.1 後端來源

後端 JWT access token 的 claims 內含：

```json
{
  "sub": "01HABCD...",         // userId
  "client_id": "cms-web",
  "roles": ["support", "finance"],
  "iat": 1719500000,
  "exp": 1719500900
}
```

> **為何放在 access token 而非另開 `/auth/me`**：每筆 BFF → API 呼叫都帶 access token，後端在請求進入時就能取 roles 做授權；前端若需顯示，BFF 在 SSR 階段 decode 一次即可，無需另一次 RTT。代價：角色變更需待下一次 access token rotation（最多 15 分鐘）才生效——後台管理場景可接受。

### 3.2 BFF 端取得

```ts
// src/lib/auth/decode-token.ts
import { config } from '@/lib/config'

export type TokenClaims = {
  userId:   string
  clientId: string
  roles:    string[]
  exp:      number
}

/**
 * Base64-decode access token payload 不驗簽（後端已驗，BFF 不重複）。
 * 同 spec 02 對 refresh token 讀 abs_exp 的做法。
 */
export function decodeAccessToken(accessToken: string): TokenClaims
```

- **不驗簽**：BFF 拿到的 token 已經由後端產生；BFF 重新驗簽需共享私鑰，違反最小特權。
- **僅讀 claims**：roles 僅用於 SSR 決定 UI 顯示；任何安全判斷仍以「呼叫後端 API 後端拒絕」為準。

### 3.3 注入 client session

延伸 [`02 §2.5`](./02-auth-session.md) 的 `ClientSession`：

```ts
// src/lib/session/client-session.ts （在 spec 02 基礎上擴充）
export type ClientSession = {
  userId:            string
  clientId:          string
  absoluteExpiresAt: number
  createdAt:         number
  roles:             string[]        // ← 本規格新增
}
```

注入流程同 [`02 §2.5`](./02-auth-session.md)：`(cms)/layout.tsx` 在 SSR 時讀 access token，decode 後 hydrate。

### 3.4 前端使用

```tsx
'use client'
import { useSession } from '@/lib/session/client-session'

export function ExportButton() {
  const session = useSession()
  if (!session.roles.includes('finance') && !session.roles.includes('admin')) return null
  return <button>匯出 CSV</button>
}
```

> **記住**：`return null` 只是 UX。實際匯出端點呼叫時，後端會再驗一次。若 attacker 直接打 `/api/players/.../topups/export` 而前端從未渲染按鈕，**後端仍會回 403**——這是本架構的安全保證。

---

## 4. 權限矩陣

操作層級的「可不可以做」。每格 ✅ = 該角色可呼叫對應端點；空白 = 後端回 403。

| 操作 | 對應端點 | support | finance | admin |
|------|---------|:-------:|:-------:|:-----:|
| 搜尋玩家 | `GET /players/search` | ✅ | ✅ | ✅ |
| 看玩家詳情 | `GET /players/{id}` | ✅ | ✅ | ✅ |
| 看玩家儲值彙總 | `GET /players/{id}/topups/summary` | ✅ | ✅ | ✅ |
| 看玩家儲值列表 | `GET /players/{id}/topups` | ✅ | ✅ | ✅ |
| 看單筆儲值明細 | `GET /players/{id}/topups/{recordId}` | ✅ | ✅ | ✅ |
| 同步匯出 CSV | `GET /players/{id}/topups/export?format=csv` |  | ✅ | ✅ |
| 觸發 async 匯出 | `POST /players/{id}/topups/export/async` |  | ✅ | ✅ |
| 看匯出 job 狀態 | `GET /exports/{jobId}` |  | ✅ | ✅ |
| 管理角色（v2） | （未規劃端點） |  |  | ✅ |

**規則**：

- 客服可查不可匯出——避免大批個資離線外流
- 財務可匯出但**仍受可見欄位矩陣 §5 限制**——CSV 內容遵守可見欄位（如部分欄位輸出 `"***"` 或留空，由後端決定）
- 多角色聯集授權

---

## 5. 可見欄位矩陣

欄位層級的「可不可以看到原值」。每格值代表後端**實際回傳的內容**：

| 欄位 | support | finance | admin |
|------|:-------:|:-------:|:-----:|
| `playerId` | 全 | 全 | 全 |
| `displayName` | 全 | 全 | 全 |
| `email` | 遮罩（`a***@example.com`） | 全 | 全 |
| `phone` | 遮罩（`****5678` 後 4 碼） | 全 | 全 |
| `externalId` | 全 | 全 | 全 |
| `status` | 全 | 全 | 全 |
| `registeredAt` / `lastActiveAt` | 全 | 全 | 全 |
| `recordId` / `playerId`（儲值） | 全 | 全 | 全 |
| `orderId` | 全 | 全 | 全 |
| `amount` / `currency` | 全 | 全 | 全 |
| `paymentMethod` | 全 | 全 | 全 |
| `paymentChannel` | `null`（不看） | 全 | 全 |
| `failureReason` | 全 | 全 | 全 |
| 時間欄位 | 全 | 全 | 全 |

**遮罩規則**：

| 欄位 | 客服看到 |
|------|---------|
| `email` | local-part 首字 + `***@` + 完整 domain（如 `a***@gmail.com`）；長度不暗示原長度 |
| `phone` | 國碼 + `***` + 末 4 碼（如 `+886***5678`）；空字串以 `null` 取代不暗示「沒填」 |
| `paymentChannel` | `null`——客服不需要也不該知道哪家金流商，避免推導出商業條款 |

**為何遮罩在後端**：

- 任何「BFF 拿到原值再遮」的設計，BFF log / 攔截器 / 開發者 console 都會看到原值——資料邊界破洞
- 後端依 JWT roles 決定回什麼，BFF 與前端永遠拿不到不該看的內容
- 這也是為何 [`05 §6`](./05-player-query-domain.md) 強調「BFF 不二次遮罩」——遮罩只在後端發生一次

---

## 6. 前後端強制邊界

| 強制點 | 由誰執行 | 失敗時 |
|--------|---------|--------|
| **API 端點是否可呼叫**（§4 矩陣） | 後端 | 後端回 403 `forbidden` |
| **欄位是否回原值**（§5 矩陣） | 後端 | 後端在 response 回 `null` 或遮罩字串 |
| **UI 是否顯示按鈕／頁面**（UX 層） | 前端 client component | 不渲染（等同隱形） |
| **CMS 路由是否可進入**（navigation） | 前端 + 後端 | 前端在 navbar 不顯示連結；若直接貼 URL，第一支 API 呼叫遇 403 → UI 顯示 `forbidden` 錯誤態 |

**禁止**：

- **BFF 不做角色判斷再決定要不要呼叫 upstream**——這會把授權邏輯複製一份到 BFF，未來政策變動時兩處要同步改、必出 bug
- **前端不用 `roles` 做欄位顯示**——前端只判斷「有沒有值」（`email != null`）。後端決定回 `null` 還是原值，前端純粹依資料 render。否則資料層與顯示層判斷不同步又是一個 bug source
- **BFF 不在 log 中印 `roles`**——roles 隨 JWT 來，本身不是 PII，但配合 userId 後可重建「誰看了誰」軌跡，這份軌跡屬於稽核日誌責任，不在 app log

---

## 7. 路由層保護

| 路由 | 進入條件 |
|------|---------|
| `/players` | 任一登入者皆可（後端會檢查 `players.search` 端點權限） |
| `/players/[playerId]` | 同上 |
| `/players/[playerId]/topups` | 同上 |
| `/players/[playerId]/topups/[recordId]` | 同上 |
| `/players/[playerId]/topups/export`（若有獨立頁面） | navbar 不顯示給 support；直接訪問見「顯示 forbidden 錯誤態」 |

`(cms)/layout.tsx` 已處理「未登入 → redirect /login」，本規格**不**加 layout 層的角色 guard——角色檢查交給 API 呼叫的 403 結果統一呈現。原因：

- 集中授權判斷於後端，前端零判斷重複
- 角色變更後（如新增 role）前端無需改 guard 邏輯
- 直接訪問無權頁面時的「forbidden 錯誤態」UX 統一（各 screen 規格的 ErrorState `forbidden` variant）

---

## 8. 稽核事件

### 8.1 由誰寫

**全部由後端寫**。BFF / 前端**不**寫稽核——它們不在合規可信邊界內。

BFF 的責任只有「把足以識別操作者的 context 透傳給後端」：

- `Authorization: Bearer <jwt>` → 後端解 claims 取 `userId / roles`
- `X-Request-ID` → 後端用以串接同一筆操作的所有 log 與稽核

### 8.2 觸發事件清單

| event name | 觸發點 | 紀錄欄位（最少集） |
|-----------|--------|------------------|
| `players.search` | 後端在 `/players/search` 成功回應時 | `userId, roles, query, result_count, request_id, ip, occurred_at` |
| `players.read` | 後端在 `/players/{id}` 成功回應時 | `userId, roles, target_player_id, request_id, occurred_at` |
| `topups.list` | `/players/{id}/topups` 成功回應時 | `userId, roles, target_player_id, filters, result_count, request_id, occurred_at` |
| `topups.read` | `/players/{id}/topups/{recordId}` 成功回應時 | `userId, roles, target_player_id, record_id, request_id, occurred_at` |
| `topups.summary` | `/players/{id}/topups/summary` 成功回應時 | `userId, roles, target_player_id, request_id, occurred_at` |
| `topups.export.request` | async 匯出 job 被建立時 | `userId, roles, target_player_id, filters, format, request_id, occurred_at` |
| `topups.export.complete` | async job 完成或同步匯出回應時 | `userId, job_id (async only), target_player_id, row_count, file_size_bytes, request_id, occurred_at` |
| `auth.login` / `auth.logout` | 由 [`02`](./02-auth-session.md) 範圍 | （另見 spec 02） |

> **為何 query / filters 也記**：稽核需回答「2026-06-28 14:00 誰對玩家 A 做了什麼條件的搜尋」；只記 `result_count` 無法重建調查上下文。

### 8.3 不記的事件

- **失敗的請求**（4xx / 5xx）——失敗未實際看到資料，記之意義有限；惟 403 `forbidden` 後端可選擇記為「越權嘗試」（建議記，本規格不強制）
- **未認證請求**（401）——尚未識別操作者，記無意義
- **`GET /exports/{jobId}` 輪詢**——輪詢不存取玩家資料本身，僅查 job 狀態；避免稽核被輪詢淹沒

### 8.4 儲存

- **與 app log 物理隔離**：後端使用 CloudWatch Logs 專屬 group（如 `/cms/audit`）或 DynamoDB；不寫進 app log group
- **保留 ≥ 1 年**（與合規對齊，由後端決定）
- **不可刪改**：採 append-only；管理員介面（v2）只可查詢，不可修改

> 儲存細節屬後端規格範圍；本規格只定義「BFF / 前端對稽核的期待」。後端規格須單獨描述 schema / retention / 查詢 API。

---

## 9. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | `roles` 來自 access token claims；ClientSession 擴充欄位（§3.3） |
| [`03-observability.md`](./03-observability.md) | app log redact 規則包含 `email` / `phone`，避免遮罩前的值落入 app log；`roles` 不入 app log |
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 玩家欄位可見性矩陣（§5）；BFF 不二次遮罩 |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 儲值欄位可見性、匯出權限與稽核事件（§8） |
| [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md) / [`10`](./10-screen-topup-list.md) / [`11`](./11-screen-topup-detail.md) | 各 screen 的 ErrorState `forbidden` variant、按鈕條件顯示 |

---

## 10. 測試清單（TDD）

### 10.1 `src/lib/auth/decode-token.test.ts`

```ts
it('should decode userId, clientId, roles, exp from valid JWT payload')
it('should return empty roles array when claim is missing')
it('should return single-element array when claim is single string')
it('should NOT verify signature (decode-only)')
it('should throw when token is not three base64url segments')
it('should throw when payload is not valid JSON')
```

### 10.2 `src/lib/session/client-session.test.tsx`（擴充 spec 02 §9 既有測試）

```ts
it('should include roles array in ClientSession value')
it('should expose empty roles array when JWT has none')
it('should never include accessToken / refreshToken / sid in value')   // 同 spec 02
```

### 10.3 角色感知 UI（在各 screen test 中執行）

```ts
// spec 10 _components/export-button.test.tsx
it('should render Export button when session.roles includes "finance"')
it('should render Export button when session.roles includes "admin"')
it('should NOT render Export button when session.roles is only ["support"]')
it('should render Export button when session.roles includes both "support" and "finance"')

// spec 11 _components/payment-channel.test.tsx
it('should render paymentChannel value when not null')
it('should render "—" when paymentChannel is null (server returned masked / forbidden)')
it('should NOT check session.roles to decide rendering — purely data-driven')
```

> 注意 §6 原則：UI 元件**不**依 `session.roles` 決定欄位顯示——資料層由後端控制 `null` vs 原值，元件純看資料。`ExportButton` 是例外（決定「按鈕是否渲染」，非「資料是否顯示」）。

### 10.4 端到端 forbidden 流程（Playwright）

```ts
test('support role cannot trigger CSV export and sees no Export button on topup list')
test('support role directly navigating to export URL sees forbidden ErrorState')
test('finance role can trigger sync CSV export and downloads file')
```

### 10.5 不在本規格的測試

- 稽核事件實際落地驗證 → 後端規格
- 後端 403 拒絕端點呼叫 → 後端規格
- 欄位遮罩內容 → 後端規格（如「`a***@gmail.com` 不暗示 local-part 長度」）

---

## 11. 開放問題

> 與 PM / 安全團隊對齊後更新：

- [ ] 是否需要「客服 L1 / L2」分層？影響 §2 表格
- [ ] 越權嘗試（後端拒絕 403 的請求）是否寫稽核？建議是，但需確認儲存量
- [ ] CSV 匯出對「客服角色」是否完全不可用，或可匯出但全欄位遮罩？影響 §4 與後端規格
- [ ] 多角色聯集授權是否真符合需求？某些政策可能要求取交集（最嚴）——v1 預設聯集，請 PM 確認
- [ ] `decodeAccessToken` 不驗簽是否需 ADR 記錄理由？建議是（avoid future surprise）
- [ ] 角色變更最遲生效時間（15 分鐘 = access token TTL）能否接受？需與 ops 確認
