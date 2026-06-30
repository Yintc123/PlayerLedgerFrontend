# 後台 RBAC 與稽核規格書

## 1. 概覽

本文件定義 CMS 後台「玩家儲值查詢工具」的：

- 管理員**角色**（單一 role）與**權限矩陣**（who can do what）
- 各角色的**可見欄位矩陣**（who can see what）
- 角色資訊在 BFF 端的來源與**前後端強制邊界**
- **稽核事件**（audit events）的 schema、觸發點、儲存與檢視責任

範圍**只涵蓋本工具（玩家查詢 + 儲值紀錄）相關的角色**；其他工具（如客服支援、財務報表）的角色與權限自有規格。

> **對齊後端**：本規格以 PlayerLedgerBackend `pkg/jwt/role.go` 與 `infrastructure.md §8.4` 為單一可信來源；後端角色 enum、JWT claim 格式、稽核事件常數任何變動都同步更新本文件。

**不在本文件範圍**：

- 登入流程、JWT 結構、refresh 機制——見 [`02-auth-session.md`](./02-auth-session.md)
- 玩家／儲值資料模型——見 [`05`](./05-player-query-domain.md)、[`06`](./06-topup-records-domain.md)
- UI 對 403 的呈現——各 screen 規格各自處理

### 核心原則

- **授權單一來源在後端**：後端 JWT claims 內的 `role` 為唯一可信來源；前端只用來決定**顯示**，不用來決定**安全邊界**
- **前端遮蔽 ≠ 安全**：任何「藏起按鈕」「不渲染欄位」都只是 UX；後端**必須**獨立驗證每筆請求
- **遮罩在後端執行**：敏感欄位（如手機後 4 碼）依角色由後端決定回什麼；BFF 不二次遮罩，避免「BFF 以為遮了、後端原文已洩漏」的雙重信任問題
- **稽核不可繞過**：所有查詢／匯出在後端記錄；前端 / BFF **不**有「跳過稽核」的旁路
- **稽核 ≠ application log**：稽核是合規證據，後端寫專屬 audit log（如 DynamoDB / CloudWatch Logs 專用 group），與 app log 分離

---

## 2. 角色

後端 `pkg/jwt/role.go` 定義 4 個 role；CMS 後台僅使用前 3 個（`member` 屬玩家端，由 BFF / CMS 完全擋掉）：

| role key | 中文名稱 | 典型使用者 | 主要職責 |
|---|---|---|---|
| `admin` | 系統管理員 | 維運／資安／高階主管 | 全部讀＋匯出＋管理 CMS 使用者（CRUD） |
| `user` | 一般操作人員 | 客服、財務、對帳 | 全部讀＋匯出；**不可**管理使用者 |
| `viewer` | 唯讀檢視者 | 受訓中、跨部門短期查閱 | 讀（遮罩 PII）＋**不可**匯出 |
| `member` | 玩家端使用者 | — | **完全不應出現在 CMS**；BFF 透過 `RequireUserType(cms)` middleware 一律 403 |

> **單一 role 設計**：後端 `AccessClaims.Role` 為單一 `Role` 字串（[`infrastructure.md §8.3`](../../PlayerLedgerBackend/docs/specs/infrastructure.md)），**不是陣列**。每個使用者同一時間只有一個 role；要升降級走 [`cms-users-api.md §4.3`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md) 的 `PATCH /cms/users/{id}`（admin only）。

> **為何不為「客服 / 財務」分開設 role**：後端 v1 採通用 `user` role，業務上「客服」「財務」皆為一般操作人員，能力差異不大；若未來真有需要再增加 role enum 值（如 `user_finance`），目前依「最少 role」原則維持 3 個。

> **角色變更最遲生效時間**：access token TTL 15 分鐘內舊 role 仍有效；後端 `PATCH /cms/users/{id}` 改 role 時會 `RevokeAll(targetUserId)` 強制 target 登出（[`cms-users-api.md §4.3`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md)），所以實際上**改 role 即刻踢人**、無 15 分鐘 race。

---

## 3. 取得角色資訊

### 3.1 後端來源（JWT access token claims）

後端 `pkg/jwt/jwt.go` 的 `AccessClaims` 結構：

```json
{
  "sub":   "0193b3f4-1234-7abc-9def-0123456789ab",   // userId（RFC 7519 sub）
  "utype": "cms",                                     // "cms" | "member"
  "role":  "admin",                                   // "admin" | "user" | "viewer" | "member"
  "fid":   "0193b3f4-...",                            // family id（refresh rotation 用）
  "iat":   1719500000,
  "exp":   1719500900
}
```

> **為何放在 access token 而非另開 `/auth/me`**：每筆 BFF → API 呼叫都帶 access token，後端在請求進入時就能取 `role` 做授權；前端若需顯示，BFF 在 SSR 階段 decode 一次即可，無需另一次 RTT。代價：角色變更需待下次 access token rotation——但後端 `PATCH /cms/users/{id}` 改 role 時會強制 RevokeAll target session（§2 註），實際上**改 role 即刻生效**。

### 3.2 BFF 端取得

```ts
// src/lib/auth/decode-token.ts
export type Role = 'admin' | 'user' | 'viewer' | 'member'
export type UserType = 'cms' | 'member'

export type TokenClaims = {
  userId:   string    // = sub
  userType: UserType  // = utype
  role:     Role
  familyId: string    // = fid
  exp:      number
}

/**
 * Base64-decode access token payload 不驗簽（後端已驗，BFF 不重複）。
 * 同 spec 02 對 refresh token 讀 abs_exp 的做法。
 */
export function decodeAccessToken(accessToken: string): TokenClaims
```

- **不驗簽**：BFF 拿到的 token 已經由後端產生；BFF 重新驗簽需共享私鑰，違反最小特權。
- **僅讀 claims**：role 僅用於 SSR 決定 UI 顯示；任何安全判斷仍以「呼叫後端 API 後端拒絕」為準。
- **嚴防 `utype != cms`**：CMS 不該出現玩家端 token；若 decode 後發現 `utype === 'member'`，視為「session 受污染」，BFF 應拒絕並導 login（防禦深度）。

### 3.3 注入 client session

延伸 [`02 §2.5`](./02-auth-session.md) 的 `ClientSession`：

```ts
// src/lib/session/client-session.ts （在 spec 02 基礎上擴充）
export type ClientSession = {
  userId:            string
  clientId:          string
  absoluteExpiresAt: number
  createdAt:         number
  role:              Role        // ← 本規格新增；單一字串，**非**陣列
}
```

注入流程同 [`02 §2.5`](./02-auth-session.md)：`(cms)/layout.tsx` 在 SSR 時讀 access token，decode 後 hydrate。

### 3.4 前端使用（角色感知 UI）

角色感知 UI 的代表是「匯出 CSV」與「建立儲值」按鈕：依 `session.role` 決定**是否渲染**，但這只是 UX，安全邊界在資料層（後端回什麼）。

```tsx
'use client'
import { useSession } from '@/lib/session/client-session'

// 匯出 CSV：從「已取得的列表 data」在 client 端產檔（無後端 export 端點，見 §4.1）
export function ExportButton({ records }: { records: DepositRecord[] }) {
  const { role } = useSession()
  // 可匯出 = admin 或 user；viewer 隱藏（純 UX）
  if (role !== 'admin' && role !== 'user') return null
  return <button onClick={() => downloadCsv(records)}>匯出 CSV</button>
}
```

> **client 端匯出的安全模型**：匯出鈕**只能匯出後端已經回給瀏覽器的 `data`**——viewer 即使繞過 `return null`（改 DOM／直接呼叫函式），也匯不出後端沒回的欄位。因此真正的邊界是「後端在 `/cms/deposit-records` 回應裡，依 role 給了什麼」，**不是**這顆按鈕。原先「attacker 直打 export 端點、後端回 403」的保證已不適用——**後端沒有 export 端點**（§4.1）。

> ⚠️ **已知缺口（待後端遮罩）**：後端目前在 CMS deposit-records 回應中**未**對 viewer 遮罩 `internalNote` / `operatorIp` / `referenceNo`，viewer 在螢幕與 Network 都看得到原值（§5）。前端 v1 匯出僅含「螢幕可見欄位」（不含 `internalNote` / `operatorIp`）以避免放大外洩，但這是 UX 緩解、**非**安全保證；徹底修法須後端依 role 遮罩——見 §5、§11。

> **role 比對寫法**：`session.role === 'admin'` 或 `session.role !== 'viewer'`。**不要**寫 `session.roles.includes(...)`（roles 陣列是舊設計，已廢）。

---

## 4. 權限矩陣

操作層級的「可不可以做」。每格 ✅ = 該角色可呼叫對應端點；空白 = 後端回 403。

### 4.1 玩家儲值查詢工具

| 操作 | 對應端點 | admin | user | viewer |
|---|---|:-:|:-:|:-:|
| 搜尋玩家 | `GET /cms/players` | ✅ | ✅ | ✅ |
| 看玩家詳情 | `GET /cms/players/{id}` | ✅ | ✅ | ✅ |
| 看玩家儲值彙總 | `GET /cms/players/{id}/topup-summary` | ✅ | ✅ | ✅ |
| 看儲值列表 | `GET /cms/deposit-records?player_id=` | ✅ | ✅ | ✅ |
| 看單筆儲值明細 | `GET /cms/deposit-records/{id}` | ✅ | ✅ | ✅ |
| 建立儲值 | `POST /cms/deposit-records` | ✅ | ✅ |  |
| 更新狀態／備註 | `PATCH /cms/deposit-records/{id}` | ✅ |  |  |
| 匯出 CSV | **前端 client 端**（從列表 `data` 產檔，無後端端點） | ✅ | ✅ |  |

> **匯出無後端端點**：後端 OpenAPI 未提供任何 CSV / export 端點（同步或 async 皆無；見 [`06 §8`](./06-topup-records-domain.md)）。v1 由前端從「當前篩選頁的列表 `data`」在 client 端產 CSV（UTF-8 BOM），匯出鈕對 viewer 隱藏為**純 UX**——viewer 只能匯出後端已回的欄位（§3.4）。若未來需「匯出全部符合篩選結果」（跨頁）或伺服器端稽核，再評估後端專屬 export 端點。
>
> **更新狀態（PATCH）限 admin**、**建立（POST）限 admin / user**，對齊 [`06 §6A`](./06-topup-records-domain.md) / [`06 §6B`](./06-topup-records-domain.md)。viewer 對兩者皆 403。

### 4.2 CMS 使用者管理（後端 [`cms-users-api.md §2`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md) 既定）

| 操作 | 對應端點 | admin | user | viewer |
|---|---|:-:|:-:|:-:|
| 列出 CMS 使用者 | `GET /cms/users` | ✅ | ✅ | ✅ |
| 看單筆 CMS 使用者 | `GET /cms/users/{id}` | ✅ | ✅ | ✅ |
| 改別人 username / role | `PATCH /cms/users/{id}` | ✅ |  |  |
| 軟刪除 CMS 使用者 | `DELETE /cms/users/{id}` | ✅ |  |  |
| 改自己 username / password | `PATCH /cms/users/me` | ✅ | ✅ | ✅ |

> CMS 使用者管理 UI（v2）由其他規格定義；本規格只列權限矩陣作為 cross-ref 完整性。

### 4.3 規則總結

- **viewer 不可匯出**：避免「跨部門短期查閱」帳號帶走整批個資
- **viewer 看到的玩家／儲值資料 PII 欄位被遮罩**（§5 矩陣）
- **role 變更必須由 admin 操作**：後端強制（[`cms-users-api.md §4.3`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md)），無自助升級路徑

---

## 5. 可見欄位矩陣

欄位層級的「可不可以看到原值」。每格值代表後端**實際回傳的內容**：

| 欄位 | admin | user | viewer |
|---|:-:|:-:|:-:|
| `playerId` | 全 | 全 | 全 |
| `displayName` | 全 | 全 | 全 |
| `externalId` | 全 | 全 | 全 |
| `email` | 全 | 全 | 遮罩（`a***@example.com`） |
| `phone` | 全 | 全 | 遮罩（`+886***5678`） |
| `status` | 全 | 全 | 全 |
| `registeredAt` / `lastActiveAt` | 全 | 全 | 全 |
| `id` / `playerId` / `playerName`（儲值） | 全 | 全 | 全 |
| `amount` / `currency` | 全 | 全 | 全 |
| `paymentMethod` / `status` | 全 | 全 | 全 |
| `displayNote` | 全 | 全 | 全 |
| `referenceNo` | 全 | 全 | ⚠️ 全（**應遮罩，後端待辦**） |
| `internalNote` | 全 | 全 | ⚠️ 全（**應遮罩，後端待辦**） |
| `operatorId` / `operatorIp` | 全 | 全 | ⚠️ 全（**應遮罩，後端待辦**） |
| 時間欄位（`createdAt` / `updatedAt`） | 全 | 全 | 全 |

> **後端模型已無 `orderId` / `paymentChannel` / `failureReason`**：先前版本這三欄為前端推測，已隨 [`06 §2.1`](./06-topup-records-domain.md) 重整移除；本矩陣改列真實 `DepositRecord` 欄位。

**遮罩規則**（viewer 視角）：

| 欄位 | viewer 應看到（理想） | 現況 |
|---|---|---|
| `email`（玩家端點） | local-part 首字 + `***@` + 完整 domain（如 `a***@gmail.com`）；長度不暗示原長度 | 後端遮罩 |
| `phone`（玩家端點） | 國碼 + `***` + 末 4 碼（如 `+886***5678`）；空字串以 `null` 取代不暗示「沒填」 | 後端遮罩 |
| `internalNote` / `operatorId` / `operatorIp` / `referenceNo`（儲值端點） | `null`——staff 內部／金流敏感資訊，viewer 不該看 | ⚠️ **後端目前未遮罩**，viewer 取得完整原值；列為後端待辦（§11）。前端 client 匯出 v1 以「不含 `internalNote` / `operatorIp` 欄位」緩解，但非安全保證 |

**為何遮罩在後端**：

- 任何「BFF 拿到原值再遮」的設計，BFF log / 攔截器 / 開發者 console 都會看到原值——資料邊界破洞
- 後端依 JWT `role` 決定回什麼，BFF 與前端永遠拿不到不該看的內容
- 這也是為何 [`05 §6`](./05-player-query-domain.md) 強調「BFF 不二次遮罩」——遮罩只在後端發生一次

---

## 6. 前後端強制邊界

| 強制點 | 由誰執行 | 失敗時 |
|---|---|---|
| **API 端點是否可呼叫**（§4 矩陣） | 後端（`RequireRole` middleware） | 後端回 403 `forbidden` |
| **欄位是否回原值**（§5 矩陣） | 後端 | 後端在 response 回 `null` 或遮罩字串 |
| **UI 是否顯示按鈕／頁面**（UX 層） | 前端 client component | 不渲染（等同隱形） |
| **CMS 路由是否可進入**（navigation） | 前端 + 後端 | 前端在 navbar 不顯示連結；若直接貼 URL，第一支 API 呼叫遇 403 → UI 顯示 `forbidden` 錯誤態 |

**禁止**：

- **BFF 不做角色判斷再決定要不要呼叫 upstream**——這會把授權邏輯複製一份到 BFF，未來政策變動時兩處要同步改、必出 bug
- **前端不用 `role` 做欄位顯示**——前端只判斷「有沒有值」（`email != null`）。後端決定回 `null` 還是原值，前端純粹依資料 render。否則資料層與顯示層判斷不同步又是一個 bug source
- **BFF 不在 log 中印 `role`**——role 隨 JWT 來，本身不是 PII，但配合 userId 後可重建「誰看了誰」軌跡，這份軌跡屬於稽核日誌責任，不在 app log

---

## 7. 路由層保護

| 路由 | 進入條件 |
|------|---------|
| `/players` | 任一登入 CMS 使用者皆可（後端會檢查 `players.search` 端點權限） |
| `/players/[playerId]` | 同上 |
| `/players/[playerId]/topups` | 同上 |
| `/players/[playerId]/topups/[recordId]` | 同上 |

> **匯出無獨立路由**：CSV 匯出是列表頁（[`10`](./10-screen-topup-list.md)）上的 client 端按鈕（§3.4），非獨立頁面／路由；對 viewer 隱藏為純 UX。

`(cms)/layout.tsx` 已處理「未登入 → redirect /login」，本規格**不**加 layout 層的角色 guard——角色檢查交給 API 呼叫的 403 結果統一呈現。原因：

- 集中授權判斷於後端，前端零判斷重複
- 角色變更後（如新增 role）前端無需改 guard 邏輯
- 直接訪問無權頁面時的「forbidden 錯誤態」UX 統一（各 screen 規格的 ErrorState `forbidden` variant）

---

## 8. 稽核事件

### 8.1 由誰寫

**全部由後端寫**。BFF / 前端**不**寫稽核——它們不在合規可信邊界內。

BFF 的責任只有「把足以識別操作者的 context 透傳給後端」：

- `Authorization: Bearer <jwt>` → 後端解 claims 取 `userId / role`
- `X-Request-ID` → 後端用以串接同一筆操作的所有 log 與稽核

### 8.2 既有 auth 事件（後端 `pkg/audit/audit.go` 既定）

後端目前已實作的稽核事件常數（**字串值為後端權威來源**）：

| 後端常數 | event 字串 | 觸發點 |
|---|---|---|
| `EventRegisterSuccess` | `auth.register_success` | `/auth/register` 成功 |
| `EventRegisterFailed` | `auth.register_failed` | `/auth/register` 失敗（weak_password / username_taken / invalid_client） |
| `EventLoginSuccess` | `auth.login_success` | `/auth/login` 成功 |
| `EventLoginFailed` | `auth.login_failed` | `/auth/login` 失敗 |
| `EventTokenRotated` | `auth.token_rotated` | `/auth/refresh` 成功 rotation |
| `EventReplayDetected` | `auth.replay_detected` | refresh token 重放偵測；⚠️ 觸發告警 |
| `EventLogout` | `auth.logout` | `/auth/logout` |
| `EventSessionRevoked` | `auth.session_revoked` | `/auth/sessions/{fid}` DELETE |
| `EventRevokeAll` | `auth.revoke_all` | `/auth/sessions/revoke-all` |

> **以後端常數為準**：若稽核 event 字串有歧義（如「`auth.register_success`」vs「`cms_user.created`」），以 `pkg/audit/audit.go` 實際匯出的常數為單一可信來源。本規格的中文描述只是參考。

### 8.3 業務事件清單（玩家儲值查詢，**待後端實作**）

本工具的查詢／匯出事件**尚未在後端實作**——後端 `pkg/audit/audit.go` 目前只有 §8.2 列的 auth 類事件。下表為**對後端的要求**，落地時應在後端規格與 `audit.go` 同步新增：

| 建議 event 字串 | 觸發點 | 紀錄欄位（最少集） |
|---|---|---|
| `players.search` | 後端在 `GET /cms/players` 成功回應時 | `userId, role, query, result_count, request_id, ip, occurred_at` |
| `players.read` | 後端在 `GET /cms/players/{id}` 成功回應時 | `userId, role, target_player_id, request_id, occurred_at` |
| `topups.list` | `GET /cms/deposit-records` 成功回應時 | `userId, role, target_player_id, filters, result_count, request_id, occurred_at` |
| `topups.read` | `GET /cms/deposit-records/{id}` 成功回應時 | `userId, role, record_id, request_id, occurred_at` |
| `topups.summary` | `GET /cms/players/{id}/topup-summary` 成功回應時 | `userId, role, target_player_id, request_id, occurred_at` |

> **為何 query / filters 也記**：稽核需回答「2026-06-28 14:00 誰對玩家 A 做了什麼條件的搜尋」；只記 `result_count` 無法重建調查上下文。
>
> **`role` 欄位拿單值字串**（對齊 §3 single role 設計），不要寫陣列。
>
> **CSV 匯出無獨立稽核事件（v1）**：匯出是前端 client 端對「已取得的列表 `data`」產檔（§3.4），後端**看不到**這個動作，故無 `topups.export.*` 事件——但底層那次 `GET /cms/deposit-records`（`topups.list`）本來就被稽核，已能回答「誰在何時看了哪些紀錄」。若未來需獨立記錄匯出意圖／列數／檔案大小，須改走後端 export 端點，屆時再新增 `topups.export.request` / `topups.export.complete`（含 `filters, format, row_count, file_size_bytes`）。

### 8.4 不記的事件

- **失敗的請求**（4xx / 5xx）——失敗未實際看到資料，記之意義有限；惟 403 `forbidden` 後端可選擇記為「越權嘗試」（建議記，本規格不強制）
- **未認證請求**（401）——尚未識別操作者，記無意義
- **前端 client 端 CSV 匯出**——不經後端，後端無從記錄；底層列表查詢（`topups.list`）已稽核（見 §8.3）

### 8.5 儲存

- **與 app log 物理隔離**：後端使用 CloudWatch Logs 專屬 group（如 `/cms/audit`）或 DynamoDB；不寫進 app log group
- **保留 ≥ 1 年**（與合規對齊，由後端決定）
- **不可刪改**：採 append-only；管理員介面（v2）只可查詢，不可修改

> 儲存細節屬後端規格範圍；本規格只定義「BFF / 前端對稽核的期待」。後端規格須單獨描述 schema / retention / 查詢 API。

---

## 9. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`02-auth-session.md`](./02-auth-session.md) | `role` 來自 access token claims；ClientSession 擴充欄位（§3.3） |
| [`03-observability.md`](./03-observability.md) | app log redact 規則包含 `email` / `phone`，避免遮罩前的值落入 app log；`role` 不入 app log |
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 玩家欄位可見性矩陣（§5）；BFF 不二次遮罩 |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 儲值欄位可見性、匯出權限與稽核事件（§8） |
| [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md) / [`10`](./10-screen-topup-list.md) / [`11`](./11-screen-topup-detail.md) | 各 screen 的 ErrorState `forbidden` variant、按鈕條件顯示 |
| [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md) | 註冊預設 role = `user`（不是空 role）；§2 角色與 cms-users-api.md §2 矩陣對齊 |
| 後端 [`cms-users-api.md`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md) | role 與權限矩陣的單一可信來源（CMS users CRUD） |
| 後端 [`infrastructure.md §8.4`](../../PlayerLedgerBackend/docs/specs/infrastructure.md) | role enum 定義 |
| 後端 [`pkg/audit/audit.go`](../../PlayerLedgerBackend/pkg/audit/audit.go) | 稽核 EventType 常數定義 |

---

## 10. 測試清單（TDD）

### 10.1 `src/lib/auth/decode-token.test.ts`

```ts
it('should decode userId, userType, role, familyId, exp from valid JWT payload')
it('should map utype="cms" / role="admin" to TokenClaims correctly')
it('should accept all 4 role values (admin / user / viewer / member)')
it('should throw when role claim is not one of the 4 enum values')
it('should NOT verify signature (decode-only)')
it('should throw when token is not three base64url segments')
it('should throw when payload is not valid JSON')
```

### 10.2 `src/lib/session/client-session.test.tsx`（擴充 spec 02 §9 既有測試）

```ts
it('should include role string in ClientSession value')
it('should reject session whose decoded role is "member" (BFF should redirect to login before this)')
it('should never include accessToken / refreshToken / sid in value')   // 同 spec 02
```

### 10.3 角色感知 UI（在各 screen test 中執行）

```ts
// @/components/topups/export-button.test.tsx（提升為共用；spec 10 / 14 共用，client 端匯出，角色顯隱）
it('should render Export button when session.role is "admin"')
it('should render Export button when session.role is "user"')
it('should NOT render Export button when session.role is "viewer"')
it('should generate a CSV download from the provided records on click')
```

> CSV 產生純函式的測試（BOM / 跳脫 / 欄位選擇 / 金額整數原值）見 [`06 §11.7`](./06-topup-records-domain.md) `export-csv.test.ts`。
>
> 注意 §6 原則：UI 元件**不**依 `session.role` 決定欄位顯示——資料層由後端控制 `null` vs 原值，元件純看資料。`ExportButton` 是例外（決定「按鈕是否渲染」，非「資料是否顯示」），且其匯出來源僅限後端已回的 `data`。
>
> 先前的 `payment-channel.test.tsx` 已移除——`paymentChannel` 欄位不在後端模型（[`06 §2.1`](./06-topup-records-domain.md)）。

### 10.4 端到端 forbidden 流程（Playwright）

```ts
test('viewer role sees no Export button on topup list')
test('user role sees Export button and clicking downloads a CSV of the current page')
test('admin role sees Export button and clicking downloads a CSV of the current page')
test('viewer directly hitting a no-permission action (e.g. create) sees forbidden ErrorState')
```

> 匯出無後端端點，故原「直接打 export URL 見 forbidden」的 e2e 已移除；改驗按鈕顯隱與 client 端下載。

### 10.5 不在本規格的測試

- 稽核事件實際落地驗證 → 後端規格
- 後端 403 拒絕端點呼叫 → 後端規格
- 欄位遮罩內容 → 後端規格（如「`a***@gmail.com` 不暗示 local-part 長度」）

---

## 11. 開放問題

> 與 PM / 安全團隊對齊後更新：

- [ ] 越權嘗試（後端拒絕 403 的請求）是否寫稽核？建議是，但需確認儲存量
- [x] **CSV 匯出對 viewer**：v1 採前端 client 端匯出「當前篩選頁的螢幕可見欄位」，匯出鈕對 viewer 隱藏（純 UX）；不含 `internalNote` / `operatorIp`。未做「匯出全部符合篩選」（跨頁）與伺服器端稽核——待需求出現再評估後端 export 端點
- [ ] ⚠️ **後端對 viewer 遮罩 deposit-records 敏感欄位**：已確認後端目前**未**對 viewer 遮罩 `internalNote` / `operatorIp` / `referenceNo`，viewer 取得完整原值（§5）。需後端依 role 遮罩——這才是真正的安全邊界，前端 client 匯出的欄位選擇只是緩解
- [ ] viewer 看到遮罩資料時，UI 是否需特別標示「您目前以 viewer 身份檢視」banner？v1 不做；若 PM 要求，加 client-side banner（純 UX，不影響資料層）
- [ ] `decodeAccessToken` 不驗簽是否需 ADR 記錄理由？建議是（avoid future surprise）
- [ ] 後端業務事件（§8.3）落地時程？需與後端 owner 對齊；落地時更新本表並刪除「待後端實作」字樣
- [ ] 引入 `user_finance` / `user_support` 等更細分 role 的條件？v1 不分，等業務證明需要時再加 enum 值（同步更新後端 role.go + 本規格 §2 / §4 / §5）
