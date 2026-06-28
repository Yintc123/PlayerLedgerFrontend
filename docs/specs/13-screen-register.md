# CMS 帳號註冊頁規格書

## 1. 概覽

CMS 後台「註冊頁」UI——使用者從 [`/login`](./02-auth-session.md#登入頁-ui-設計v1) 點擊「建立 CMS 帳號」連結進入，填寫帳號／密碼／確認密碼建立新帳號；成功後導回 `/login` 並以 banner 提示，由使用者手動登入。

範圍：

- 路由與檔案結構
- Server / Client Component 切割
- 版型、文案、shadcn 元件對應
- 表單欄位的 UI 屬性（type、autoComplete、label）
- 表單行為（loading、error、success redirect）
- `/login` 端的對應 UI 變動（新增註冊入口連結 + `?registered=true` 成功 banner）
- 鍵盤與無障礙
- TDD UI 測試清單

**不在本文件範圍**：

- 註冊政策、API 契約、error code 對應、rate limit、稽核、RBAC 互動——見 [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md)
- email 驗證流程、invite token、CAPTCHA——見 [`12 §10 開放問題`](./12-cms-user-registration-domain.md#10-開放問題)

### 核心原則

- **URL 為唯一狀態**：`/register` 純呈現表單；成功後整頁 `window.location.replace('/login?registered=true')`，banner 由 `/login` 讀 query 顯示
- **沿用既有 shadcn primitive**：[ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)；不新增 component
- **版型與 [`/login` UI`](./02-auth-session.md#登入頁-ui-設計v1) 對齊**：居中卡片 + 漸層背景 + 角落光暈、Inter 字型；只差文案與欄位
- **資料驅動錯誤呈現**：由 [`12 §4 error code 對應`](./12-cms-user-registration-domain.md#4-後端-error-code-對應與顯示文案) 提供顯示文字，UI 不重複硬編 enum

---

## 2. 路由與檔案結構

### 2.1 路由

```
/login         # 既有，本規格新增 「建立 CMS 帳號」連結 + 成功 banner
/register      # 本規格主體
```

`/register` 屬於 `(auth)` route group，沿用 [`02 §2.5`](./02-auth-session.md#25-client-session-modelbrowser-端-session-資訊來源) 對 `(auth)` 群的處理：**不掛 SessionProvider、不檢 session、不導 login**（PUBLIC_PATHS 規格見 [`12 §3`](./12-cms-user-registration-domain.md#3-proxyts-路由規則)）。

### 2.2 檔案結構

```
src/app/(auth)/register/
├── page.tsx                       # 註冊頁（Client Component）
├── page.test.tsx                  # 行為測試（vitest + jsdom + RTL）
```

UI 元件全部沿用 `src/components/ui/{button,input,label,card,alert}.tsx`（[ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)），**不新增** primitive。

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
│       │   已有帳號?返回登入        │          │
│       └───────────────────────────┘          │
│                                              │
│        © PlayerLedger · 內部後台            │
└─────────────────────────────────────────────┘
```

### 4.2 文案 token（繁中，鎖定不可換）

| 用途 | 文字 |
|------|------|
| 卡片標題 | `PlayerLedger` |
| 卡片副標 | `建立 CMS 帳號` |
| 帳號 label | `帳號` |
| 密碼 label | `密碼` |
| 確認密碼 label | `確認密碼` |
| 密碼 helper text | `至少 8 字元，需含字母與數字` |
| 提交按鈕（閒置） | `建立帳號` |
| 提交按鈕（loading） | `建立中…`（U+2026） |
| 返回登入 link | `已有帳號？返回登入` |
| Footer | `© PlayerLedger · 內部後台` |
| Confirm 不一致錯誤 | `密碼與確認密碼不一致` |
| Fallback 錯誤（無 message 時） | `建立帳號失敗` |
| Fallback 網路錯誤 | `網路錯誤` |

> 後端 error code → 顯示文案的完整對應表見 [`12 §4`](./12-cms-user-registration-domain.md#4-後端-error-code-對應與顯示文案)。

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

## 5. 表單欄位（UI 屬性）

> 後端 schema、必填規則、長度限制由 [`12 §2`](./12-cms-user-registration-domain.md#2-註冊政策與資料模型) 定義；本節只描述 UI input 屬性與 client 端 UX 提示。

| 欄位 | input 屬性 | client 端 UX 驗證 |
|------|-----------|------------------|
| 帳號 | `type="text"`、`autoComplete="username"`、`required`、`minLength={3}`、`maxLength={64}` | trim 後對齊後端 OpenAPI `minLength: 3, maxLength: 64`；其餘交後端 |
| 密碼 | `type="password"`、`autoComplete="new-password"`、`required`、`minLength={8}`、`maxLength={256}` | length 8–256；強度規則「需含字母與數字」以 helper text 提示而非 client 端攔截（[`12 §5`](./12-cms-user-registration-domain.md#5-client--server-驗證職責劃分)） |
| 確認密碼 | `type="password"`、`autoComplete="new-password"`、`required` | 與密碼欄位 `===` 比對 |

**密碼欄位 helper text**：在密碼欄位下方以 `muted` 樣式顯示「`至少 8 字元，需含字母與數字`」（對齊後端 `infrastructure.md §8.9` 弱密碼規則）。

> **client 不做的事**：不檢 email format、不檢 username 是否存在、不檢密碼複雜度規則（client 不模擬 `weak_password` 邏輯）——詳見 [`12 §5`](./12-cms-user-registration-domain.md#5-client--server-驗證職責劃分)。

---

## 6. 表單行為

### 6.1 提交流程

1. 點「建立帳號」或在任一欄位按 Enter
2. **Client 端先檢**：若 confirm password ≠ password，直接以 `Alert` 顯示 `密碼與確認密碼不一致`，**不打** `/api/register`
3. Loading 進入：三個 input 與 submit button 全 `disabled`；按鈕文字「建立中…」+ `Loader2` 動畫
4. `POST /api/register`，body：`{ "username": "<input>", "password": "<input>" }`（**不送 `confirmPassword`**——純 client 概念，[`12 §2`](./12-cms-user-registration-domain.md#2-註冊政策與資料模型)）
5. **成功**（HTTP 200 / 201）：`window.location.replace('/login?registered=true')`
6. **失敗**（HTTP 4xx）：把 [`12 §4`](./12-cms-user-registration-domain.md#4-後端-error-code-對應與顯示文案) 對應文案寫入 `Alert`；保留欄位值；移除 disabled
7. **網路錯誤**（fetch reject）：顯示 `err.message || '網路錯誤'`

### 6.2 不做的事

- **不 auto-login**：成功後**不** call `/api/login`（[`12 §2.4`](./12-cms-user-registration-domain.md#2-註冊政策與資料模型)）
- **不廣播 AuthChannel**：未建立 session 階段沒有東西可廣播
- **不檢 session**：`/register` 是 PUBLIC path，proxy.ts 不會擋
- **不顯示「已登入則跳走」**：使用者已登入時誤入 `/register` 仍可看到表單；submit 後後端**不**會檢 session（`/auth/register` 為公開端點），通常會回 `username_taken`（已存在帳號）或正常建第二個帳號——UI 走一般 4xx 流程即可，無需特別 client-side guard

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
- 文案：`還沒有帳號？` + 「`建立 CMS 帳號`」（後 7 字為連結）

### 7.2 `?registered=true` 成功 banner

`/register` 成功後 redirect 到 `/login?registered=true`。`/login` 頁應：

1. 讀 `useSearchParams().get('registered') === 'true'`
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

## 8. 狀態

| 狀態 | 觸發 | UI |
|------|------|----|
| **Idle** | 初次進頁 | 空白表單 |
| **Loading** | submit 中 | inputs + button 全 `disabled`，button 文字「建立中…」 + spinner |
| **Submit error**（4xx） | API 回 4xx | `Alert variant="destructive"`，文案見 [`12 §4`](./12-cms-user-registration-domain.md#4-後端-error-code-對應與顯示文案) |
| **Network error**（fetch reject） | 斷網 / DNS fail | `Alert variant="destructive"`，顯示 `err.message || '網路錯誤'` |
| **Confirm 不一致** | client 端攔截 | `Alert variant="destructive"`，文案「密碼與確認密碼不一致」 |
| **Success → redirect** | 200 / 201 | 整頁 `window.location.replace('/login?registered=true')` |

`/login` 端額外狀態：

| 狀態 | 觸發 | UI |
|------|------|----|
| **Registered banner** | URL 含 `?registered=true` | `Alert variant="default"` + `CheckCircle2` 圖示 + 「註冊成功，請以新帳號登入」 |

---

## 9. URL 與導航

| 路徑 | 觸發 | 目的 |
|------|------|------|
| `/register` | 從 /login 「建立 CMS 帳號」連結 | 主入口 |
| `/login?registered=true` | /register 成功後 | 顯示 banner |
| `/login` | /register 「返回登入」連結 | 不帶 banner |

**不**接受任何 `?redirect=` 等 query string（與 `/login` 不同），避免「註冊→某 redirect」流程被偽造為釣魚跳板。所有成功路徑強制導回 `/login?registered=true`。

---

## 10. 鍵盤與無障礙

| 項目 | 要求 |
|------|------|
| 表單欄位 | 每個 `<input>` 有 `<label htmlFor>` 對應；不依賴 placeholder 作為唯一 label |
| Tab 順序 | 帳號 → 密碼 → 確認密碼 → 建立帳號 → 「返回登入」連結 |
| Enter 提交 | `<form onSubmit>` 處理;按鈕為 `<button type="submit">` |
| Disabled | 用 `disabled` 屬性；不靠 `pointer-events: none` 偽 disable |
| Alert | `role="alert"`（shadcn `Alert` 預設提供）；錯誤訊息出現時自動 announce |
| Loading 狀態 | button `aria-busy="true"`；icon `aria-hidden` |
| 對比度 | 沿用 shadcn OKLCH 色票，destructive variant ≥ 4.5:1 |
| 螢幕閱讀器 | 卡片副標「建立 CMS 帳號」為 `<h1>`；返回登入連結為 `<a>` 而非 `<button>`（語意正確） |

---

## 11. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md) | 業務邏輯（政策、API 契約、error code、rate limit、稽核） |
| [`02-auth-session.md`](./02-auth-session.md) §3.1 | 登入頁 UI 新增註冊入口 link + `?registered=true` banner（§7） |
| [`02-auth-session.md`](./02-auth-session.md) §3.6 | 註冊 passthrough 既有；本規格僅依賴 UI 對接 |
| [ADR 021](../adr/021-tailwind-v4-shadcn-ui.md) | UI 元件來源：shadcn primitive |

---

## 12. 測試清單（TDD）

### 12.1 `src/app/(auth)/register/page.test.tsx`

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

// 錯誤（error codes 對應 — 完整 mapping 見 spec 12 §4）
it('should render alert with backend message on 4xx')
it('should map username_taken to "此帳號已被使用，請換一個"')
it('should map "username taken" (space-form) to same message via normalizeErrorCode')
it('should map weak_password to "密碼強度不足；需至少 8 字元且同時含字母與數字"')
it('should map invalid_client to "服務設定錯誤，請聯絡管理員"')
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

### 12.2 `src/app/(auth)/login/page.test.tsx`（擴充）

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

### 12.3 E2E（Playwright）

```ts
test('/login → click 建立 CMS 帳號 → /register page renders')
test('/register submit with mismatched confirm password → inline alert, no navigation')
test('/register submit with valid input → /login?registered=true with success banner')
test('/register submit with duplicate username → red alert with backend message')
```

E2E 須對 `/api/register` 走 mock 或對接後端 stub；不可 mock `lib/api-client/*`（內部模組），詳見 [`CLAUDE.md` TDD 規則](../../CLAUDE.md#規則)。

> proxy.ts 對 `/register` 公開路徑的測試見 [`12 §6`](./12-cms-user-registration-domain.md#6-測試清單tdd)。

---

## 13. 開放問題（UI 範圍）

> 業務邏輯層的開放問題見 [`12 §10`](./12-cms-user-registration-domain.md#10-開放問題)。

- [ ] **密碼強度視覺提示**：是否在輸入時即時顯示「弱／中／強」？v1 不做（helper text 已揭示「字母+數字」規則），由後端 `weak_password` 反應即可
- [ ] **使用者已登入時誤入 /register**：v1 不特別處理（`/auth/register` 不檢 session，會視為新帳號建立或回 `username_taken`）；UX 若反饋糟糕再加 client-side `useSession` guard 並 redirect 到 `/dashboard`
- [ ] **「建立帳號」按鈕 disabled 邏輯**：v1 永遠 enabled（依賴 HTML `required` + client confirm 比對 alert）；若 PM 要求「三欄都填了才 enable」需另寫
- [ ] **註冊成功 banner 可關閉？** v1 不可關，整頁載入後自動消失；若需手動關（如 admin 反覆操作），加 X 按鈕
