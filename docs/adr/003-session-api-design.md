# ADR 003 - Session 函式 API 設計

## 狀態

已採用（核心決策仍然有效）

> **修訂註記**：本 ADR 中描述 `verifySession()` 內部執行「HMAC 驗證」的段落，已由 [ADR 006 - SessionId 不採用 HMAC 簽章](./006-sessionid-no-hmac.md) 修訂。現行設計改為「sid 格式驗證 + Redis lookup」，**SessionId 不再使用 HMAC 簽章**。
>
> 本 ADR 真正的決策——「`verifySession(sid)` 與 `getValidAccessToken()` 的函式拆分」——不受影響、仍然成立。請以本 ADR 理解函式職責分工，以 ADR 006 理解 `verifySession` 內部的驗證機制。

## 背景

BFF 架構下，有兩類需要讀取 session 的情境：

**情境 A：`proxy.ts` 路由保護**
- 目的：確認 session 是否存在，不存在則 302 重導向
- Cookie 來源：`NextRequest.cookies`（Next.js 16 `proxy.ts` 的參數）
- 不需要觸發 token refresh

**情境 B：Server Component / Route Handler 呼叫 API**
- 目的：取得有效的 `accessToken` 以帶入 `Authorization` header
- Cookie 來源：`next/headers` 的 `await cookies()`（只能在 Next.js Server 環境使用）
- 需要在 token 即將過期時自動 refresh（含 Redis Mutex）

兩個情境的 cookie 讀取方式不同，但 HMAC 驗證與 Redis lookup 邏輯完全相同。
若各自實作，核心驗證邏輯會重複出現在兩個地方。

## 評估

### 方案 X：各自獨立實作

`proxy.ts` 和 `getValidAccessToken()` 都各自寫一遍 HMAC 驗證 + Redis lookup。

**缺點：**
- 邏輯重複，未來修改（例如調整 HMAC 演算法）需同步兩處
- 容易因更新不一致產生 bug

### 方案 Y：`getValidAccessToken(sid: string)` 接收 sid 參數

統一成一個函式，由呼叫端自己取 sid 後傳入。

```ts
export async function getValidAccessToken(sid: string): Promise<string | null>

// proxy.ts
const sid = request.cookies.get('sid')?.value
const token = await getValidAccessToken(sid)

// Server Component
const sid = (await cookies()).get('sid')?.value
const token = await getValidAccessToken(sid)
```

**缺點：**
- 呼叫端需要自己取 sid，增加呼叫端的負擔
- HMAC 驗證責任不清晰（呼叫端要不要先驗？）
- Server Component 每次都需要寫兩行才能取得 token

### 方案 Z（採用）：`verifySession(sid)` 共用 + `getValidAccessToken()` 零參數

拆成兩個函式，各自對應不同的抽象層次：

```ts
// 底層：接受 sid，供 proxy.ts 和 getValidAccessToken 共用
export async function verifySession(sid: string): Promise<SessionData | null>

// 上層：零參數，自己讀 cookie，供 Server Component / Route Handler 使用
export async function getValidAccessToken(): Promise<string | null>
```

`getValidAccessToken` 內部呼叫 `verifySession`，不重複邏輯。
`proxy.ts` 直接呼叫 `verifySession`，自己提供 sid（因為只有 `NextRequest.cookies`）。

## 決策

採用**方案 Z**，兩個函式均放在 `lib/session/session.ts`。

### 函式職責

| 函式 | 責任 | 呼叫端 |
|------|------|--------|
| `verifySession(sid)` | HMAC 驗證 + Redis lookup，回傳 `SessionData \| null` | `proxy.ts`、`getValidAccessToken` |
| `getValidAccessToken()` | 讀 Cookie → `verifySession` → refresh（含 Redis Mutex），回傳 `accessToken \| null` | Server Component、Route Handler |

### 檔案分工

```
lib/session/session.ts   ← verifySession + getValidAccessToken（公開介面）
lib/auth/refresh.ts      ← refreshTokens()：純 API 呼叫，不讀寫 Redis
```

`refreshTokens` 只負責呼叫 Go API Server 的 `POST /auth/refresh` 並回傳新 token pair，
不包含 Redis Mutex 邏輯。Mutex 邏輯集中在 `getValidAccessToken` 內部。

## Redis 雙重讀取

採用此方案後，每次 SSR 頁面請求 Redis 會被讀取兩次：

1. `proxy.ts` 呼叫 `verifySession` → 確認 session 存在
2. Server Component 呼叫 `getValidAccessToken` → 取得 accessToken（可能觸發 refresh）

**這是刻意設計，不是疏失。**

替代方案是讓 `proxy.ts` 將 `accessToken` 注入 request header，讓 Server Component 直接取用。
但 `accessToken` 是 JWT，注入 HTTP header 會出現在 Access Log，違反「敏感資訊不外洩」原則。

ECS + ElastiCache 同 VPC 下每次 Redis 讀取 < 1ms，雙重讀取的額外成本可忽略。
