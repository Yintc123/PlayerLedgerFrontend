# CMS 帳號註冊業務邏輯規格書

## 1. 概覽

本文件定義 CMS 後台「帳號註冊」功能的**業務邏輯層**——政策、資料模型、API 契約、error code 對應、驗證職責劃分、稽核。畫面層規格見 [`13-screen-register.md`](./13-screen-register.md)。

範圍：

- 註冊政策（公開自助、預設 `user` role）
- 資料模型與 request / response 形狀
- proxy.ts 對 `/register`（UI route）與 `/api/register`（API route）的處理
- 後端 error code → 繁中顯示文案的對應規則
- Client vs Server 驗證職責劃分
- Rate limit 設定（cross-ref [`02 §6.3`](./02-auth-session.md#63-rate-limiting)）
- RBAC 互動（cross-ref [`07`](./07-admin-rbac-audit.md)）
- 稽核事件（後端 `auth.register_success`，[`07 §8.2`](./07-admin-rbac-audit.md) 已列）
- TDD 測試清單

> **對齊後端**：本規格的 API 契約、密碼規則、預設 role、稽核事件名稱均以 PlayerLedgerBackend 的 `schema/openapi.yaml`、`internal/service/auth_service.go`、`pkg/audit/audit.go` 為**單一可信來源**。後端調整時須同步更新本文件。

**不在本文件範圍**：

- BFF 端的 `/api/register` passthrough 機制細節（路徑映射、header 注入、`client_id` 注入、route handler 行為）——見 [`02-auth-session.md` §3.6](./02-auth-session.md#36-註冊端點passthrough)
- UI / 表單 / 互動 / a11y——見 [`13`](./13-screen-register.md)
- email 驗證、invite token、CAPTCHA——見 §10 開放問題

### 核心原則

- **公開自助註冊**：任何訪客可建立帳號；不需要 session。
- **註冊後預設 `user` role**：後端 `auth_service.Register` 寫死 `Role: string(jwt.RoleUser)`（`internal/service/auth_service.go:162`）。`user` role 在 [`07 §4`](./07-admin-rbac-audit.md) 矩陣下能讀全部玩家／儲值資料、可匯出，**不可**管理 CMS 使用者。
- **註冊成功不簽 token**（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)）：UI 走「成功 → redirect `/login?registered=true` → 使用者手動登入」流程。
- **後端是 source of truth**：所有驗證（密碼強度、username 唯一、長度限制）以後端結果為準；BFF 與 client 都不重複驗證邏輯。
- **error code 對應集中本規格**：所有 error code → 顯示文案的 mapping 由 §4 維護，UI 與其他 client 共用，避免硬編 enum 散落多處。

---

## 2. 註冊政策與資料模型

### 2.1 註冊請求

依後端 `schema/openapi.yaml` 對 `POST /auth/register` 的定義：

```ts
// Browser → BFF: POST /api/register
type RegisterRequest = {
  username: string    // 必填，後端 minLength: 3, maxLength: 64
  password: string    // 必填，後端 minLength: 8, maxLength: 256；§5 強度規則
}
```

BFF 透傳到後端時**注入 `client_id: "cms-web"`**（從 `CLIENT_ID` env），詳見 [`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)。

> **不接受 `confirmPassword` 欄位**：純 client 端 UX 概念（[`13 §6.1`](./13-screen-register.md#6-表單行為)），BFF 與後端皆不應收到。若 client 誤送，BFF 透傳；後端 OpenAPI 沒定義此欄位，會視為未知欄位忽略。
>
> **不接受 `client_id` 欄位**：browser 送出的 `client_id` 由 BFF 攔截並覆寫為 env 值（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough)），避免繞過政策。後端只接受 `client_id == "cms-web"`，其他值（如 `public-web` / `ios-app`）一律回 400 `invalid_client`。

### 2.2 註冊成功 response

後端 OpenAPI 明確定義：

```
HTTP 201 Created
（無 body）
```

UI 端據此判斷成功（[`13 §6.1`](./13-screen-register.md#6-表單行為)）；理論上不會出現 200——但 client 處理應寬鬆接受 `200 / 201` 皆視為成功，避免後端微調 status code 時 UI 破裂。

### 2.3 註冊失敗 response

依 [`02 §1 envelope 規格`](./02-auth-session.md#1-概覽) 與後端 `infrastructure.md §10.2`：

```json
{
  "success": false,
  "request_id": "...",
  "error": "<code>",
  "details": [...]
}
```

`error` 字串可能是 snake_case（如 `weak_password`、`username_taken`、`invalid_client`）或空白分隔形式（如 `invalid input`、`too many requests`）——後端 [`infrastructure.md §12.4 錯誤對應總表`](../../PlayerLedgerBackend/docs/specs/infrastructure.md)。client 端比對前必須走 `normalizeErrorCode(s) = s.replace(/\s+/g, '_').toLowerCase()`。

### 2.4 預設角色：`user`

後端 `internal/service/auth_service.go:162` 寫死：

```go
user := &model.CMSUser{
    Username:     in.Username,
    PasswordHash: hash,
    Role:         string(jwt.RoleUser),   // ← 預設 "user"
}
```

依 [`07 §2`](./07-admin-rbac-audit.md) 與 [`cms-users-api.md §2`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md)，`user` role 的能力：

| 場景 | 行為 |
|------|------|
| 登入成功 → 拿到有效 session | ✅ |
| 看 `/cms/users` 列表 / 單筆 | ✅（user 可讀）|
| 看玩家／儲值資料 | ✅（[`07 §4.1`](./07-admin-rbac-audit.md) user 全部 ✅，含匯出）|
| 改別人的 username / role | ❌（403，admin only）|
| 改自己的 username / password | ✅（`PATCH /cms/users/me`，[`cms-users-api.md §4.5`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md)）|

> **為何不採「預設零角色」**：曾考慮但與後端不符——後端 `auth_service.Register` 直接寫死 `user`。若需要「邀請制」（admin 預核才能用）必須改後端 service 並加 OpenAPI 欄位。v1 維持後端現狀，避免雙邊不一致。
>
> **升級為 admin / 降級為 viewer**：admin 走 [`cms-users-api.md §4.3`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md) `PATCH /cms/users/{id}`；唯一晉升路徑。前端**禁止**在 register UI 暴露任何「角色選擇」欄位，後端 OpenAPI 也未定義此欄位。

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

依後端 `schema/openapi.yaml` `/auth/register` `responses` 與 `infrastructure.md §3.5.4` 錯誤碼對應表，`/auth/register` 可能的 error 字串為：

| HTTP | normalized error code | 顯示文案（繁中） | 來源 / 備註 |
|------|----------------------|----------------|-----------|
| 400 | `invalid_input` | 透傳 `data.message`；若無 message → fallback `輸入格式不正確` | 含空白形式 `"invalid input"`（後端 `infrastructure.md §12.4`） |
| 400 | `invalid_client` | `服務設定錯誤，請聯絡管理員` | 後端 `client_id != "cms-web"` 時觸發；BFF 注入正確 client_id 後**正常不會發生**；若發生代表 BFF 設定有誤 |
| 409 | `username_taken` | `此帳號已被使用，請換一個` | 後端 `apperr.ErrUsernameTaken` |
| 422 | `weak_password` | `密碼強度不足；需至少 8 字元且同時含字母與數字` | 後端 §5 規則；文案直接揭示規則，使用者可立即修正 |
| 429 | `too_many_requests` | `操作過於頻繁，請稍後再試` | 含空白形式 `"too many requests"`；須讀 `Retry-After` header |
| 5xx | （任意） | `服務暫時無法使用，請稍後再試` | 不暴露後端錯誤細節 |
| 其他 4xx | （未列） | 透傳 `data.message`；若無 → `建立帳號失敗` | 後端新增 code 不需改 client |

> **後端 `/auth/register` 確實的 error 清單**（`infrastructure.md §3.5.4`）：`invalid input` / `invalid_client` / `username_taken` / `weak_password` / `too many requests`——本表已完整覆蓋。
>
> **注意**：早期版本曾納入 `use_logout_instead`，**錯誤**——後端 `/auth/register` 不會回此 code；它只出現在 `DELETE /auth/sessions/{fid}`（嘗試撤自己當前 family）。

**實作原則**：

- client 端用 `switch (normalizeErrorCode(data.error))` 比對；**default branch 透傳 `data.message`**，未知 code 不擋
- 對應表本規格維護；UI ([`13`](./13-screen-register.md)) 與其他 client（CLI / admin tool）共用此邏輯
- 文案以「使用者可採取行動」為主，不暴露技術細節（如不顯示 `invalid_client` 給使用者；以「服務設定錯誤」帶過）

---

## 5. Client / Server 驗證職責劃分

後端密碼規則（`internal/service/auth_service.go:126-134` 與 `infrastructure.md §8.9`）：

```
len(password) ≥ 8  且  含字母  且  含數字
```

對應職責劃分：

| 驗證項目 | Client 端 UX | Server（後端） | 理由 |
|---------|-------------|---------------|------|
| `username` 必填 | `required` HTML attr | 必檢，回 `invalid_input` | client UX 防手誤；server 防繞過 |
| `username` 長度 3–64 | `minLength={3}`、`maxLength={64}` 屬性 | 必檢，回 `invalid_input` | 對齊後端 OpenAPI `minLength: 3, maxLength: 64` |
| `username` 是否已存在 | **不檢**（無 `/exists` 端點） | 必檢，回 `username_taken` | 沒有預檢端點；唯一性只能由 server 把關 |
| `username` 為 email 格式 | **不檢** | **不檢**（[`02 §11.2`](./02-auth-session.md#112-username-接受-email-格式)） | username 接受非 email 字串 |
| `password` 必填 | `required` HTML attr | 必檢 | 同上 |
| `password` 長度 8–256 | `minLength={8}`、`maxLength={256}` 屬性 | 必檢，回 `weak_password` | 對齊後端 OpenAPI |
| `password` 含字母+數字 | UX 提示文字「至少 8 字元，需含字母與數字」 | 必檢，回 `weak_password` | server 是強度規則的唯一可信來源；UX 提示降低使用者撞牆機率 |
| `password` 複雜度（特殊字元、blocklist） | **不檢** | **不檢**（demo 階段刻意寬鬆，`infrastructure.md §8.9`） | 未來改規則只動後端 |
| confirm password === password | client 端攔截，**不打 API** | **不接收** confirmPassword 欄位 | 純 UX 概念 |

> **禁止**：client 端做「username 是否包含特殊字元」「password 必含大小寫」「password 不能含 username」等重複後端的邏輯。任何此類規則只能在 server，避免兩處維護同一規則造成不一致。

---

## 6. 測試清單（TDD）

### 6.1 proxy.ts（擴充 [`02 §9 proxy.ts 測試`](./02-auth-session.md#proxyts-測試vitest)）

```ts
it('should allow unauthenticated GET /register (PUBLIC_PATHS)')
it('should NOT redirect /register to /login')
it('should apply CSRF Origin check on POST /api/register (state-changing)')
it('should apply rate limit register:<ip> 5/min on POST /api/register')   // 既存於 spec 02
```

### 6.2 `/api/register` route handler（擴充 [`02 §3.6 測試`](./02-auth-session.md#測試補入-9-2)）

本規格不重複，僅補強：

```ts
it('should pass through 201 (no body) as success to browser unchanged')
it('should pass through 400 invalid_client / 409 username_taken / 422 weak_password bodies unchanged')
it('should NOT pass through use_logout_instead (this code does not apply to /auth/register)')
```

### 6.3 normalizeErrorCode 對應（共用 helper）

`normalizeErrorCode()` 已在 [`02 §1`](./02-auth-session.md#1-概覽) 定義；本規格驗證它應用於本表：

```ts
// src/lib/auth/register-errors.test.ts （或 inline 於 register page test）
it('should map "username_taken" to "此帳號已被使用，請換一個"')
it('should map "username taken" (space-form) to same message via normalizeErrorCode')
it('should map "weak_password" to "密碼強度不足；需至少 8 字元且同時含字母與數字"')
it('should map "invalid_client" to "服務設定錯誤，請聯絡管理員"')
it('should map "too_many_requests" to "操作過於頻繁，請稍後再試"')
it('should map "too many requests" (space-form) to same message')
it('should fall back to data.message when error code is unknown')
it('should fall back to "建立帳號失敗" when both code and message are absent')
```

> 若選擇在 register page 內部處理（不抽 lib），測試寫進 [`13 §12.1`](./13-screen-register.md#121-srcappauthregisterpagetesttsx)。若抽成共用 helper（如 `src/lib/auth/register-errors.ts`），測試獨立檔案。本規格不強制——以實作便利為主。

### 6.4 不在本規格的測試

- UI 渲染、表單互動、loading / error 視覺、a11y → [`13 §12`](./13-screen-register.md#12-測試清單tdd)
- 後端 `/auth/register` 行為（強度規則、duplicate detection、audit log 落地） → 後端規格

---

## 7. 稽核事件

註冊事件由後端 `auth_service.Register` 在 `internal/service/auth_service.go:177` 寫入：

| 後端常數 | event 字串 | 觸發 |
|---|---|---|
| `audit.EventRegisterSuccess` | `auth.register_success` | Register 成功（user 已 INSERT、role=user）|
| `audit.EventRegisterFailed` | `auth.register_failed` | Register 失敗（`weak_password` / `username_taken` / `invalid_client`） |

兩個事件**已存在於後端** `pkg/audit/audit.go`，本規格不需後端新增任何事件。事件欄位由後端 [`AuthEvent`](../../PlayerLedgerBackend/pkg/audit/audit.go) 結構決定（含 `ClientID`、`UserID`、`Extra` 等）。

> **歷史紀錄**：早期版本本節曾要求後端新增 `user.register` 事件，**已撤銷**——後端早就有 `EventRegisterSuccess` 字面值 `auth.register_success`，命名統一即可。`cms-users-api.md §7` 也明確說 `cms_user.created` 屬 `/auth/register` 端職責、不另定義。

BFF 責任只是把 client IP 與 X-Request-ID 透傳，讓後端能組事件。

---

## 8. RBAC 互動

新註冊使用者預設 `user` role（§2.4），登入後的能力依 [`07 §4`](./07-admin-rbac-audit.md) 矩陣：

| 場景 | 行為 |
|------|------|
| 註冊成功 → 登入 → 訪問 `/players` | layout 通過；資料 API ✅ 全可（user role 在 §4.1 全部 ✅） |
| 註冊成功 → 登入 → 看 `/cms/users` 列表 | ✅ user 可讀（[`cms-users-api.md §2`](../../PlayerLedgerBackend/docs/specs/cms-users-api.md)） |
| 註冊成功 → 登入 → 嘗試 `PATCH /cms/users/{id}` 改別人 | ❌ 403 forbidden（admin only） |
| 註冊成功 → 登入 → 匯出 CSV | ✅ user 可匯出（[`07 §4.1`](./07-admin-rbac-audit.md)） |
| admin 後續將該帳號降級為 `viewer` | 後端 `RevokeAll` 強制登出 → 重登後 PII 欄位被遮罩、不可匯出 |

> **新註冊使用者不會看到「一連串 403」**——舊版本本規格基於「預設零角色」誤述，已修正。
>
> **若 v2 改採「邀請制 / 預設 viewer」**：必須同步改後端 `auth_service.Register`（hard-code 改 RoleViewer 或讀 admin invite token）+ 後端 OpenAPI + 本節 + [`07 §2`](./07-admin-rbac-audit.md)。

---

## 9. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | `/api/register` 走 BFF proxy；rate limit / CSRF 在 proxy.ts |
| [`02-auth-session.md`](./02-auth-session.md) §3.6 | 既有 passthrough 機制；本規格在其上加業務政策層 |
| [`02-auth-session.md`](./02-auth-session.md) §6.3 | rate limit `register:<ip>` 5/min |
| [`02-auth-session.md`](./02-auth-session.md) §1 | envelope 規格、`normalizeErrorCode` |
| [`03-observability.md`](./03-observability.md) | metric：`auth.register.attempt{outcome=success\|error_code}`；error code 採 normalize 後字串 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) §2 / §4 | 預設 role = `user`；user 在矩陣下的能力 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) §8.2 | 稽核事件 `auth.register_success` / `auth.register_failed` 已列 |
| [`13-screen-register.md`](./13-screen-register.md) | UI 層；本規格的 error code 對應供 §13 UI 使用 |
| [ADR 013](../adr/013-csrf-defense-strategy.md) | `/api/register` POST 受 CSRF Origin check |
| 後端 [`infrastructure.md §3.5.3`](../../PlayerLedgerBackend/docs/specs/infrastructure.md) | `/auth/register` OpenAPI 契約 |
| 後端 [`infrastructure.md §8.9`](../../PlayerLedgerBackend/docs/specs/infrastructure.md) | 弱密碼規則（len ≥ 8 + 字母 + 數字） |
| 後端 [`auth_service.go`](../../PlayerLedgerBackend/internal/service/auth_service.go) | `Register` 實作（預設 role、weak password 檢查、audit 寫入） |

---

## 10. 開放問題

> 實作前須與後端 / PM 對齊：

- [ ] **email 驗證**：v1 不做；確認後端 `/auth/register` 是否會啟用 email verification flow（影響 success path：可能需先顯示「請收信」而非直接導 login）
- [ ] **CAPTCHA / bot 防護**：v1 不做；若上線後出現量級註冊濫用，再評估 reCAPTCHA v3 / Turnstile
- [ ] **`/api/register` rate limit 上限**：[`02 §6.3`](./02-auth-session.md#63-rate-limiting) 規定 IP 5/min；UI 是否需顯示「剩餘嘗試次數」？v1 不做，超限直接走 429 alert
- [ ] **`auth.register.attempt` metric tag 結構**：[`03-observability.md`](./03-observability.md) 需補定義；v1 落地時同步更新
- [ ] **預設 `user` role 的安全性**：因為 user 即可讀全部 + 匯出，等同任何訪客註冊後立刻可以 download 所有玩家／儲值資料。若上線發現濫用，**必須**改後端為「預設 `viewer` + admin 升級」邀請制（影響 §2.4 / §8 / 後端 service / OpenAPI）
- [ ] **後端是否需「自助刪除帳號」/「請求降權」端點**：v1 無，由 admin 處理
