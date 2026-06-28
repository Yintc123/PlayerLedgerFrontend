# CMS 帳號註冊頁規格書

## 1. 概覽

CMS 後台「註冊頁」——使用者從 [`/login`](./02-auth-session.md#登入頁-ui-設計v1) 點擊「建立 CMS 帳號」連結進入，填寫帳號／密碼建立新帳號；成功後導回 `/login` 並以 banner 提示，由使用者手動登入。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 表單欄位（帳號、密碼、確認密碼）
- 提交流程、錯誤處理、loading 態
- 後端契約對接（沿用 [`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough不對應-ui) 既有 `/api/register` passthrough）
- `/login` 端的對應變動（新增註冊入口連結 + `?registered=true` 成功 banner）
- 鍵盤與無障礙
- TDD 測試清單

**不在本文件範圍**：

- email 驗證流程（v2）
- invite token 邀請流程（v2）
- CAPTCHA / bot 防護（v2，視註冊濫用情況加上）
- 帳號權限（角色）的指派——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)

### 核心原則

- **公開自助註冊**：任何訪客可建立帳號，**不需要 session**。`/register` 屬 `(auth)` group、列入 [proxy.ts](../specs/01-bff-architecture.md) 的 `PUBLIC_PATHS`（同 `/login`）
- **註冊 ≠ 授權**：新建帳號預設**無任何角色**（[`07 §2`](./07-admin-rbac-audit.md)）；登入後所有 API 會回 403 直到 admin 在 v2 角色管理 UI 指派角色。詳見 §8 與 §12
- **成功後不簽 token**（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough不對應-ui)）：直接導回 `/login`，使用者手動登入。理由：強迫確認密碼記得、與 [`02 §3.1`](./02-auth-session.md#31-登入流程) 的 session fixation 防護無縫接軌
- **資料驅動錯誤**：失敗訊息以後端 `data.message || data.error` 為主，client 端只做必要正規化（如 `normalizeErrorCode`，參照 [`02 §1`](./02-auth-session.md#1-概覽)）
- **client-side 驗證僅限 UX**：`confirm password === password`、必填、長度下限 8 純粹是手誤防護，**最終強度規則由後端決定**（與 [`08`](./08-screen-player-search.md) §核心原則「不在 client 重複後端等價驗證」一致）

---

## 2. 路由與檔案結構

### 2.1 路由

```
/login         # 既有，本規格新增 「建立 CMS 帳號」連結 + 成功 banner
/register      # 本規格主體
```

`/register` 屬於 `(auth)` route group，沿用 [`02 §2.5`](./02-auth-session.md#25-client-session-modelbrowser-端-session-資訊來源) 對 `(auth)` 群的處理：**不掛 SessionProvider、不檢 session、不導 login**。

### 2.2 檔案結構

```
src/app/(auth)/register/
├── page.tsx                       # 註冊頁（Client Component）
├── page.test.tsx                  # 行為測試（vitest + jsdom + RTL）
```

UI 元件全部沿用 `src/components/ui/{button,input,label,card,alert}.tsx`（[ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)），**不新增** primitive。

### 2.3 proxy.ts 變動

`/register` 路徑需加入 `PUBLIC_PATHS`：

```ts
// src/proxy.ts
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/register',          // ← 本規格新增
  '/api/login',
  '/api/logout',
  '/api/register',
  // ...
])
```

`/api/register` 本來就在 `PUBLIC_PATHS`（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough不對應-ui)），本規格不需動。

---

## 3. Server / Client Component 切割

| 元件 | 類型 | 為何 |
|------|------|------|
| `app/(auth)/register/page.tsx` | Client | 受控表單 + `useState` + `fetch` |
| `Alert` / `Button` / `Input` / `Label` / `Card` | 沿用 shadcn primitive | 已是 client-friendly |

整頁不分子 component——表單規模小，避免過早拆分。

---

## 4. 頁面組成

### 4.1 整體版型

與 [`02 §3.1 登入頁 UI 設計`](./02-auth-session.md#登入頁-ui-設計v1) 共用版型（居中卡片 + 漸層背景 + 角落光暈），文案與表單欄位不同。

```
┌─────────────────────────────────────────────┐
│        （bg-gradient slate-50 → 200）       │
│        + 角落 indigo / fuchsia 光暈         │
│                                              │
│       ┌───────────────────────────┐          │
│       │     ◆ Wallet icon         │          │
│       │     PlayerLedger          │          │
│       │     建立 CMS 帳號          │          │
│       │                            │          │
│       │   帳號                     │          │
│       │   [____________________]   │          │
│       │                            │          │
│       │   密碼                     │          │
│       │   [____________________]   │          │
│       │                            │          │
│       │   確認密碼                 │          │
│       │   [____________________]   │          │
│       │                            │          │
│       │   [! 錯誤訊息 ]（如有）    │          │
│       │                            │          │
│       │   [     建立帳號      ]    │          │
│       │                            │          │
│       │   已有帳號？返回登入       │          │
│       └───────────────────────────┘          │
│                                              │
│        © PlayerLedger · 內部後台            │
└─────────────────────────────────────────────┘
```

### 4.2 文案 token（繁中，鎖定）

| 用途 | 文字 |
|------|------|
| 卡片標題 | `PlayerLedger` |
| 卡片副標 | `建立 CMS 帳號` |
| 帳號 label | `帳號` |
| 密碼 label | `密碼` |
| 確認密碼 label | `確認密碼` |
| 提交按鈕（閒置） | `建立帳號` |
| 提交按鈕（loading） | `建立中…`（U+2026） |
| 返回登入 link | `已有帳號？返回登入` |
| Footer | `© PlayerLedger · 內部後台` |
| Confirm 不一致錯誤 | `密碼與確認密碼不一致` |
| Fallback 錯誤（無 message 時） | `建立帳號失敗` |
| Fallback 網路錯誤 | `網路錯誤` |

### 4.3 元件對應

| 區塊 | shadcn primitive |
|------|-----------------|
| 卡片外殼 | `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` |
| 帳號 / 密碼 / 確認密碼 | `Input` + `Label` |
| 提交按鈕 | `Button`（`variant="default"`、`className="w-full"`） |
| 錯誤訊息 | `Alert variant="destructive"` + `AlertDescription` |
| 返回登入連結 | `<Link href="/login">` + Tailwind utility（不需 Button variant） |
| Logo / loading icon | `Wallet` / `Loader2` from lucide-react |

---

## 5. 表單欄位

| 欄位 | input 屬性 | 必填 | client 驗證 |
|------|-----------|------|-------------|
| 帳號 | `type="text"`、`autoComplete="username"` | ✅ | `required`、trim 後 length ≥ 1（其餘交後端） |
| 密碼 | `type="password"`、`autoComplete="new-password"` | ✅ | `required`、length ≥ 8（純 UX 提示，不擋短密碼 — 由後端 `weak_password` error code 把關） |
| 確認密碼 | `type="password"`、`autoComplete="new-password"` | ✅ | `required`、與密碼欄位 `===` 比對 |

> **不在 client 做的事**：
>
> - 不做 email format 檢查（後端 `username` 接受非 email 字串，見 [`02 §11.2`](./02-auth-session.md#112-username-接受-email-格式)）
> - 不檢查 username 是否已存在（沒有 `/api/users/exists` 端點；以 `username_taken` error code 處理）
> - 不檢查密碼強度規則（後端 `weak_password` 為唯一可信來源）

---

## 6. 表單行為

### 6.1 提交流程

1. 點「建立帳號」或在任一欄位按 Enter
2. **Client 端先檢**：若 confirm password ≠ password，直接以 `Alert` 顯示 `密碼與確認密碼不一致`，**不打** `/api/register`
3. Loading 進入：三個 input 與 submit button 全 `disabled`；按鈕文字「建立中…」+ `Loader2` 動畫
4. `POST /api/register`，body：`{ "username": "<input>", "password": "<input>" }`（**不送 `confirmPassword`**——純 client 概念）
5. 走 BFF proxy → 後端 `POST /auth/register`（[`02 §3.6`](./02-auth-session.md#36-註冊端點passthrough不對應-ui)）
6. **成功**（HTTP 200 / 201）：`window.location.replace('/login?registered=true')`
7. **失敗**（HTTP 4xx）：把 `data.message || data.error || '建立帳號失敗'` 寫入 `Alert`；保留欄位值；移除 disabled
8. **網路錯誤**（fetch reject）：顯示 `err.message || '網路錯誤'`

### 6.2 後端 error code 對應

依 [`02 §1 後端 error code 字串格式不一致`](./02-auth-session.md#1-概覽) 規則用 `normalizeErrorCode` 比對。常見：

| HTTP | error code（snake / 空白） | 顯示文案（建議） |
|------|---------------------------|-----------------|
| 400 | `invalid_input` / `"invalid input"` / `validation_error` | 透傳 `message` 或 fallback `輸入格式不正確` |
| 409 | `username_taken` | `此帳號已被使用，請換一個` |
| 422 | `weak_password` | `密碼強度不足，請使用更強的密碼` |
| 429 | `too_many_requests` | `操作過於頻繁，請稍後再試`；尊重 `Retry-After` header |
| 5xx | （任意） | `服務暫時無法使用，請稍後再試` |

> **client 不寫死 enum**：`normalizeErrorCode(code)` 後用 `switch`，未列在表中的 code 直接顯示 `data.message`。後端新增 error code 不需改 client。

### 6.3 不做的事

- **不 auto-login**：成功後**不** call `/api/login`；強迫使用者重新輸入密碼確認記得（與 [`02 §3.1`](./02-auth-session.md#31-登入流程) session fixation 防護一致）
- **不廣播 AuthChannel**：未建立 session 階段沒有東西可廣播（與 login 不同）
- **不檢 session**：`/register` 是 PUBLIC path，不檢 cookie 也不導 login
- **不顯示「已登入則跳走」**：v1 簡化——已登入使用者誤入 /register 仍可看到表單；submit 後若 session 仍有效，後端會回 `use_logout_instead` error code（後端 OpenAPI 既有），UI 走一般錯誤態

---

## 7. `/login` 頁的對應變動

### 7.1 新增「建立 CMS 帳號」連結

在 [`02 §3.1 登入頁 UI 設計`](./02-auth-session.md#登入頁-ui-設計v1) Card 底部「登入」按鈕**下方**新增：

```
[      登入      ]

────── 或 ──────

還沒有帳號？建立 CMS 帳號
```

- `<Link href="/register">` 為主要互動，**不**用 `Button`（語意是導航而非動作）
- 視覺：分隔線 + secondary text，**不**與「登入」競爭視覺重點
- 文案：`還沒有帳號？` + 「`建立 CMS 帳號`」（後半段為連結，前半段為純文字提示）

### 7.2 `?registered=true` 成功 banner

`/register` 成功後 redirect 到 `/login?registered=true`。`/login` 頁應：

1. 讀 `useSearchParams().get('registered')` === `'true'`
2. 表單上方顯示 `Alert variant="default"`：圖示用 `CheckCircle2`（lucide），文案「`註冊成功，請以新帳號登入`」
3. **不**自動清除——使用者登入導頁後 banner 自然消失（整頁載入）
4. 若 URL 同時有 `?registered=true` 與 `?reason=...`（logout 原因 query），兩者不衝突：success banner 顯示在最上方，logout 原因 banner（v2 預留）顯示在表單上方但下面

### 7.3 文案

| 用途 | 文字 |
|------|------|
| 分隔線文字 | `或` |
| 註冊入口 link | `還沒有帳號？建立 CMS 帳號`（後 7 字為連結） |
| 註冊成功 banner | `註冊成功，請以新帳號登入` |

---

## 8. 安全與 RBAC 對接

### 8.1 註冊後預設角色

新建帳號**無任何角色**（[`07 §2`](./07-admin-rbac-audit.md)）。登入後：

- `/api/players/*` 等業務端點 → 後端回 403 `forbidden`
- CMS 任何頁面進得去（layout 只檢 session 不檢 role）但所有資料 API 全 403
- 使用者畫面會看到一連串的 `ForbiddenState`（各 screen 規格的 `forbidden` variant）

**這是設計：** 公開自助註冊 + 預設零角色 + 由 admin 後續授權，比「邀請制」實作成本低、比「自助即可用」安全。

> **若後端 OpenAPI** 為 `/auth/register` 提供 `defaultRole` 參數，**禁止前端在 UI 層暴露**——任何「自選角色」設計等於擺爛，必須移除。

### 8.2 Rate limit

`/api/register` 在 [`02 §6.3`](./02-auth-session.md#63-rate-limiting) 已有 limit（IP 為單位）。前端不額外限流；後端回 429 時 client 走 §6.2 對應流程。

### 8.3 稽核

[`07 §8`](./07-admin-rbac-audit.md) 稽核事件清單**目前不含 `user.register`**——本規格落地時須補上：

```
event: user.register
fields: ip, userId（新建後）, username, request_id, occurred_at
```

由後端負責寫入（同 §8.1）。前端 / BFF 不寫稽核。

---

## 9. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Idle** | 初次進頁 | 空白表單 |
| **Loading** | submit 中 | inputs + button 全 `disabled`，button 文字「建立中…」 + spinner |
| **Submit error**（4xx） | API 回 4xx | `Alert variant="destructive"`，文案見 §6.2 |
| **Network error**（fetch reject） | 斷網 / DNS fail | `Alert variant="destructive"`，顯示 `err.message || '網路錯誤'` |
| **Confirm 不一致** | client 端攔截 | `Alert variant="destructive"`，文案「密碼與確認密碼不一致」 |
| **Success → redirect** | 200 / 201 | 整頁 `window.location.replace('/login?registered=true')` |

`/login` 端額外狀態：

| 狀態 | 觸發 | UI |
|------|------|----|
| **Registered banner** | URL 含 `?registered=true` | `Alert variant="default"` + `CheckCircle2` 圖示 + 「註冊成功，請以新帳號登入」 |

---

## 10. URL 與導航

| 路徑 | 觸發 | 目的 |
|------|------|------|
| `/register` | 從 /login 「建立 CMS 帳號」連結 | 主入口 |
| `/login?registered=true` | /register 成功後 | 顯示 banner |
| `/login` | /register 「返回登入」連結 | 不帶 banner |

**不**接受任何 `?redirect=` 等 query string（與 `/login` 不同），避免「註冊→某 redirect」流程被偽造為釣魚跳板。所有成功路徑強制導回 `/login?registered=true`。

---

## 11. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| 表單欄位 | 每個 `<input>` 有 `<label htmlFor>` 對應；不依賴 placeholder 作為唯一 label |
| Tab 順序 | 帳號 → 密碼 → 確認密碼 → 建立帳號 → 「返回登入」連結 |
| Enter 提交 | `<form onSubmit>` 處理；按鈕為 `<button type="submit">` |
| Disabled | 用 `disabled` 屬性；不靠 `pointer-events: none` 偽 disable |
| Alert | `role="alert"`（shadcn `Alert` 預設提供）；錯誤訊息出現時自動 announce |
| Loading 狀態 | button `aria-busy="true"`；icon `aria-hidden` |
| 對比度 | 沿用 shadcn OKLCH 色票，destructive variant ≥ 4.5:1 |
| 螢幕閱讀器 | 卡片副標「建立 CMS 帳號」為 `<h1>`；返回登入連結為 `<a>` 而非 `<button>`（語意正確） |

---

## 12. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | `/register` 加入 proxy.ts `PUBLIC_PATHS`（§2.3）；`/api/register` 已是 PUBLIC + 走 BFF proxy |
| [`02-auth-session.md`](./02-auth-session.md) §3.1 | 登入頁 UI 新增註冊入口 link + `?registered=true` banner（§7） |
| [`02-auth-session.md`](./02-auth-session.md) §3.6 | 註冊 passthrough 既有；本規格補上 UI（原 §3.6「無對應 UI」需同步更新） |
| [`03-observability.md`](./03-observability.md) | metric：`auth.register.attempt{outcome=success\|error_code}`；error code 採 normalize 後字串 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 註冊後預設無角色；§8.1 補 `user.register` 稽核事件 |
| [ADR 021](../adr/021-tailwind-v4-shadcn-ui.md) | UI 元件來源：shadcn primitive |
| [ADR 013](../adr/013-csrf-defense-strategy.md) | `/api/register` POST 受 CSRF Origin check；UI 走同源即可，無需額外處理 |

---

## 13. 測試清單（TDD）

### 13.1 `src/app/(auth)/register/page.test.tsx`

```ts
// @vitest-environment jsdom

// 表單渲染
it('should render the username, password, and confirm password fields with labels')
it('should require all three fields (HTML validation)')
it('should render Submit button as enabled by default')
it('should render link to /login at the bottom of the card')

// Client 端驗證
it('should show "密碼與確認密碼不一致" alert when confirm differs from password (no API call)')
it('should NOT call /api/register when client-side validation fails')

// 提交行為
it('should POST { username, password } to /api/register on submit')
it('should NOT include confirmPassword in the request body')
it('should disable all inputs and the submit button while in flight')
it('should render "建立中…" with spinner during loading state')

// 成功
it('should redirect to /login?registered=true on 200 response')
it('should redirect to /login?registered=true on 201 response')

// 錯誤（error codes 對應）
it('should render alert with backend message on 4xx')
it('should map username_taken to "此帳號已被使用，請換一個"')
it('should map "username taken" (space-form) to same message via normalizeErrorCode')
it('should map weak_password to "密碼強度不足，請使用更強的密碼"')
it('should map invalid_input to "輸入格式不正確" when no message provided')
it('should pass through backend message when error code is unknown')

// 網路錯誤
it('should render alert with err.message when fetch rejects')
it('should render fallback "網路錯誤" when err has no message')

// Loading 後保留輸入
it('should retain field values after a failed submission')

// 無障礙
it('should associate each input with a label via htmlFor')
it('should expose Submit as <button type="submit">')
it('should render Alert with role="alert"')
```

### 13.2 `src/app/(auth)/login/page.test.tsx`（擴充）

擴充 [`02 §9 Component 測試`](./02-auth-session.md#component-測試react-testing-library) 既有清單：

```ts
// 註冊成功 banner
it('should render the "註冊成功，請以新帳號登入" banner when URL has ?registered=true')
it('should NOT render the banner when ?registered is absent')
it('should NOT render the banner when ?registered=false')

// 註冊入口
it('should render a link to /register at the bottom of the card')
it('should render the link with text "建立 CMS 帳號"')
```

### 13.3 proxy.ts 測試（擴充）

擴充 [`02 §9 proxy.ts 測試`](./02-auth-session.md#proxyts-測試vitest)：

```ts
it('should allow unauthenticated GET /register (PUBLIC_PATHS)')
it('should NOT redirect /register to /login')
```

### 13.4 E2E（Playwright）

```ts
test('/login → click 建立 CMS 帳號 → /register page renders')
test('/register submit with mismatched confirm password → inline alert, no navigation')
test('/register submit with valid input → /login?registered=true with success banner')
test('/register submit with duplicate username → red alert with backend message')
```

E2E 須對 `/api/register` 走 mock 或對接後端 stub；不可 mock `lib/api-client/*`（內部模組），詳見 [`CLAUDE.md` TDD 規則](../../CLAUDE.md#規則)。

---

## 14. 開放問題（TODO）

> 實作前須與後端 / PM 對齊：

- [ ] **密碼強度規則**：v1 client 端只擋 length < 8（純 UX），後端 `weak_password` 為唯一可信來源；後端確切規則（含字元類別、common password blocklist）由後端 spec 維護
- [ ] **email 驗證**：v1 不做；確認後端 `/auth/register` 是否會啟用 email verification flow（影響 success path：可能需先顯示「請收信」而非直接導 login）
- [ ] **CAPTCHA / bot 防護**：v1 不做；若上線後出現量級註冊濫用，再評估 reCAPTCHA v3 / Turnstile
- [ ] **`use_logout_instead` 行為**：使用者已登入時打 /register，後端會回此 code；UI 是否需要特別處理（如「已登入，請先登出」+ 提供 logout 按鈕）或就走一般錯誤態？v1 採後者
- [ ] **`/api/register` rate limit 上限**：[`02 §6.3`](./02-auth-session.md#63-rate-limiting) 規定 IP 5/min；註冊頁是否需在 UI 顯示「剩餘嘗試次數」？v1 不做，超限直接走 429 alert
- [ ] **`auth.register.attempt` metric tag 結構**：[`03-observability.md`](./03-observability.md) 需補定義；v1 落地時同步更新
- [ ] **`/register` 是否要在 navbar 暴露**？v1 不，只從 /login 連入；若改為「登入區也可註冊新帳號」（admin 場景）需另開規格
