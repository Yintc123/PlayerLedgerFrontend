# CMS 帳號註冊業務邏輯規格書

## 1. 概覽

本文件定義 CMS 後台「帳號註冊」功能的**業務邏輯層**——政策、資料模型、API 契約、error code 對應、驗證職責劃分、稽核。畫面層規格見 [`13-screen-register.md`](./13-screen-register.md)。

範圍：

- 註冊政策（公開自助、預設零角色）
- 資料模型與 request / response 形狀
- proxy.ts 對 `/register`（UI route）與 `/api/register`（API route）的處理
- 後端 error code → 繁中顯示文案的對應規則
- Client vs Server 驗證職責劃分
- Rate limit 設定（cross-ref [`02 §6.3`](./02-auth-session.md#63-rate-limiting)）
- RBAC 互動（cross-ref [`07`](./07-admin-rbac-audit.md)）
- 稽核事件（**新增** `user.register`，需更新 [`07 §8`](./07-admin-rbac-audit.md)）
- TDD 測試清單

**不在本文件範圍**：

- BFF 端的 `/api/register` passthrough 機制細節（路徑映射、header 注入、`client_id` 注入、route handler 行為）——見 [`02-auth-session.md` §3.6](./02-auth-session.md#36-註冊端點passthrough)，本規格不重複
- UI / 表單 / 互動 / a11y——見 [`13`](./13-screen-register.md)
- email 驗證、invite token、CAPTCHA——見 §10 開放問題

### 核心原則

- **公開自助註冊**：任何訪客可建立帳號；不需要 session。
- **註冊 ≠ 授權**：新建帳號預設**零角色**，所有業務 API 全 403（[`07 §2`](./07-admin-rbac-audit.md)）；admin 須另外指派角色才能存取資料。
- **註冊成功不簽 token**（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)）：UI 走「成功 → redirect `/login?registered=true` → 使用者手動登入」流程。
- **後端是 source of truth**：所有驗證（密碼強度、username 唯一、長度限制）以後端結果為準；BFF 與 client 都不重複驗證邏輯。
- **error code 對應集中本規格**：所有 error code → 顯示文案的 mapping 由 §4 維護，UI 與其他 client 共用，避免硬編 enum 散落多處。

---

## 2. 註冊政策與資料模型

### 2.1 註冊請求

```ts
// Browser → BFF: POST /api/register
type RegisterRequest = {
  username: string    // 必填，trim 後 length ≥ 1（其餘規則由後端）
  password: string    // 必填，後端決定強度規則
}
```

BFF 透傳到後端時**注入 `client_id`**（從 `CLIENT_ID` env，預設 `cms-web`），詳見 [`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)。

> **不接受 `confirmPassword` 欄位**：純 client 端 UX 概念（[`13 §6.1`](./13-screen-register.md#6-表單行為)），BFF 與後端皆不應收到。若 client 誤送，BFF 透傳；後端 OpenAPI 沒定義此欄位，會視為未知欄位忽略。
>
> **不接受 `client_id` 欄位**：browser 送出的 `client_id` 由 BFF 攔截並覆寫為 env 值（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)），避免繞過政策。

### 2.2 註冊成功 response

```
HTTP 201 Created
（無 body，per 後端 OpenAPI）
```

或者後端可能回 200 OK + JSON body（取決於 OpenAPI 定義，待 §10 確認）。本規格與 [`13`](./13-screen-register.md) **同時接受 200 / 201** 作為成功狀態。

### 2.3 註冊失敗 response

依 [`02 §1 envelope 規格`](./02-auth-session.md#1-概覽)：

```json
{
  "success": false,
  "request_id": "...",
  "error": "<code>",
  "details": [...]
}
```

`error` 字串可能是 snake_case 或空白分隔形式（[`02 §1 後端 error code 字串格式不一致`](./02-auth-session.md#1-概覽)）。client 端比對前必須走 `normalizeErrorCode(s) = s.replace(/\s+/g, '_').toLowerCase()`。

### 2.4 預設角色：零

新建帳號**沒有任何角色**（[`07 §2`](./07-admin-rbac-audit.md)）：

- 登入成功 → 拿到有效 session
- 業務 API 全 403 `forbidden`（後端驗證 roles 為 empty）
- CMS 頁面進得去（layout 只檢 session）但所有資料 API 全 403
- 使用者看到一連串 `ForbiddenState`（各 screen 規格的 `forbidden` variant）

> **這是設計**：公開自助註冊 + 預設零角色 + admin 後續授權 = 比「邀請制」實作成本低、比「自助即可用」安全。
>
> **若後端 OpenAPI** 為 `/auth/register` 提供 `defaultRole` 參數，**禁止前端在 UI 層暴露**——任何「自選角色」設計等於擺爛，必須移除。BFF 也不應送 `defaultRole`。

---

## 3. proxy.ts 路由規則

### 3.1 PUBLIC_PATHS

`/register`（UI route）與 `/api/register`（API route）皆須加入 `proxy.ts` 的 `PUBLIC_PATHS`：

```ts
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/register',          // ← 本規格新增（UI route）
  '/api/login',
  '/api/logout',
  '/api/register',      // ← spec 02 §3.6 既有（API route）
  // ...
])
```

`/api/register` 在 [`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough) 已有；本規格新增 `/register`（UI route）。

### 3.2 CSRF Origin check

`/api/register` 為 state-changing POST → 走 proxy.ts CSRF Origin check（[ADR 013](../adr/013-csrf-defense-strategy.md)），同源 Origin 才允許。Browser 同源送出無需特別處理；非瀏覽器 client（curl / Postman 等）必須帶 Origin。

### 3.3 Rate limit

| 端點 | key | limit | fail behavior |
|------|-----|-------|--------------|
| `POST /api/register` | `register:<clientIp>` | 5/min | **fail-closed 503**（同 login 邏輯；高價值寫入） |
| `GET /register`（UI） | — | 100/min（public path 預設） | fail-open |

`/api/register` 規格由 [`02 §6.3`](./02-auth-session.md#63-rate-limiting) 既有定義；本規格不變。`/register` UI 走 public path 預設限流（與 `/login` 同），無需額外設定。

---

## 4. 後端 error code 對應與顯示文案

依 [`02 §1 後端 error code 字串格式不一致`](./02-auth-session.md#1-概覽) 規則用 `normalizeErrorCode` 比對。

| HTTP | normalized error code | 顯示文案（繁中） | 備註 |
|------|----------------------|----------------|------|
| 400 | `invalid_input`、`invalid_client`、`validation_error` | 透傳 `data.message`；若無 message → fallback `輸入格式不正確` | 含空白形式 `"invalid input"`、`"validation_error"` |
| 409 | `username_taken` | `此帳號已被使用，請換一個` | 含空白形式 `"username taken"` |
| 422 | `weak_password` | `密碼強度不足，請使用更強的密碼` | 後端強度規則為 source of truth；本對應只負責文案 |
| 422 | `use_logout_instead` | `您已登入，請先登出再註冊` | 已登入使用者誤打 `/api/register` 時觸發 |
| 429 | `too_many_requests` | `操作過於頻繁，請稍後再試` | 須讀 `Retry-After` header（[`02 §6.3`](./02-auth-session.md#63-rate-limiting)） |
| 5xx | （任意） | `服務暫時無法使用，請稍後再試` | 不暴露後端錯誤細節 |
| 其他 4xx | （未列） | 透傳 `data.message`；若無 → `建立帳號失敗` | 後端新增 code 不需改 client |

**實作原則**：

- client 端用 `switch (normalizeErrorCode(data.error))` 比對；**default branch 透傳 `data.message`**，未知 code 不擋
- 對應表本規格維護；UI ([`13`](./13-screen-register.md)) 與其他 client（CLI / admin tool）共用此邏輯
- 文案以「使用者可採取行動」為主，不暴露技術細節（如不顯示 `invalid_client` 給使用者）

---

## 5. Client / Server 驗證職責劃分

| 驗證項目 | Client 端 UX | Server（後端） | 理由 |
|---------|-------------|---------------|------|
| `username` 必填 | `required` HTML attr | 必檢，回 `invalid_input` | client UX 防手誤；server 防繞過 |
| `username` 是否已存在 | **不檢**（無 `/exists` 端點） | 必檢，回 `username_taken` | 沒有預檢端點；唯一性只能由 server 把關 |
| `username` 為 email 格式 | **不檢** | **不檢**（[`02 §11.2`](./02-auth-session.md#112-username-接受-email-格式)） | username 接受非 email 字串 |
| `password` 必填 | `required` HTML attr | 必檢 | 同上 |
| `password` length ≥ 8 | UX 提示（input 加 `minLength={8}`） | 必檢，回 `weak_password` | client 提示防手誤；強度規則仍以 server 為準 |
| `password` 強度（字元類別、blocklist） | **不檢** | 必檢，回 `weak_password` | server 是唯一可信來源 |
| confirm password === password | client 端攔截，**不打 API** | **不接收** confirmPassword 欄位 | 純 UX 概念 |

> **禁止**：client 端做「username 是否包含特殊字元」「password 必含大小寫數字」這類重複後端的邏輯。任何此類規則只能在 server，避免兩處維護同一規則造成不一致。

---

## 6. 測試清單（TDD）

### 6.1 proxy.ts（擴充 [`02 §9 proxy.ts 測試`](./02-auth-session.md#proxyts-測試vitest)）

```ts
it('should allow unauthenticated GET /register (PUBLIC_PATHS)')
it('should NOT redirect /register to /login')
it('should apply CSRF Origin check on POST /api/register (state-changing)')
it('should apply rate limit register:<ip> 5/min on POST /api/register')   // 既存於 spec 02
```

### 6.2 `/api/register` route handler（既存於 [`02 §3.6 測試`](./02-auth-session.md#測試補入-9-2)）

本規格不重複，僅補強：

```ts
it('should pass through 200 OR 201 as success to browser unchanged')
it('should pass through 409 username_taken / 422 weak_password / 422 use_logout_instead bodies unchanged')
```

### 6.3 normalizeErrorCode 對應（共用 helper）

`normalizeErrorCode()` 已在 [`02 §1`](./02-auth-session.md#1-概覽) 定義；本規格驗證它應用於本表：

```ts
// src/lib/auth/register-errors.test.ts （或 inline 於 register page test）
it('should map "username_taken" to "此帳號已被使用，請換一個"')
it('should map "username taken" (space-form) to same message')
it('should map "weak_password" to "密碼強度不足，請使用更強的密碼"')
it('should map "use_logout_instead" to "您已登入，請先登出再註冊"')
it('should map "too_many_requests" to "操作過於頻繁，請稍後再試"')
it('should fall back to data.message when error code is unknown')
it('should fall back to "建立帳號失敗" when both code and message are absent')
```

> 若選擇在 register page 內部處理（不抽 lib），測試寫進 [`13 §12.1`](./13-screen-register.md#121-srcappauthregisterpagetesttsx)。若抽成共用 helper（如 `src/lib/auth/register-errors.ts`），測試獨立檔案。本規格不強制——以實作便利為主。

### 6.4 不在本規格的測試

- UI 渲染、表單互動、loading / error 視覺、a11y → [`13 §12`](./13-screen-register.md#12-測試清單tdd)
- 後端 `/auth/register` 行為（強度規則、duplicate detection、audit log 落地） → 後端規格

---

## 7. 稽核事件

[`07 §8`](./07-admin-rbac-audit.md) 稽核事件清單**目前不含 `user.register`**——本規格落地時須補上：

| event | 觸發點 | 紀錄欄位（最少集） |
|-------|--------|------------------|
| `user.register` | 後端 `/auth/register` 成功回應（201 / 200）時 | `ip, userId (新建後), username, request_id, occurred_at` |

由後端寫入（[`07 §8.1`](./07-admin-rbac-audit.md) 原則：BFF / 前端不寫稽核）。BFF 責任只是把 client IP 與 X-Request-ID 透傳，讓後端能組事件。

> **追蹤項目**：實作時須同步更新 [`07 §8.2`](./07-admin-rbac-audit.md) 表格加上此事件，且後端 spec 對應端點要列入 audit log 寫入義務。

---

## 8. RBAC 互動

| 場景 | 行為 |
|------|------|
| 註冊成功 → 登入 → 訪問 `/players` | layout 通過（有 session）；資料 API 全 403（roles=[]） |
| 註冊成功 → 登入 → 訪問 `/dashboard` | layout 通過；dashboard 內容如僅顯示「歡迎」之類靜態文字 → 看得到；如要 fetch 資料 → 403 |
| admin 後續指派角色 | 取決於 v2「角色管理 UI」；本規格不涵蓋 |

> **新註冊使用者看到的「一連串 403」可能造成困惑**：UX 上可考慮在零角色 session 登入後顯示 onboarding 提示（「請聯絡管理員指派權限」）。**v1 不做**；列入 [`07 §11`](./07-admin-rbac-audit.md) 開放問題追蹤。

---

## 9. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | `/api/register` 走 BFF proxy；rate limit / CSRF 在 proxy.ts |
| [`02-auth-session.md`](./02-auth-session.md) §3.6 | 既有 passthrough 機制；本規格在其上加業務政策層 |
| [`02-auth-session.md`](./02-auth-session.md) §6.3 | rate limit `register:<ip>` 5/min |
| [`02-auth-session.md`](./02-auth-session.md) §1 | envelope 規格、`normalizeErrorCode` |
| [`03-observability.md`](./03-observability.md) | metric：`auth.register.attempt{outcome=success\|error_code}`；error code 採 normalize 後字串 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) §2 | 新註冊預設零角色 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) §8 | **須新增** `user.register` 稽核事件 |
| [`13-screen-register.md`](./13-screen-register.md) | UI 層；本規格的 error code 對應供 §13 UI 使用 |
| [ADR 013](../adr/013-csrf-defense-strategy.md) | `/api/register` POST 受 CSRF Origin check |

---

## 10. 開放問題

> 實作前須與後端 / PM 對齊：

- [ ] **後端 `/auth/register` 確切 response shape**：是 `201 + 無 body`、`200 + JSON envelope`、或都接受？影響 [`13 §6.1`](./13-screen-register.md#6-表單行為) 成功判斷
- [ ] **後端密碼強度規則**：v1 client 端只擋 length < 8（純 UX），後端 `weak_password` 為唯一可信來源；後端確切規則（字元類別、common password blocklist）由後端 spec 維護
- [ ] **email 驗證**：v1 不做；確認後端 `/auth/register` 是否啟用 email verification flow（影響 success path：可能需先顯示「請收信」而非直接導 login）
- [ ] **CAPTCHA / bot 防護**：v1 不做；若上線後出現量級註冊濫用，再評估 reCAPTCHA v3 / Turnstile
- [ ] **`/api/register` rate limit 上限**：[`02 §6.3`](./02-auth-session.md#63-rate-limiting) 規定 IP 5/min；UI 是否需顯示「剩餘嘗試次數」？v1 不做，超限直接走 429 alert
- [ ] **`auth.register.attempt` metric tag 結構**：[`03-observability.md`](./03-observability.md) 需補定義；v1 落地時同步更新
- [ ] **零角色使用者的 onboarding 提示**：v1 直接顯示一連串 403，UX 不友善；列入 [`07`](./07-admin-rbac-audit.md) 開放問題
- [ ] **`user.register` 稽核事件**：實作時須在 [`07 §8.2`](./07-admin-rbac-audit.md) 表格加入此事件
