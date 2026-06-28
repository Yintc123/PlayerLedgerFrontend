# ADR 002 - BFF 路由結構設計

## 狀態

已採用

## 背景

BFF 層需要三類路由：

1. **頁面路由**：使用者直接瀏覽的 HTML 頁面（如登入頁 `/login`）
2. **Auth 端點**：處理 session 建立與銷毀的 API（`POST /api/login`、`POST /api/logout`）
3. **Proxy 端點**：轉發所有其他請求至 Go API Server（`/api/*`）

問題出在 Auth 端點與 Proxy 端點的共存方式：Proxy 使用 Next.js catch-all 路由 `/api/[...path]`，
若 login / logout 路由不正確擺放，會被 catch-all 吃掉，直接轉發給 Go API Server，
導致 session 建立邏輯完全不執行。

## 評估

### 選項 A：Auth 端點放在 `/api/` 下（獨立 Route Handler）

```
app/
├── (auth)/login/page.tsx        →  GET  /login        登入頁面（HTML）
├── api/login/route.ts           →  POST /api/login    建立 session
├── api/logout/route.ts          →  POST /api/logout   銷毀 session
└── api/[...path]/route.ts       →  ANY  /api/*        Proxy catch-all
```

Next.js App Router 的路由解析規則：**具體路由優先於 catch-all**。
`/api/login` 和 `/api/logout` 作為具體路由，不會被 `[...path]` 攔截。

**優點：**
- 頁面（`/login`）與 API（`/api/login`）路徑語意清晰，各司其職
- 路由衝突由 Next.js 框架機制解決，無需額外設定
- 所有 BFF 自己處理的 API 都在 `/api/` 前綴下，一目了然

**缺點：**
- 登入頁面（`/login`）與登入端點（`/api/login`）路徑不同，需要開發者理解此設計

### 選項 B：Auth 端點與頁面共置於 `(auth)` 路由群組

```
app/
└── (auth)/
    ├── login/page.tsx           →  GET  /login
    ├── login/route.ts           →  POST /login     ← 同一目錄同時有 page 和 route
    └── logout/route.ts          →  POST /logout
```

API 契約路徑改為 `POST /login`、`POST /logout`（不帶 `/api/` 前綴）。

**優點：**
- 登入頁面與登入邏輯放在同一目錄，檔案結構更集中

**缺點：**
- `/login` 同時是頁面（GET）也是 API 端點（POST），語意混淆
- Auth 端點路徑（`/login`、`/logout`）與 Proxy 端點路徑（`/api/*`）前綴不一致，難以用 `proxy.ts` matcher 統一管理

### 選項 C：改用 React Server Action

登入改為 Server Action，不需要 Route Handler，也沒有 URL。

**優點：**
- 不存在路由衝突問題

**缺點：**
- Server Action 的測試模式與 Route Handler 不同，和本專案 TDD 規範的 Vitest 整合較複雜
- 登出需要清除 Cookie，Server Action 雖可操作 `cookies()`，但語意上 POST Route Handler 更直覺
- 改動範圍大，API 契約、測試用例均需重新設計

## 決策

採用**選項 A**：Auth 端點以獨立 Route Handler 的方式放在 `/api/` 下。

```
POST /api/login   → app/api/login/route.ts
POST /api/logout  → app/api/logout/route.ts
ANY  /api/*       → app/api/[...path]/route.ts（具體路由已排除，不會攔到 login/logout）
```

同時將 catch-all 參數從 `[...proxy]` 改名為 `[...path]`，
避免與路由保護檔案 `proxy.ts`（Next.js 16）產生命名混淆。

## 補充：proxy.ts 保護邏輯需排除 `/api/logout`

`proxy.ts` 的路由保護邏輯不應攔截 `/api/logout`。
登出端點本身負責處理「session 不存在」的情況（直接回傳 200），
若被 `proxy.ts` 攔截並 302 重導向，使用者在 session 失效後將永遠無法登出。

> **實作機制**：原本此排除規則寫在 matcher regex 內。後續發現 regex 負向 lookahead 有前綴誤判風險（`/login-history` 也會被排除），改由 handler 內 `PUBLIC_PATHS` Set 精確比對處理。決策本身（排除 `/api/logout`）不變,僅實作層次調整。詳見 [ADR 007 - 路由保護：公開路徑白名單放在 Handler 內](./007-public-paths-in-handler.md) 與 [spec 02 §4](../specs/02-auth-session.md#4-nextjs-proxy-路由保護)。
