# 認證與 Session 規格書

## 1. 概覽

本文件描述 BFF 層的認證機制，涵蓋：

- **Browser ↔ Next.js BFF**：以 `sessionId`（HttpOnly Cookie）識別使用者身份
- **Next.js BFF ↔ API Server**：以 JWT（Access Token + Refresh Token）驗證身份

> **後端 JWT 設計（已對齊 [後端 ADR 007](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md)）：**
>
> - **Access token**：15 分鐘有效，純 stateless 驗證（後端不打 Redis）
> - **Refresh token**：滑動 TTL 1 小時 + 絕對上限 `abs_exp`（依 `client_id` 政策不同：cms-web 8h、public-web 24h、ios-app 180d、android-app 180d）
> - **Family-based rotation**：每次 login 開新 `fid`（family_id），refresh 時旋轉新 `jti`、舊 `jti` 立即失效
> - **Replay detection**：舊 `jti` 再次出現視為重放，整個 family 連帶廢棄（合法者也會被踢回 login）
> - **Grace window**：rotation 後 10 秒內舊 `jti` 重送會回傳等價結果，吸收網路重試而不誤觸重放
> - **Login 必須帶 `client_id`**：BFF 對應 `client_id=cms-web`（或日後新增的 `public-web`），server 對照 policy 表取 TTL；refresh token JWT 的 `aud` 也鎖定 `client_id`
> - **Refresh 失敗一律走 login，禁止自動重試**：自動重試會誤觸 replay detection 連鎖踢人

> **後端 OpenAPI 契約對接重點：**
>
> - 所有成功回應採 envelope：`{ "success": true, "request_id": "...", "data": <T> }`；BFF 在 `lib/auth/*.ts` 解開後不再向 Browser 透傳 envelope，僅以 `X-Request-ID` header 暴露 `request_id`
> - 所有錯誤回應採 envelope：`{ "success": false, "request_id": "...", "error": "<code>", "details": [...] }`；BFF 對 4xx **原樣透傳** body 給 Browser（前端據此處理 validation 錯誤）
> - **後端 error code 字串格式不一致**：snake_case（`token_expired`、`replay_detected`、`username_taken`、`weak_password`、`use_logout_instead`、`invalid_client`、`unauthenticated`、`forbidden`、`session_not_found`、`absolute_expired`、`invalid_token`）與空白分隔（`"invalid input"`、`"too many requests"`、`"resource not found"`、`"validation_error"`）並存——前端**所有 error code 比對**（switch / Set / if 等）必須容忍兩種格式，建議透過 `normalizeErrorCode(s) = s.replace(/\s+/g, '_').toLowerCase()` 統一後再比對；不可硬編單一寫法
> - 欄位命名：後端 snake_case（`access_token`、`expires_in`），BFF 內部與對 Browser 一律 camelCase。轉換層集中於 `lib/auth/*.ts` 與 `lib/api-client/`
> - Login 欄位名：後端 `LoginRequest.username`（**不是 email**），BFF 對 Browser 接受 `username` 也兼容 `email` alias（§8）
> - **`abs_exp` 來源：refresh token JWT claim**（後端 ADR 007 §「Token 規格」line 104 列出 refresh JWT claims 含 `abs_exp`）。BFF 對 refresh token 做 **base64-decode payload 不驗簽**，讀出 `abs_exp` 寫進 session。詳見 §3.1 與 §11.1

### Next.js 16 API 注意事項

Next.js 15 起，`cookies()` 與 `headers()` 改為非同步 API，Next.js 16 延續此設計。
本文件所有「從 Cookie 讀取 sessionId」的實作，包含 Route Handler 與 Server Component，均需 `await`：

```ts
// ❌ Next.js 14 以前
import { cookies } from 'next/headers'
const sid = cookies().get(SESSION_COOKIE_NAME)?.value

// ✅ Next.js 15+ / 16
import { cookies } from 'next/headers'
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie'
const sid = (await cookies()).get(SESSION_COOKIE_NAME)?.value   // production: '__Host-sid'
```

`proxy.ts`（取代 `middleware.ts`）的 `proxy` 函式透過 `NextRequest` 讀取 Cookie，不使用 `next/headers`，不受此影響。

---

## 2. Session 設計

### 2.1 SessionId 格式

```
sessionId = crypto.randomBytes(32).toString('hex') → 64 個 hex 字元
```

- 以 `crypto.randomBytes(32)` 產生 256 bits 加密強度隨機值（OWASP 建議 ≥64 bits，本設計為其 4 倍）
- 純 opaque token，本身不含任何使用者資訊
- 驗證機制：先以格式正則（`/^[0-9a-f]{64}$/`）廉價過濾明顯偽造，再 `GET session:<sid>` 由 Redis lookup 把關有效性
- 不使用 HMAC 簽章：sid 為純粹的 Redis lookup key，驗證時手上沒有可被簽的 message，HMAC 在此場景無實質作用（詳見 ADR 006）

### 2.2 Session Store（Redis）

```
Key:   session:<sessionId>
Value: JSON {
  userId:       string,
  clientId:     string,   // 對應後端 client policy（cms-web / public-web / ...），refresh 時帶回
  accessToken:  string,   // JWT Access Token（15 分鐘有效）
  refreshToken: string,   // JWT Refresh Token（滑動 1h + abs_exp）
  expiresAt:    number,   // Unix timestamp（access token 到期時間，毫秒）
  absoluteExpiresAt: number, // Unix timestamp（refresh token 的 abs_exp，毫秒；refresh 不延長此值）
  createdAt:    number,   // Unix timestamp（毫秒）
}
TTL:   min(SESSION_TTL_SECONDS, Math.floor((absoluteExpiresAt - now) / 1000))   // 秒；absoluteExpiresAt 與 now 為 ms
```

**TTL 規則：**

- BFF Redis session TTL 不可超過後端 `abs_exp`：使用者超過 `abs_exp` 後，後端 refresh 端點會回 `401 absolute_expired`（OpenAPI `ErrorResponse.error` 之一），繼續保留 session 沒有意義
- 採**滑動過期（Sliding Expiry）**：每次 `getValidAccessToken()` 成功回傳 token 時，執行 `EXPIRE session:<sid> min(SESSION_TTL_SECONDS, remaining_absolute_seconds)` 重置 TTL
- 使用者持續活躍且未達 `abs_exp` → session 不過期；閒置超過 `SESSION_TTL_SECONDS` 或達 `abs_exp` → 自動失效

> **為何要存 `clientId`**：後端 ADR 007 規定每個 client 有獨立 refresh / absolute TTL 政策（cms-web 1h/8h、public-web 1h/24h、ios-app 30d/180d）。login 時 BFF 帶哪個 `client_id` 給後端，refresh 時也必須一致（refresh token JWT 的 `aud` 鎖定 `client_id`，跨 client 換發會被擋）。

> **為何同時存 `expiresAt` 與 `absoluteExpiresAt`**：兩者語意不同：
>
> - `expiresAt`：access token 何時過期（每次 refresh 後更新為 `now + 15min`）
> - `absoluteExpiresAt`：family 的絕對上限（login 時計算後一路沿用，rotation 不延長）
>
> BFF 需要 `expiresAt` 判斷是否要 refresh、需要 `absoluteExpiresAt` 判斷是否該直接踢回 login（避免明知會 `401 absolute_expired` 還浪費一次 refresh 呼叫）。

### 2.3 Redis 連線（Singleton）

Next.js 開發模式的 HMR 會重新執行模組，若直接 `new Redis()` 每次 HMR 都會建立新連線而舊連線不關閉，導致連線數持續累積。解法是將實例存在 `globalThis`——它在 Node.js 程序的生命週期內不受 HMR 影響：

```ts
// src/lib/session/redis.ts
import Redis from 'ioredis'
import { config } from '@/lib/config'

const globalForRedis = globalThis as typeof globalThis & { redis?: Redis }

export const redis =
  globalForRedis.redis ??
  new Redis({
    host:                 config.redis.host,
    port:                 config.redis.port,
    password:             config.redis.password,
    db:                   config.redis.db,
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
  })

if (!config.isProd) {
  globalForRedis.redis = redis
}
```

生產環境（`next start`）模組只載入一次，不需要 `globalThis` 機制，`if` 區塊不執行。

### 2.4 Cookie 設定

| 屬性 | 值 | 說明 |
|------|-----|------|
| `Name` | `__Host-sid`（production）/ `sid`（dev） | production 採 `__Host-` 前綴：強制 `Secure` + `Path=/` + **禁止 `Domain` 屬性**，瀏覽器層直接擋掉跨子網域注入。dev 用 `sid` 是因為 `__Host-` 前綴要求 HTTPS，本機 HTTP 不適用 |
| `HttpOnly` | `true` | JavaScript 無法讀取，防 XSS 竊取 |
| `Secure` | `true`（production） | 僅 HTTPS 傳送；使用 `__Host-` 前綴時瀏覽器強制此屬性，少設會被丟棄 |
| `SameSite` | `Lax` | 防 CSRF，允許頂層導覽攜帶 Cookie |
| `Path` | `/` | 全站有效；`__Host-` 前綴強制此值 |
| `MaxAge` | `min(SESSION_TTL_SECONDS, Math.floor((absoluteExpiresAt - now) / 1000))` | 與 Redis TTL 同步；達 abs_exp 後 cookie 自動失效，等同 server-side TTL 兜底。**單位為「秒」**：`absoluteExpiresAt` 與 `now` 皆為 `Date.now()` 等級（ms），相減後須 `/1000` 才能餵給 cookie `MaxAge`——少算這層會讓 cookie 立刻失效 |
| `Domain` | **不設**（Host-only cookie，最安全） | `__Host-` 前綴**禁止** `Domain` 屬性。若未來業務需要跨子網域共享 session，必須改名（不能用 `__Host-` 前綴）並另開 ADR 評估安全影響；**禁止設為 `.playerledger.com` 等通配形式**——任一子網域 XSS 即洩漏 sid |
| `Partitioned` | **不設** | CHIPS（第三方 cookie 分區）僅適用於 cross-site iframe 嵌入；本架構是 first-party only，加上反而限制功能且不增加安全性。若未來需要被嵌入到第三方頁面才評估 |

> **為何用 `__Host-` 前綴：** 它是瀏覽器原生的「我絕對是 host-only cookie」宣告，攻擊者即使透過 Cookie injection 漏洞嘗試從子網域寫入也會被瀏覽器拒絕（任何帶 `Domain=` 屬性的同名 cookie 都會被丟掉）。RFC 6265bis §4.1.3 規範。

> **變數命名注意：** spec 02 後續所有「`sid` cookie」字樣，在 production 環境實際 name 為 `__Host-sid`。`request.cookies.get(SESSION_COOKIE_NAME)` 應從 `lib/session/cookie.ts` 匯入常數，不要硬編。

### 2.5 Client session model（Browser 端 session 資訊來源）

Browser 端有兩類需要 session 資訊的場景：
- **顯示用**：navbar 顯示登入者、頁面右上角頭像
- **行為用**：idle timer 比對 `absoluteExpiresAt`、跨分頁 stale message 用 `createdAt` 過濾、log emission 用 `userId`

`sid` cookie 是 `HttpOnly`、Browser JS 讀不到；Redis session 資料只在 BFF 端。Client 必須有個獨立的「投影 session 視圖」，供以上場景同步讀取。

#### 設計原則

| 原則 | 落地 |
|------|------|
| **不重複可信來源** | Redis session 是唯一 source of truth；client 只持有「投影」副本，過期 / 無效以 server 為準 |
| **不需新端點** | v1 不開 `/api/session/me`；改由 layout server component 讀 Redis → SSR 注入 `<SessionProvider initialSession>` |
| **不存 token** | Client session 只含 non-sensitive 欄位（`userId / clientId / absoluteExpiresAt / createdAt`），**絕對不含** `accessToken / refreshToken / sid` |
| **整頁載入即同步** | login / logout / idle expire 一律 `window.location.replace` 整頁載入；不需 in-app session refresh 機制（v1 不做 SPA-style session sync） |
| **與 server 不一致時，server 贏** | Component 發 API 失敗 401 → 走原本「導 login」流程；不嘗試用 client 投影自我修復 |

#### 形狀

```ts
// src/lib/session/client-session.ts
export type ClientSession = {
  userId:            string
  clientId:          string     // 'cms-web' 等
  absoluteExpiresAt: number     // ms，與 server 端相同欄位
  createdAt:         number     // ms，本次 login 建立 sid 的時間
}
```

注意：**無 `expiresAt` 欄位**——access token 到期由 BFF 內部 mutex 處理，client 不關心；無 `sid`——HttpOnly，本來就拿不到。

#### 注入流程

```
┌── app/(cms)/layout.tsx (Server Component) ──┐
│  const session = await verifySession(sid)    │
│  if (!session) redirect('/login')            │
│  const initial: ClientSession = {            │
│    userId:            session.userId,        │
│    clientId:          session.clientId,      │
│    absoluteExpiresAt: session.absoluteExpiresAt,
│    createdAt:         session.createdAt,     │
│  }                                           │
│  return (                                    │
│    <SessionProvider initialSession={initial}>│
│      {children}                              │
│    </SessionProvider>                        │
│  )                                           │
└──────────────────────────────────────────────┘
                  │
                  ▼
┌── SessionProvider (Client Component) ───────┐
│  'use client'                                │
│  const [session] = useState(initialSession)  │
│  return <Ctx.Provider value={session}>...    │
└──────────────────────────────────────────────┘
                  │
                  ▼
┌── 任意子 Client Component / hook ───────────┐
│  const session = useSession()  // never null │
│  // navbar, idle timer, log emission ...    │
└──────────────────────────────────────────────┘
```

#### API

```ts
// src/lib/session/client-session.ts
'use client'

import { createContext, useContext } from 'react'

const SessionContext = createContext<ClientSession | null>(null)

export function SessionProvider(props: {
  initialSession: ClientSession
  children: React.ReactNode
}): JSX.Element

/**
 * 受保護區段 Client Component 唯一的 session 取得方式。
 * 若呼叫端在 SessionProvider 外（例如 /login page），throws ——
 * 強制呼叫端要嘛在受保護區段、要嘛根本不依賴 session。
 */
export function useSession(): ClientSession

/**
 * 公開區段（login page）使用：不 throw，回 null。
 * 用於「navbar 顯示登入按鈕 / 已登入頭像」等 conditional UI。
 */
export function useSessionOptional(): ClientSession | null
```

#### 更新時機

| 事件 | client session 行為 |
|------|-------------------|
| Login 成功 | login page 收到 200 後 `window.location.replace(redirectUrl ?? '/players')`；整頁載入後 layout 重新跑 SSR → fresh `initialSession`。預設落點為 CMS 入口 `/players`（玩家搜尋頁，[`08`](./08-screen-player-search.md)）——本系統無根 `/` 頁 |
| Logout（手動 / idle / cross-tab） | `window.location.replace('/login?reason=...')`，layout SSR 因 `verifySession` 回 null 而 `redirect('/login')`；client session 隨之消失 |
| Token refresh（後端 rotation） | **不更新 client session**——`absoluteExpiresAt` rotation 不延長（後端 ADR 007），client 投影本就正確；`accessToken` 不在投影內 |
| Abs_exp 過期但使用者在頁面上 | idle timer abs_exp short-circuit 觸發 onExpire → 走 logout 路徑（同上） |

#### 為何不開 `/api/session/me`

| 替代方案 | 缺點 |
|---------|------|
| **v1 採用：SSR 注入 + 整頁載入** | 多一次 SSR roundtrip？不會——本來就有 layout SSR；新增的是 session 物件序列化（< 200 byte） |
| 每次掛 provider 都 fetch `/api/session/me` | 多一次 RTT、會有「session 載入中」狀態要處理、與 SPA 風格不符（本架構是 RSC + 整頁載入） |
| 用 `cookies()` 直接從 layout 解析 sid 給 client | client 拿不到 HttpOnly cookie，無從 hydrate |

> **何時開 `/api/session/me`**：未來若引入「不重整頁面切換 client_id」或「SPA-style session 切換」需求，再評估開此端點 + revalidator hook。

#### 測試（補入 §9）

```ts
// src/lib/session/client-session.test.tsx
it('useSession should throw when called outside SessionProvider')
it('useSessionOptional should return null when called outside SessionProvider')
it('useSession should return the initial session value provided to the provider')
it('SessionProvider should NOT include accessToken / refreshToken / sid in the value object')
it('SessionProvider should serialize across SSR boundary without throwing')   // Next.js RSC payload
```

---

## 3. 認證流程

### 3.1 登入流程

```
Browser              Next.js BFF                    Redis         API Server
   │                      │                           │                │
   │─ POST /api/login ───▶│                           │                │
   │  { username, pass }  │── POST /auth/login ─────────────────────────▶│
   │                      │   { username, password,                      │
   │                      │     client_id: "cms-web" }                   │
   │                      │◀── 200 {                                     │
   │                      │      success: true, request_id,              │
   │                      │      data: { access_token,                   │
   │                      │              refresh_token,                  │
   │                      │              token_type: "Bearer",           │
   │                      │              expires_in,                     │
   │                      │              refresh_expires_in              │
   │                      │            } } ──────────────────────────────│
   │                      │                           │                │
   │                      │ readJwtClaims(refresh_token).abs_exp        │
   │                      │   ← BFF 從 refresh JWT claim 取出 abs_exp    │
   │                      │     （不驗簽，純 base64-decode payload；§11.1）│
   │                      │                           │                │
   │                      │── DEL session:<oldSid> ──▶│  ← fixation 防護(§6.2)
   │                      │── SET session:<newSid> ──▶│                │
   │                      │  TTL: min(SESSION_TTL, abs_exp - now)      │
   │                      │                           │                │
   │◀─ 200 { userId } ────│                           │                │
   │  Set-Cookie: __Host-sid=<newSid>; HttpOnly; ...                   │
```

**實作重點：**

1. Next.js BFF 驗證 request body：`username` 非空且 ≤ 128 字、`password` 非空且 ≤ 256 字（對齊後端 OpenAPI `LoginRequest` 約束）
1.5. **Account-level lockout check**：取 `usernameHash = sha256(username).slice(0,8).hex()`；查 `GET login:fail:<usernameHash>`，若 ≥ 5 → 回 `429 { error: "account_locked" }` + `Retry-After: <ttl 秒>`；Redis 故障 → fail-closed 503（同 IP 層 login 邏輯）。詳見 §6.3
2. 呼叫 API Server `POST /auth/login`，body **必須帶 `client_id`**（BFF 對應 `cms-web`，由 `CLIENT_ID` 環境變數注入）；前端送 `email` 也接受，BFF 將 `email` 欄位映射到後端 `username`（後端僅認 `username` 一個欄位名）
2.5. **登入結果回寫 account lockout 計數**：
  - 後端 401（invalid credentials） → `INCR login:fail:<usernameHash>` 並 `EXPIRE 900` 若新建（用 Lua 確保 atomic：`EXPIRE NX` 等效；ioredis 寫 `redis.call('INCR', k); if redis.call('TTL', k) < 0 then redis.call('EXPIRE', k, 900) end`）
  - 後端 200（success） → `DEL login:fail:<usernameHash>`（成功登入清除累積，避免合法使用者偶爾打錯被累積到鎖）
  - 後端 5xx / 網路錯誤 → **不動計數**（這不是 credential 錯誤，不應計入 lockout）

> **BFF→Browser 錯誤狀態對應——「契約內透傳、契約外翻譯」（gateway 語意，spec 01 §4.2）：**
>
> 核心原則：HTTP 狀態碼描述的是「Browser↔BFF」這一段的關係。`/auth/login` 的 OpenAPI 契約**只文件化 `200 / 400 / 401 / 429`**。
>
> - **契約內的客戶端狀態（400 / 401 / 429）→ 原樣透傳**：這些對 Browser「有意義且可處理」（改帳密、改輸入、稍後重試），BFF 帶回上游狀態與 error code。
> - **契約外的狀態（403 / 404 / 405 / 5xx）、回應非 JSON、或 2xx 但 envelope/JWT 不符契約 → 翻成 `502`**：對「固定上游目標」的 login 呼叫，這些只可能是路由/設定/上游故障，Browser 無從處理。把它們鏡射回去（例如回 404）會**誤導**——`/api/login` 明明存在、使用者也沒做錯。**更不可降級成 500**（500 = BFF 自身崩潰）。
>
> | 來源 | BFF 回 Browser | 載體 |
> |---|---|---|
> | 後端 401（帳密錯） | `401 { error: <code> }` | `InvalidCredentialsError` |
> | 後端 429 / account lockout | `429` + `Retry-After` | `LoginError` |
> | **後端 400（契約內 BadRequest）** | **`400` 透傳上游 error code** | `LoginError`（帶明確 `status: 400`） |
> | BFF 端 body 驗證失敗（長度等，未打上游） | `400 invalid_input` | `LoginError` |
> | Redis 故障（fail-closed） | `503 service_unavailable` | `LoginError` |
> | **後端契約外狀態（403 / 404 / 405 / 5xx）、回應非 JSON、envelope/JWT 契約違反** | **`502 upstream_failure`** | `UpstreamError` |
> | **網路無法連線 / 逾時** | **`504 upstream_timeout` / `502`** | `UpstreamError`（`timeout` 旗標） |
> | BFF 自身未預期例外 | `500 server_error` | — |
>
> > **為何 404 不鏡射成 404（對比通用 proxy）**：通用 proxy（[`01 §4.2`](./01-bff-architecture.md)）對任意資源路徑**透傳** 4xx，因為那裡的 404 是「使用者查的資源不存在」——契約內、有意義。但 login 是**固定端點呼固定上游路徑**，404 只能代表「上游路徑錯/未部署」（如後端移除 `/api/v1` 後未重啟），契約裡也沒有 404 → 屬 gateway 故障 → 502。判準是「該狀態是否在此端點的契約內、是否對 caller 有意義」，而非「是不是 4xx」。
>
> **告警/UX 後果**：502/504 應觸發 on-call（gateway 故障）並讓前端顯示「系統暫時無法處理」；若誤鏡射成 404/500，既不告警、又讓使用者以為自己出錯而無限重試。
>
> **防禦式解析**：上游 body 未必是 JSON（如後端 Gin 預設 404 回 `text/plain` `"404 page not found"`）。BFF 須先讀 text 再 `try { JSON.parse }`，**不可直接 `response.json()`**——否則非 JSON body 丟 `SyntaxError`，被誤判為 BFF 500。`lib/auth/login.ts` 以 `UpstreamError`（`code` / `upstreamStatus` / `timeout`）承載 gateway 故障，與 `LoginError`（credential / 契約內客戶端錯誤，可帶明確 `status`）分離。
3. 解開後端 envelope `{ success, request_id, data }`，從 `data` 取得 token pair：
   - `access_token`、`refresh_token`
   - `expires_in`（秒）→ BFF 計算 `expiresAt = Date.now() + expires_in * 1000`
4. **從 `refresh_token` JWT claim 取 `abs_exp`**（後端 ADR 007 line 104 規定 refresh JWT claims 含 `abs_exp`）：
   ```ts
   const claims = readJwtClaims(refreshToken)   // base64-decode payload, 不驗簽
   const absoluteExpiresAt = claims.abs_exp * 1000   // claim 是 unix seconds, 轉 ms
   ```
   此值供 BFF 設 Redis TTL / Cookie MaxAge / §3.4 step 4 提早 short-circuit 使用，**只作為 hint**——真正的安全把關仍在後端（後端 refresh 端點會用自己 Redis state 的 `AbsoluteExp` 驗證，BFF 看到的 claim 是否被竄改不影響安全）。詳見 §11.1。
5. **Session fixation 處理：** 不論 incoming `sid` cookie 是否存在 / 合法 → 先 `DEL session:<incomingSid>`（若有），再產生新 sid 寫入（§6.2）
6. 在 Redis 建立 session，key 為新產生的 sessionId；TTL 取 `min(SESSION_TTL_SECONDS, (absoluteExpiresAt - now) / 1000)`
7. 回傳給瀏覽器的 body 只含 `{ userId }`，不含任何 token；不轉發後端 `request_id` 到 body（已透過 `X-Request-ID` response header 傳遞）
8. **Login page client component 在收到 200 後**：呼叫 `createAuthChannel({ onMessage: () => {} }).postLogin(userId)` 廣播 `{ type: 'login', userId, at, nonce }`，**然後** `window.location.replace(redirectUrl ?? '/players')`；廣播須在導頁前完成（BroadcastChannel `postMessage` 同步寫入，安全）

> **後端欄位命名對應：** 後端 OpenAPI 採 snake_case，BFF 內部型別採 camelCase。轉換層集中在 `lib/auth/login.ts` 與 `lib/auth/refresh.ts`，**不污染 SessionData 結構**。

> **`username` vs `email`：** 後端 OpenAPI `LoginRequest.required: [username, password, client_id]`，欄位名為 `username`。本應用 `username` 實質上即 email（後端 `UserService` 以 email 作 lookup），但欄位**契約名稱必須是 `username`**，BFF 在送出前做映射。

> **為何 BFF 不自己決定 `client_id`：** 雖然目前 BFF 只服務 CMS 後台（固定 `cms-web`），未來若同一 Next.js BFF 同時服務公開 web（`public-web`），會由部署環境變數區分；硬編碼會綁死，做成 config 才能切換。

> **為何 BFF 不驗簽就直接讀 refresh JWT claim 安全：** BFF 沒有 `JWT_REFRESH_SECRET`（也不應該有），無法驗簽。但 `abs_exp` 在 BFF 端**只用作 hint**——不論值是否被竄改，安全把關都在後端：
> - 若竄改成更大值 → BFF 誤判 family 還活著，繼續打 refresh → 後端 `VerifyRefresh` 從 Redis state 取真實 `AbsoluteExp`，拒絕
> - 若竄改成更小值 → BFF 提早 short-circuit，使用者比預期早登出（DoS but no security breach）
> - 攻擊者本來就有 refresh JWT 才能竄改，他能竄改不代表他知道 secret，仍無法簽出有效新 token
>
> 此模式為標準 BFF / SDK 行為（同 Auth0 SDK、Okta SDK、Microsoft Identity 等）。詳見 §11.1。

#### 登入頁 UI 設計（v1）

`/login` 路由的 client component（`app/(auth)/login/page.tsx`）視覺與互動規格。styling 堆疊與元件來源見 [ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)。

**版型**：居中卡片 + 漸層背景，桌機與行動裝置共用同一版型。

```
┌─────────────────────────────────────────────┐
│        （bg-gradient slate-50 → 200）       │
│        + 角落 indigo / fuchsia 光暈         │
│                                              │
│       ┌───────────────────────────┐          │
│       │     ◆ Wallet icon         │          │
│       │     PlayerLedger          │          │
│       │     登入後台以查詢…       │          │
│       │                            │          │
│       │   帳號                     │          │
│       │   [____________________]   │          │
│       │                            │          │
│       │   密碼                     │          │
│       │   [____________________]   │          │
│       │                            │          │
│       │   [! 錯誤訊息 ]（如有）    │          │
│       │                            │          │
│       │   [        登入        ]   │          │
│       └───────────────────────────┘          │
│                                              │
│        © PlayerLedger · 內部後台            │
└─────────────────────────────────────────────┘
```

**元件對應**（皆來自 `src/components/ui/*`，遵循 [ADR 021](../adr/021-tailwind-v4-shadcn-ui.md) 元件規約）：

| 區塊 | shadcn primitive |
|------|------------------|
| 卡片外殼 | `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` |
| 帳號 / 密碼欄位 | `Input` + `Label`（`htmlFor` 對應 input `id`） |
| 提交按鈕 | `Button`（`variant="default"`、`className="w-full"`） |
| 錯誤訊息 | `Alert variant="destructive"` + `AlertDescription` |
| logo / loading icon | `lucide-react` 的 `Wallet` / `Loader2`（後者 `className="animate-spin"`） |

**視覺實作（Tailwind classes，`(auth)` 群共用設計系統）**：

本表為 `/login` 已落地實作的 source of truth；`/register`（[`13`](./13-screen-register.md)）與未來 `(auth)` 群新增頁面**直接沿用**，僅文案／欄位不同。

| 區塊 | 角色 | Tailwind class |
|------|------|----------------|
| `<main>` 外殼 | 全頁版型 + 漸層底 + 光暈 clip | `relative grid min-h-screen place-items-center overflow-hidden bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 px-4 py-12` |
| 右上光暈 blob | `<div aria-hidden="true">` | `pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl` |
| 左下光暈 blob | `<div aria-hidden="true">` | `pointer-events-none absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-fuchsia-200/30 blur-3xl` |
| `Card` 容器 | 居中卡片浮起 | `relative w-full max-w-sm shadow-xl` |
| `CardHeader` | 標題區置中 | `space-y-1 text-center` |
| Logo 方塊 | Wallet icon 包裝盒 | `bg-foreground text-background mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl` |
| `Wallet` icon | 品牌圖示 | `size-6` |
| `CardTitle` | 主標 | `text-2xl font-semibold tracking-tight` |
| `CardDescription` | 副標 | 預設樣式（`text-muted-foreground text-sm`） |
| `<form>` | 表單區 | `space-y-4` |
| 欄位包裝（`<div>` wrap Label + Input） | label-input 一組 | `space-y-2` |
| `Alert` 錯誤 | shadcn 預設 | 預設樣式（無額外 class） |
| Submit `Button` | 全寬主按鈕 | `w-full` |
| `Loader2` icon | loading 動畫 | `animate-spin` |
| Footer `<p>` | 底部 © 標語 | `text-muted-foreground absolute bottom-6 text-xs` |

> **設計意圖（why this class palette）**：
>
> - **slate 漸層 + indigo / fuchsia 光暈**：低飽和中性底 + 高彩光暈製造現代 SaaS 感（Vercel / Linear / Resend 同手法）；光暈用 `blur-3xl` + `/40` `/30` opacity 確保不搶卡片視覺焦點
> - **`max-w-sm`（24rem = 384px）**：3 欄位以下的窄表單慣例；放寬到 `max-w-md` 會顯得空曠
> - **`shadow-xl`**：與光暈 blob 共構景深，卡片明顯浮於背景；用 `shadow-2xl` 反而過重
> - **Logo box `h-12 w-12`（48px）** + **icon `size-6`（24px）= 50% icon 比例**：黃金比例，icon 太大會撐爆框、太小則 box 顯多餘
> - **`text-2xl font-semibold tracking-tight`**：title 在 24px + semibold 視覺重量適中；`tracking-tight` 縮緊字距讓品牌名「PlayerLedger」整體看起來更俐落
> - **Footer 用 `absolute bottom-6`**：避免被表單高度影響——`/login`、`/register` 卡片高度不同，footer 仍貼底，整體節奏一致

**響應式**：

- `max-w-sm` 在最小 320px 手機仍 fit 良好（`px-4` 提供 16px 左右安全距離）
- 光暈用 `-top-32 -right-32` 偏移 + `overflow-hidden` 在外殼，小螢幕不會撐出水平捲軸
- v1 桌機與手機共用同一版型；不額外處理 tablet breakpoint

**Dark mode**：v1 不啟用（[ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)）。`slate` / `indigo` / `fuchsia` 為標準 Tailwind 調色盤，未來啟用 dark mode 時：
- 漸層改 `dark:from-slate-900 dark:via-slate-800 dark:to-slate-700`
- 光暈 opacity 調低（如 `dark:bg-indigo-500/20`）避免在深底太刺眼
- Logo box `bg-foreground` 已用 CSS variable，自動適應

**文案 token（繁中，鎖定不可換）**：

| 用途 | 文字 |
|------|------|
| 卡片標題 | `PlayerLedger` |
| 卡片副標 | `登入後台以查詢玩家儲值紀錄` |
| 帳號 label | `帳號` |
| 密碼 label | `密碼` |
| 提交按鈕（閒置） | `登入` |
| 提交按鈕（loading） | `登入中…`（U+2026 ellipsis） |
| Footer | `© PlayerLedger · 內部後台` |
| Fallback 錯誤（fetch 失敗無 message 時） | `登入失敗` |
| Fallback 網路錯誤 | `網路錯誤` |

**表單行為**：

1. `<input>` 套 `autoComplete="username"` / `"current-password"`，配合瀏覽器密碼管理員。
2. 兩個 input 皆 `required`；交由 HTML constraint 攔截全空提交，BFF 不需另接「全空」case。
3. Loading 期間：兩個 input 與 submit button 全 `disabled`；按鈕文字切「登入中…」並前置 `Loader2` 動畫圖示（圖示 `aria-hidden`）。
4. 後端回非 2xx：把 `data.message || data.error || '登入失敗'` 寫入 `Alert`（`role="alert"`）；不清空欄位，方便使用者修正再送。
5. `fetch` 自身 reject（網路斷線）：顯示 `err.message || '網路錯誤'`，同樣走 Alert。
6. 後端 200：以 `safeRedirectTarget(?redirect=...)` 取目的，呼叫 `window.location.replace(target)`；safeRedirectTarget 規則：必須 `/` 開頭且不可為 `//...`（protocol-relative），否則 fallback `/players`（預設落點，見 [§2.5 client session 行為表](#25-client-session-model)），防 open-redirect。
7. **不**自己處理 CSRF token：cookie `SameSite=Lax` + `Origin` check 由 BFF 把關（[§6.1](#61-csrf-防護)），UI 層不需動。
8. **不**廣播 BroadcastChannel：步驟 8 的 `postLogin()` 廣播由 v1 共識「v1 不做 SPA-style cross-tab login sync」延後實作；待 [§5.6](#56-多分頁協調) AuthChannel 落地後再回頭補（[§9 Component 測試](#component-測試react-testing-library)有 TODO 標註）。

**安全 / 無障礙**：

- HttpOnly cookie 由 BFF response 寫入；UI 端不可讀 / 寫 cookie，本頁無 `document.cookie` 操作。
- 表單以 `<form onSubmit>` 提交、按鈕為 `<button type="submit">`，Enter 鍵自動觸發提交（不依賴 keydown handler）。
- `<Label htmlFor>` 對應 `<input id>`，滿足 `getByLabelText` 與螢幕閱讀器語意。
- `Alert` 預設 `role="alert"`，錯誤訊息出現時自動 announce。
- 對比度由 shadcn OKLCH 色票兜底（前景／背景與 destructive 變體均 ≥ 4.5:1）。
- Inter 字型（[ADR 021](../adr/021-tailwind-v4-shadcn-ui.md)）透過 `next/font/google` 提供，含 swap fallback 系統字。

**註冊入口與成功 banner**（v1.x，配合 [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md) + [`13-screen-register.md`](./13-screen-register.md)）：

- Card「登入」按鈕下方加上分隔線 + secondary text「`還沒有帳號？建立 CMS 帳號`」，後 7 字為 `<Link href="/register">`；不用 `Button`（語意為導航而非動作）。
- `useSearchParams().get('registered') === 'true'` 時，表單上方渲染 `Alert variant="default"` + `CheckCircle2` 圖示，文案「`註冊成功，請以新帳號登入`」。整頁載入後（使用者登入）banner 自然消失，不需手動清除。
- 與既有 `?reason=...`（logout 原因，v2 預留）並存時：success banner 在最上方、`?reason` banner 緊接其下、再到表單，不互相覆蓋。
- 完整版型、文案與測試清單見 [`13-screen-register.md §7`](./13-screen-register.md)；註冊政策、API 契約、error code 對應見 [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md)。本節僅描述 `/login` 端的接點。

### 3.2 登出流程

```
Browser           Next.js BFF                 Redis         API Server
   │                   │                        │                │
   │─ POST ───────────▶│                        │                │
   │  /api/logout      │── GET session ────────▶│                │
   │                   │◀─ { accessToken,                          │
   │                   │     refreshToken }                        │
   │                   │── POST /auth/logout ──────────────────────▶│
   │                   │   Authorization: Bearer <accessToken>      │
   │                   │   body: { refresh_token: <refreshToken> }  │
   │                   │◀── 204 No Content（失敗亦忽略）───────────│
   │                   │── DEL session ────────▶│                │
   │◀─ 200 OK ─────────│                        │                │
   │  Set-Cookie: __Host-sid=; MaxAge=0                            │
```

**實作重點：**

1. 從 Cookie 取出 `sid`；若無，直接回傳 200（無 session 可清，仍送 `Set-Cookie` 清除以防舊 cookie 殘留）
2. `GET session:<sid>` 取得 `accessToken` 與 `refreshToken`（兩者都要送給後端 logout 才能完整撤銷 family）
3. 呼叫 `POST /auth/logout`：
   - Header: `Authorization: Bearer <accessToken>`
   - **Body: `{ "refresh_token": "<refreshToken>" }`**（**必填送出**，後端據此呼叫 `FamilyStore.Revoke` 廢掉整個 family）
   - 預期後端回 `204 No Content`；任何錯誤（網路、401、5xx）均忽略，繼續步驟 4
4. `DEL session:<sid>`，清除 BFF Redis session
5. 回應 Browser `200 OK`，body `{}`，附 `Set-Cookie: __Host-sid=; Max-Age=0`
6. **手動登出觸發點**（UI 元件呼叫 `POST /api/logout` 前）：先呼叫 `authChannel.postLogout()` 廣播 `{ type: 'logout', at, nonce }`，讓其他分頁同步跳 login（idle 觸發的 logout 由 IdleTimerProvider 自行廣播，見 §5.5.3 onExpire）

**為何必須送 refresh_token 給後端：** 後端 OpenAPI 標示 `LogoutRequest.refresh_token` 為 optional，但語意上「無 refresh_token 的 logout」**只會 blacklist 當下 access token 的 jti**，refresh family 仍存活到 abs_exp（cms-web 8 小時）。期間若 refresh token 從 Redis dump / log accident 洩漏，攻擊者可用它持續換發新 access token，BFF 已清 session 也擋不住。送 `refresh_token` 才會觸發後端 `FamilyStore.Revoke`，把整個 family 在 Redis 直接刪掉。

**為何後端 logout 失敗仍繼續：** BFF session 是 Browser↔BFF 的存取控制邊界，無論後端狀態如何 BFF session 必須清掉。後端 logout 失敗最多讓 refresh family 多活到 abs_exp（已是已知上限）；BFF session 和 Cookie 既已清除，攻擊者無法透過正常的 BFF 流程利用它。後端失敗的個案會在 observability metric `auth.logout.upstream_failure` 累計，supervisor 可監看。

**為何 logout 不重試後端：** 與 refresh 同理（後端 ADR 007 replay detection），但更多是「使用者已經點下登出，重試只會延遲畫面」的 UX 考量。重試成功與否對結果幾乎沒幫助（BFF 端已清乾淨）。

### 3.3 受保護請求流程

```
Browser            Next.js BFF             Redis         API Server
   │                    │                    │                │
   │─ GET /api/players ─▶│                    │                │
   │  Cookie: sid=<id>  │─ GET session:<id> ─▶│                │
   │                    │◀─ { accessToken, expiresAt, ... }───│
   │                    │                    │                │
   │                    │ [若 access token 即將過期 → 3.4]     │
   │                    │                    │                │
   │                    │─ GET /players ───────────────────────▶│
   │                    │  Authorization: Bearer <accessToken>   │
   │                    │◀─ 200 { players } ────────────────────│
   │◀─ 200 { players } ─│                    │                │
```

### 3.4 Token Refresh 流程（靜默更新 + Mutex）

當 `accessToken` 距離 `expiresAt` 剩餘時間 < `REFRESH_THRESHOLD`（建議 3 分鐘，後端 access TTL 為 15 分鐘）時，BFF 自動更新。

> **後端 ADR 007 配合事項（critical）：**
>
> - 後端 refresh 端點實作 **family-based rotation + replay detection**：舊 `jti` 再次出現（grace window 10s 外）會觸發重放偵測，整個 family 立即廢棄、所有裝置被踢
> - **Refresh 失敗一律走 login，禁止自動重試**（無論是網路錯誤、401、5xx），自動重試會誤觸 replay detection 連鎖踢人
> - 後端 401 細分多種 error code（OpenAPI `ErrorResponse.error`）：`token_expired`（refresh exp 過）、`absolute_expired`（達 family abs_exp）、`invalid_token`（簽章/iss/aud 失敗）、`replay_detected`、`session_not_found`；前端處理方式相同（清 session、跳 login），但 BFF observability log 應分開以利 debug

**Race Condition 問題：** 頁面若同時發出多個 API 請求，每個請求都會獨立偵測到「需要 refresh」，並拿同一個 refresh token 同時呼叫 API Server。後端 rotation 後第一個請求成功，其餘命中 grace window（10 秒內）能拿到等價回應、超出 grace window 則觸發重放 → family 廢、使用者被強制登出。即便有 grace window，仍須以 mutex 收斂 refresh 呼叫，理由：
1. Grace window 只覆蓋 10 秒；若多請求分布超過此窗口（例如 SSR + 客戶端互動同時觸發），仍會觸發重放
2. 多重 refresh 即便都成功也浪費後端 Lua CAS 與 BFF↔API 來回，無價值

**解法：Redis Mutex（`SET NX EX`）**

在執行 refresh 前以 Redis 原子操作搶佔一把鎖，確保同一 session 同一時間只有一個請求執行 refresh。其他請求等鎖釋放後重讀 session，直接取用已更新的 token。此設計同時對跨 ECS container 的並發有效（Redis 是各 container 的共享協調點）。

```
Mutex Key: refresh_lock:<sessionId>
Value:     "1"
TTL:       10 秒（安全網：持鎖者 crash 時自動釋放，避免鎖永久卡死）
```

**getValidAccessToken 完整演算法：**

```
── verifySession 負責的部分 ──────────────────────────────────────────

1. (await cookies()).get(SESSION_COOKIE_NAME)?.value   // 從 lib/session/cookie.ts 匯入常數
   └─ 不存在 → return null

2. isWellFormed(sid)（/^[0-9a-f]{64}$/）
   └─ 格式不合 → return null（不打 Redis，省成本）

3. GET session:<sid>
   └─ 不存在 → return null
   └─ 存在   → SessionData

── getValidAccessToken 負責的部分（使用 SessionData）──────────────────

4. absoluteExpiresAt - now ≤ 0？
   └─ 是 → DEL session:<sid>，return null
          （已達後端 abs_exp，refresh 必然失敗，省一次後端呼叫；也防止觸發重放）

5. expiresAt - now > REFRESH_THRESHOLD？
   └─ 是 → EXPIRE session:<sid> min(SESSION_TTL_SECONDS, remaining_absolute)
          → return session.accessToken                 ← 快速路徑，絕大多數請求走這裡

6. SET refresh_lock:<sid> "1" NX EX 10
   ├─ 成功（搶到鎖）→ 步驟 7
   └─ 失敗（別人持鎖）→ 步驟 8

7. 【持鎖者】refreshTokens(session.refreshToken)
   ├─ 成功 → **SET session:<sid> 必須走 CAS**（避免 concurrent logout 復活已刪 session）：
   │           執行 Lua script 確保 atomic：
   │             if redis.call('EXISTS', KEYS[1]) == 1 then
   │               redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
   │               return 1
   │             else
   │               return 0   -- session 已被 concurrent logout 刪掉，放棄
   │             end
   │           或用 `SET ... XX EX <ttl>`（XX = only if exists）達到相同效果
   │
   │         若 CAS 回傳 0（session 已不存在）：
   │           - 不寫入新 token（不可復活已登出的 session）
   │           - 仍呼叫後端 logout 撤銷剛拿到的新 family（背景非阻塞，失敗忽略）
   │           - DEL lock，return null（當前 request 視為未登入）
   │
   │         若 CAS 成功寫入：
   │           accessToken / refreshToken / expiresAt 用後端新值（`expires_in` 計算）
   │           **absoluteExpiresAt 保留原值**（rotation 不延長 family abs_exp）
   │
   │           可選 debug 檢查：readJwtClaims(newRefreshToken).abs_exp * 1000 應等於
   │           session.absoluteExpiresAt（後端 ADR 007 line 266 規定 rotation 重簽時
   │           abs_exp 從 state.AbsoluteExp 取，不延長）；若不符 → log warn
   │           （可能是後端 bug、policy 異動、或 family 被人為延長），但仍以儲存值為準
   │
   │         **re-emit Set-Cookie**（滑動 Max-Age；OWASP ASVS 3.3.1）：
   │           cookies().set(SESSION_COOKIE_NAME, sid, {
   │             httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/',
   │             maxAge: Math.min(
   │               config.session.ttlSeconds,
   │               Math.floor((session.absoluteExpiresAt - Date.now()) / 1000),
   │             ),
   │           })
   │           — sid 值不變、cookie 屬性與 §2.4 一致；只刷新 Max-Age 倒數
   │           — 若使用者活躍但 abs_exp 已近，Max-Age 自動收斂到剩餘秒數（≤ abs_exp 自然失效）
   │           — 若呼叫端是非 Route Handler（理論上不會，但保險）：cookies().set() 在
   │             無 mutable cookie store 時會丟出，呼叫端應吞 error 並 log debug（不影響 token 回傳）
   │
   │         DEL lock，return 新 accessToken
   ├─ 失敗 401 → DEL session，DEL lock，return null
   │              （不論 token_expired / absolute_expired / replay_detected / session_not_found / invalid_token，
   │                前端統一走 login；backend error code 寫入 observability log，不影響行為）
   └─ 失敗 網路錯誤 / 5xx → DEL lock，return null（**不刪 session**）
      （finally 保證 lock 一定被釋放，即使 refreshTokens 拋出例外）
      ＊「保留 session」的語意是：當前請求對使用者回 401，但 session record 仍在 Redis；
        下個 user request 進來時，會像第一次一樣走 verifySession + getValidAccessToken，
        因 expiresAt 仍接近過期而再次搶 mutex 嘗試 refresh——這是「下一次 user-driven attempt」，
        不是 BFF 內部的自動 retry loop（避免反覆觸發後端 ADR 007 replay detection）

8. 【等待者】Bounded polling，每 100ms 檢查一次 session 是否更新，直到四個終止條件之一：

   const startedAt = Date.now()
   const maxWaitMs = (REFRESH_LOCK_TTL_SECONDS - 1) * 1000   // 預設 9000ms（lock TTL 安全邊距）

   while (Date.now() - startedAt < maxWaitMs):
     await sleep(100)

     // ── 終止條件 A：absoluteExpiresAt 在等待期間越線 ──
     // 等待者可能等到 9 秒，期間如果原本就接近 abs_exp，現在已超過
     if (Date.now() >= originalSession.absoluteExpiresAt):
       return null   // 後端 refresh 必然 401 absolute_expired，省一次往返

     const current = await GET session:<sid>
     ├─ session 不存在 → return null（持鎖者 refresh 失敗已刪 session）
     ├─ current.accessToken !== 原 session.accessToken → return current.accessToken（已更新）
     └─ 否則繼續輪詢（持鎖者仍在執行 refresh）

   return null（超過 max wait，持鎖者可能 crash 或 refresh 異常緩慢）
```

> **為何網路錯誤 / 5xx 不刪 session 而 401 刪**：
>
> - 401 來自後端明確判斷（token 過期、abs_exp 過、或被視為重放），這個 family 已死，留 session 沒有意義且下次仍會 401
> - 網路錯誤 / 5xx 可能只是後端暫時抖動，session 仍可能有效；刪了反而誤踢
> - 「保留 session」**不等於 BFF 自動 retry**——當前 request 直接回 401，後端是否再嘗試完全由下一個 user-driven request 決定（且 refresh token 仍是原本那一個；落在後端 grace window 10s 內等價回應、之外則觸發 replay）
> - **嚴格禁止：在同一 request 內針對 refresh 失敗做迴圈或延遲 retry**——後端 ADR 007 replay detection 對「同一 refresh token 用兩次」極敏感，自動重試會把合法使用者打成攻擊者、整個 family 連帶被廢

> **為何不只 sleep 一次**：`POST /auth/refresh` 在 production 的延遲 p50 ≈ 80ms、p95 ≈ 300ms、p99 可達 1-3s（Lambda 冷啟動、後端負載）。單次 sleep(100ms) 只覆蓋 p50 以下,p50 之上的請求會誤判 refresh 失敗、被強制登出。Bounded polling 兼顧快速 refresh 響應與慢速 refresh 容忍。詳見 [ADR 008](../adr/008-refresh-waiter-bounded-polling.md)。

> **為何用 `accessToken` 差異判斷而非 `expiresAt`**：`expiresAt` 在某些後端可能因時鐘漂移或邊界情況持平,但 `accessToken` 在 refresh 後必然不同（即使 RT rotation 關閉,AT 也會換發）,是最可靠的「已更新」訊號。

> **為何 max wait 推導自 lock TTL 而非獨立 env var**：waiter 等待時間 > lock TTL 沒有意義（lock 已超時的話下個請求會重新搶鎖）。兩值強耦合,獨立設定容易出現配置不一致。

步驟 1–3 由 `verifySession(sid)` 封裝執行；步驟 4–8 是 `getValidAccessToken()` 在取得 `SessionData` 後的邏輯。雖然 `proxy.ts` 在同一請求中已執行過步驟 1–3，但它不向下游傳遞 `sid` 或 `SessionData`，因此 `getValidAccessToken()` 必須再執行一次（詳見 Section 3.5 的雙重讀取說明）。

**時序圖（三個並發請求,refresh 在 ~80ms 內完成的快路徑）：**

```
Request A          Request B          Request C         Redis        API Server
    │                  │                  │               │               │
    │─ SET lock NX ───────────────────────────────────────▶│               │
    │                  │─ SET lock NX ───────────────────▶│               │
    │                  │                  │─ SET lock NX ▶│               │
    │◀─ OK ─────────────────────────────────────────────────│               │
    │                  │◀─ nil ────────────────────────────│               │
    │                  │                  │◀─ nil ─────────│               │
    │                  │─ poll loop start │                │               │
    │                  │                  │─ poll loop ────│               │
    │─ POST /auth/refresh ────────────────────────────────────────────────▶│
    │◀─ { AT_new, RT_new } ───────────────────────────────────────────────│
    │─ SET session (new tokens) ──────────────────────────▶│               │
    │─ DEL lock ──────────────────────────────────────────▶│               │
    │                  │ [下一輪 100ms]   │                │               │
    │                  │─ GET session ───────────────────▶│               │
    │                  │◀─ { AT_new } ─────────────────────│  ← AT 改變 ✓ │
    │                  │                  │ [下一輪 100ms] │               │
    │                  │                  │─ GET session ─▶│               │
    │                  │                  │◀─ { AT_new } ──│  ← AT 改變 ✓ │
```

**慢路徑（refresh 耗時 500ms-3s）：** 等待者 B / C 會持續 poll 多輪（每 100ms 一次）,直到 session 更新或 max wait 到期。p99 場景下 waiter 最多多等約 5 個 polling 週期（≈500ms）就能拿到新 token,而非單次 sleep 設計下直接回 401。

**Refresh 失敗處理：**

- 持鎖者收到 API Server `401`（refresh token 過期 / abs_exp 過 / 被偵測為重放）→ DEL session、DEL lock、return null
- 持鎖者遇到網路錯誤 / 5xx → 僅 DEL lock，**不刪 session**；當前 request 仍回 401，但 session record 保留，使下一個 user-driven request 進入時可走完整的 verifySession + mutex 流程（**非** BFF 內部 retry）
- 等待者輪詢中發現 session 已被刪除 → return null
- 等待者超過 max wait（持鎖者 crash 或 refresh 異常緩慢）→ return null；下個請求發現 lock 已 TTL 超時，可重新搶鎖嘗試
- 所有請求收到 null → 回傳 `401` 給瀏覽器 → 導向登入頁

> **絕對禁止：在 refresh 失敗後自動重試 refresh 端點。** 即便等待者 polling 期間發現持鎖者失敗、想自己再 refresh 一次，都不可以。後端 ADR 007 的 replay detection 設計就是針對「同一個 refresh token 被使用多次」觸發，自動重試會把合法使用者打成攻擊者、整個 family 連帶被廢。
>
> 「保留 session」與「自動 retry」是兩件事：前者只代表 BFF 不主動清狀態，下一次 refresh 嘗試由真實 user request 自然觸發；後者是 BFF 內部 loop / 等待者主動再發一次，**僅後者被禁止**。

---

### 3.5 Session 函式 API

#### 函式職責分工

| 函式 | 所在檔案 | 責任 | 呼叫端 |
|------|---------|------|--------|
| `verifySession(sid)` | `lib/session/session.ts` | 格式驗證 + Redis lookup，回傳 session 或 null | `proxy.ts`、`getValidAccessToken` |
| `getValidAccessToken()` | `lib/session/session.ts` | 讀 Cookie → `verifySession` → refresh mutex，回傳 accessToken 或 null | Server Component、Route Handler |
| `refreshTokens(refreshToken)` | `lib/auth/refresh.ts` | 呼叫 API Server `POST /auth/refresh`，回傳新 token pair | `getValidAccessToken` 內部 |

#### 函式簽章

```ts
// lib/session/session.ts

export type SessionData = {
  userId: string
  clientId: string            // 對應後端 client policy（cms-web / public-web / ...），refresh 時帶回
  accessToken: string
  refreshToken: string
  expiresAt: number           // access token 到期時間（Unix ms）
  absoluteExpiresAt: number   // family abs_exp（Unix ms），rotation 不延長
  createdAt: number           // Unix timestamp（ms）
}

// proxy.ts 與 getValidAccessToken 共用的底層驗證
// 只做格式驗證 + Redis lookup，不處理 refresh
export async function verifySession(sid: string): Promise<SessionData | null>

// Server Component / Route Handler 呼叫的公開介面
// 內部呼叫 verifySession，並在需要時以 mutex 執行 refresh
export async function getValidAccessToken(): Promise<string | null>
```

```ts
// lib/auth/refresh.ts

export type TokenPair = {
  accessToken:  string
  refreshToken: string
  expiresAt:    number   // Unix timestamp（ms），由 `now + expires_in*1000` 計算
}

/**
 * 純 API 呼叫，不讀寫 Redis。
 *
 * 行為：
 *  1. POST `${API_BASE_URL}${API_BASE_PATH}/auth/refresh` body: `{ "refresh_token": refreshToken }`
 *  2. 解開後端 envelope `{ success, request_id, data: TokenPairResponse }`
 *  3. 把 snake_case (access_token / refresh_token / expires_in) 轉成 camelCase TokenPair
 *  4. 後端回 401 → 拋 TokenRefreshError（含 backend error code 供 log，但呼叫端不據此分支）
 *  5. 後端回 5xx / 網路錯誤 → 拋 UpstreamError（呼叫端用於決定保留 session）
 *
 * 不回傳 absoluteExpiresAt：rotation 不延長 abs_exp（後端 ADR 007 line 266），
 * 因此 refreshTokens 不從 refresh JWT 重讀 abs_exp，由 getValidAccessToken 從 session 內保留原值。
 * （Login 流程才會解 refresh JWT 取 abs_exp 初始化 session——詳見 §3.1 step 4）
 */
export async function refreshTokens(refreshToken: string): Promise<TokenPair>
```

#### 呼叫模式

**Server Component（SSR 頁面）：**

```ts
import { getValidAccessToken } from '@/lib/session/session'
import { apiClient } from '@/lib/api-client/client'
import { redirect } from 'next/navigation'

export default async function PlayersPage() {
  const accessToken = await getValidAccessToken()
  if (!accessToken) redirect('/login')

  const { data } = await apiClient.GET('/players', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  return <PlayerList players={data.players} />
}
```

**Route Handler（`/api/[...path]/route.ts`）：**

```ts
import { getValidAccessToken } from '@/lib/session/session'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const accessToken = await getValidAccessToken()
  if (!accessToken) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const path = (await params).path.join('/')
  // 轉發至 API Server...
}
```

**`proxy.ts`（路由保護，使用 `verifySession`）：**

```ts
import { verifySession } from '@/lib/session/session'
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie'

export async function proxy(request: NextRequest) {
  const sid = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!sid) return NextResponse.redirect(loginUrl(request, true))

  const session = await verifySession(sid)  // 格式驗證 + Redis，不觸發 refresh
  if (!session) return NextResponse.redirect(loginUrl(request, true))

  return NextResponse.next()
}
```

#### Redis 雙重讀取說明

`proxy.ts` 和 `getValidAccessToken` 都會讀 Redis，每次 SSR 頁面請求共讀取兩次。這是刻意設計：

- `proxy.ts`：確認 session **存在**，攔截未驗證請求，避免 Server Component 進行無意義的渲染
- `getValidAccessToken`：取得 `accessToken` 並執行必要的 **refresh**，`proxy.ts` 無法代勞（cookie 來源不同，且不應傳遞 token 至 header）

ECS + ElastiCache 同 VPC 下，每次 Redis 讀取 < 1ms，雙重讀取的額外成本可忽略。

---

### 3.6 註冊端點（passthrough）

**範圍：** `POST /api/register` 經由 BFF 透傳至後端 `POST /auth/register`（OpenAPI 已定義）。本節描述 BFF 端 routing / 安全控制；對應的註冊功能業務政策與 error code 對應見 [`12-cms-user-registration-domain.md`](./12-cms-user-registration-domain.md)，UI 規格見 [`13-screen-register.md`](./13-screen-register.md)（v1.x 新增）。

> **歷史**：spec 第一版 v1 範圍只暴露 passthrough、不提供 UI，理由是給日後其他 client（手動 API、admin tool）使用。v1.x 補上自助註冊頁（[`12`](./12-cms-user-registration-domain.md) domain + [`13`](./13-screen-register.md) screen），本節的 BFF 行為不變、只是多了一個前端消費者。

#### 路徑映射

| Browser | Upstream |
|---------|----------|
| `POST /api/register` | `POST ${API_BASE_URL}${API_BASE_PATH}/auth/register` |

#### proxy.ts 規則

- `/api/register` 加入 `PUBLIC_PATHS`（不需 session 即可呼叫；登入後不應再 register，但這由 UI 層控制即可，不在 proxy 強制）
- CSRF Origin check **照樣套用**（state-changing POST，必須有合法 Origin）
- Rate limit：key `register:<clientIp>`、上限 **5/min/IP**（比 login 嚴格——register 是建立資源、爆量會直接污染後端 user table）；Redis 故障 → **fail-closed 回 503**（同 login 邏輯，因為是一次性高價值寫入端點）

#### Route handler 行為

- BFF **必須注入 `client_id`**（同 login，從 `CLIENT_ID` env 取得；後端規定只 `cms-web` 接受）
- Browser request body **不接受** `client_id`（攔截，避免繞過政策）
- Response 原樣透傳：201（成功，無 body）、400 `invalid_client`、409 `username_taken`、422 `weak_password`、429
- **註冊成功不簽 token**（後端 OpenAPI 註記），caller 須另呼叫 `/api/login`；BFF 不主動串接，由 UI 決定 UX。[`13-screen-register.md §6.2`](./13-screen-register.md#6-表單行為)（UI）與 [`12 §2.4`](./12-cms-user-registration-domain.md#2-註冊政策與資料模型)（domain 政策）採「成功 → redirect `/login?registered=true` 由使用者手動登入」策略

#### 測試（補入 §9）

```ts
// app/api/register/route.test.ts
it('should forward POST /api/register to backend /auth/register with injected client_id')
it('should strip client_id from browser-supplied body before forwarding')
it('should pass through backend 201 (no body) to browser')
it('should pass through 409 username_taken to browser')
it('should pass through 422 weak_password with details[] to browser')
it('should require Origin header on POST /api/register (CSRF)')
it('should be subject to rate limit register:<ip> at 5/min, fail-closed on Redis failure')
it('should NOT auto-login after successful registration')
```

> **為何選擇 v1 暴露而非 hide：** 後端 endpoint 已存在，blocked at BFF 等於前端硬編「全網站只能透過 admin 建立 user」假設；未來若任一 client（手動 ops、CLI tool、TestFlight）想用，要再改 BFF。Passthrough + 嚴格限流是「最少假設、最易調整」的折衷。

---

## 4. Next.js Proxy 路由保護

**Next.js 16：`middleware.ts` → `proxy.ts`**

Next.js 16 將路由保護檔案從 `middleware.ts` 改名為 `proxy.ts`，語意更精確（「在 App 前面的網路邊界」）。
`proxy.ts` 僅支援 Node.js Runtime，無法設定，不需要宣告 `runtime`。
`middleware.ts` 仍保留，但僅用於需要 Edge Runtime 的場景（地理位置判斷等），路由保護一律改用 `proxy.ts`。

```ts
// proxy.ts（Next.js 16）
import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/session/session'
import { checkLimit, tooManyRequests } from '@/lib/rate-limit/limiter'
import { getClientIp } from '@/lib/rate-limit/client-ip'
import { metric } from '@/lib/observability/metrics'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'

// 不需要 session 即可存取的公開路徑（exact match，避免前綴誤判，詳見 ADR 007）
// 新增公開路徑時：1) 在此處加入精確路徑 2) 對應 handler 自行處理 sid 缺失的情況
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/api/login',
  '/api/logout',
  '/api/register',      // §3.6 — passthrough；domain 見 spec 12、UI 見 spec 13；CSRF + rate limit 仍適用
  '/api/health',        // shallow health（ECS / docker）— 詳見 ADR 012
  '/api/health/deep',   // deep health（CD smoke test / dashboard）— 詳見 ADR 012
  '/api/client-errors', // frontend error boundary 回報 — 詳見 03-observability.md §6.1
  '/api/csp-report',    // CSP 違規回報 — 詳見 spec 01 §10.3
  '/api/vitals',        // Web Vitals beacon — 詳見 03-observability.md §6.1
])

// 須做 CSRF Origin check 的方法（state-changing）— 詳見 ADR 013
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function loginUrl(request: NextRequest, withRedirect: boolean): URL {
  const url = new URL('/login', request.url)
  if (withRedirect) url.searchParams.set('redirect', request.nextUrl.pathname)
  return url
}

// 驗證規則與後端 pkg/logger/requestid.go 的 isValidRequestID 一致：
// 非空、長度 ≤ 128、僅含可印 ASCII（0x21–0x7E），避免 log injection
function isValidRequestId(id: string): boolean {
  if (!id || id.length > 128) return false
  for (const char of id) {
    const code = char.charCodeAt(0)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

function isOriginAllowed(request: NextRequest): boolean {
  if (!STATE_CHANGING.has(request.method)) return true
  const origin = request.headers.get('origin')
  if (!origin) return false                              // state-changing 必須有 Origin
  // 拒絕字面 "null"：sandboxed iframe / file:// / data: 等 opaque origin 都會送 Origin: null，
  // 將其加入白名單等於對所有不可信來源開門
  if (origin === 'null') return false
  return config.app.allowedOrigins.has(origin)
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // 1. CSRF Origin check（先於所有其他檢查，含公開路徑—login CSRF 防護）
  if (!isOriginAllowed(request)) {
    logger.warn({
      type: 'auth.proxy.csrf_blocked',
      method: request.method,
      path: pathname,
      origin: request.headers.get('origin') ?? null,
    }, 'state-changing request blocked by Origin check')
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 2. 沿用 browser 帶來的合法 X-Request-ID，不合法則靜默產生新的
  const incoming = request.headers.get('X-Request-ID')
  const requestId = (incoming && isValidRequestId(incoming))
    ? incoming
    : crypto.randomUUID()

  // 3. CSP nonce（每請求新值，注入 response CSP header + request `x-nonce` header）— 詳見 spec 01 §10.3.1
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  // 4. Session 驗證：非公開路徑才檢查
  let session: SessionData | null = null
  if (!PUBLIC_PATHS.has(pathname)) {
    const sid = request.cookies.get(SESSION_COOKIE_NAME)?.value
    if (!sid) {
      logger.info({ type: 'auth.proxy.redirect', reason: 'no_sid', path: pathname, requestId }, 'redirect to login')
      return NextResponse.redirect(loginUrl(request, true))
    }

    session = await verifySession(sid)
    if (!session) {
      logger.info({ type: 'auth.proxy.redirect', reason: 'invalid_session', path: pathname, requestId }, 'redirect to login')
      return NextResponse.redirect(loginUrl(request, true))
    }
  }

  // 5. Rate limit（session 驗證後 / header 注入前；詳見 ADR 009 + ADR 011）
  //    高價值寫入端點（login / register）fail-closed、其他 fail-open + metric
  const clientIp = getClientIp(request)
  const isLogin = pathname === '/api/login'
  const isRegister = pathname === '/api/register'
  const isHighValueWrite = isLogin || isRegister
  let rlKey: string, rlLimit: number, rlRoute: string
  if (isLogin)         { rlKey = `login:${clientIp}`;    rlLimit = 10; rlRoute = '/api/login' }
  else if (isRegister) { rlKey = `register:${clientIp}`; rlLimit = 5;  rlRoute = '/api/register' }
  else if (pathname === '/api/logout') { rlKey = ''; rlLimit = 0; rlRoute = '' }  // 不限流
  else if (session)    { rlKey = `session:${session.userId}`; rlLimit = 100; rlRoute = pathname }
  else                 { rlKey = `ip:${clientIp}`;       rlLimit = 100; rlRoute = pathname }

  if (rlLimit > 0) {
    try {
      const r = await checkLimit(rlKey, rlLimit, 60)
      if (!r.allowed) return tooManyRequests(r)
    } catch (err) {
      if (isHighValueWrite) {
        logger.error({ err, type: 'ratelimit.fail_closed', route: rlRoute }, 'limiter failed; refusing')
        metric('ratelimit.fail_closed', 1, 'Count', { route: rlRoute })
        return new Response(JSON.stringify({ error: 'service_unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      logger.warn({ err, type: 'ratelimit.fail_open', route: rlRoute }, 'limiter failed; allowing request')
      metric('ratelimit.fail_open', 1, 'Count', { route: rlRoute })
    }
  }

  // 6. 注入下游 request headers（公開與受保護路徑都注入）
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-Request-ID', requestId)
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', buildCsp(nonce))   // 見 spec 01 §10.3.1
  return response
}

export const config = {
  matcher: [
    // 此處只排除真正的靜態資源（與 auth 決策無關，regex 寫錯也不會繞過保護）
    // auth 相關的公開路徑改由 handler 內 PUBLIC_PATHS 精確比對處理，避免 regex 前綴誤判
    '/((?!_next/static|_next/image|favicon\\.ico).*)',
  ],
}
```

**路徑分類:**

| 類別 | 在哪裡排除 | 範例 |
|------|-----------|------|
| 純靜態資源 | matcher（regex） | `_next/static`、`_next/image`、`favicon.ico` |
| 公開路徑（不需要 session） | handler 內的 `PUBLIC_PATHS` Set（exact match） | `/login`、`/api/login`、`/api/logout`、`/api/health`、`/api/health/deep` |
| 受保護路徑 | 預設，無需設定 | 其他全部 |

> **為何 auth 相關排除不放 matcher**:Next.js matcher 的負向 lookahead（`(?!login)`）只比對字串起始位置不限定邊界,會把 `/login-history`、`/api/loginx` 等前綴恰好命中的路徑也排除掉,造成 silent failure(未保護的路徑沒有任何錯誤訊息)。handler 內用 `Set.has(pathname)` 精確比對,完全沒有此風險,且新路徑「預設受保護」(secure-by-default)。詳見 [ADR 007](../adr/007-public-paths-in-handler.md)。

**公開路徑說明:**

| 路徑 | 原因 |
|------|------|
| `/login` | 登入頁面本身不需要 session |
| `/api/login` | 登入端點不需要 session（這裡才建立 session）|
| `/api/logout` | 登出必須在 session 失效時仍能執行；Route Handler 內部自行處理無 session 的情況（直接回 200）|
| `/api/health` | ECS Target Group / Docker HEALTHCHECK 使用，**shallow**（只檢查 Redis），詳見 [ADR 012](../adr/012-health-probe-scope.md) |
| `/api/health/deep` | CD smoke test / 外部 monitor 使用，額外檢查上游 API Server；**禁止放進 Target Group** |

**proxy.ts 完整執行順序：**

1. **CSRF Origin check**（先於一切，含公開路徑）：state-changing 請求（POST/PUT/PATCH/DELETE）必須有 Origin 且在白名單，否則 403。詳見 [ADR 013](../adr/013-csrf-defense-strategy.md)
2. **X-Request-ID** 沿用 / 產生
3. **CSP nonce** 產生（後續在 response header 寫入 CSP，request header 傳給 layout）
4. **Session 驗證**（僅針對非公開路徑）：
   - 從 request 取出 `sid` Cookie（cookie name 從 `SESSION_COOKIE_NAME` 常數讀取，production = `__Host-sid`、dev = `sid`）；無 Cookie → 302 至 `/login?redirect=<原始路徑>`
   - 檢查 `sid` 格式（`/^[0-9a-f]{64}$/`）；格式不合 → 302 至 `/login`
   - `GET session:<sid>`；key 不存在 → 302 至 `/login?redirect=<原始路徑>`
   - Session 有效 → 繼續
5. **Rate limit check**（必須在 session 驗證之後、header 注入之前；ADR 009 + ADR 011）：
   - `/api/login`：key `login:<clientIp>`、上限 10/min；Redis 故障 → **fail-closed 回 503**
   - `/api/register`：key `register:<clientIp>`、上限 5/min（比 login 嚴格，因為是寫入端點）；Redis 故障 → **fail-closed 回 503**
   - 其他端點：有 session 用 `session:<userId>`、無 session fallback `ip:<clientIp>`、上限 100/min；Redis 故障 → **fail-open** + log + `ratelimit.fail_open` metric
   - `/api/logout` 不限流（spec 02 §6.3）
   - `clientIp` 從 XFF 右側跳過 `TRUSTED_PROXY_HOPS=2` 取得（ADR 011 §「Client IP 提取」）
6. **下游 header 注入** + **response CSP** → `NextResponse.next()`

每個 redirect 事件都會發 `auth.proxy.redirect` log（`reason` 為 `no_sid` / `invalid_session`），供 debug 「使用者一直被踢回 login」的高頻問題（詳見 [03-observability.md §2.5](./03-observability.md#25-認證事件-log)）。

---

## 5. BFF Proxy Route Handler

所有 API 請求透過 `/api/[...path]/route.ts` 轉發：

```
Browser 請求                     轉發至 API Server
GET  /api/players            →   GET  {API_BASE_URL}{API_BASE_PATH}/players
POST /api/players/{id}/topup →   POST {API_BASE_URL}{API_BASE_PATH}/players/{id}/topup
```

> **URL 拼接規則**：`API_BASE_URL` 只到 host[:port]、不含路徑前綴；`API_BASE_PATH` 預設 `/api`（對齊後端 OpenAPI `servers`；後端已移除 `/api/v1` 版本號，auth 與 CMS 共用 `/api`）。Auth、業務 API 都走 `${API_BASE_URL}${API_BASE_PATH}/<path>`；ops 端點（`/health`、`/health/ready`）直接用 `${API_BASE_URL}/<path>`，**不**加 `API_BASE_PATH`。詳見 spec 01 §5。

**Route Handler 職責：**

1. 呼叫 `getValidAccessToken()`；回傳 null → 回傳 `401`，結束
2. 轉發請求至 API Server（見下方轉發規則）
3. 將 API Server 的 response 回傳給 Browser（保留 status code）

### Request Headers 轉發規則（白名單）

採白名單策略：只轉發下列明確允許的 headers，其餘一律捨棄（詳見 [ADR 005](../adr/005-proxy-header-forwarding.md)）。

**從 Browser 轉發：**

| Header | 說明 |
|--------|------|
| `Content-Type` | POST / PUT / PATCH 必須，API Server 需要知道 body 格式 |
| `Accept` | API Server 回應格式協商 |
| `Accept-Language` | 多語系支援 |
| `Accept-Encoding` | 允許壓縮回應 |

**BFF 自行加入（覆蓋 Browser 傳來的同名 header）：**

| Header | 值 |
|--------|-----|
| `Authorization` | `Bearer <accessToken>`（從 Redis session 取出） |
| `X-Request-ID` | `proxy.ts` 產生或沿用的 requestId（從內部 request headers 讀取） |

> **維護注意**：白名單預設捨棄所有未列出的 headers。新增需要自訂 header 的 API 功能時（如 `Idempotency-Key`、`If-Match`），必須同步更新此白名單，否則功能從瀏覽器觸發時會靜默失效。詳見 [ADR 005](../adr/005-proxy-header-forwarding.md)。

### Request Body 轉發

採 Read-and-Resend：以 `await request.text()` 讀取 body 後重送。
本專案 API 皆為 JSON，無檔案上傳需求，body 體積可控。

### Response Headers 轉發規則（白名單）

**轉發給 Browser：**

| Header | 說明 |
|--------|------|
| `Content-Type` | 瀏覽器需要知道回應格式 |
| `Cache-Control` | 控制瀏覽器快取行為 |
| `X-Request-ID` | 後端每個 response 均回傳此 header（同時也在 response body 的 `request_id` 欄位），方便前端錯誤回報對應後端日誌 |
| `Retry-After` | **必須轉發**——後端 429（rate limit）/ 503（暫時不可用）會帶此 header 指示退避秒數；少轉發會讓 client 無從決定重試時機，淪為「無腦立即重試」加重後端負載。對應 spec 02 §6.3 / §7 的 429 行為 |

`Transfer-Encoding`、`Connection` 等 hop-by-hop headers 不轉發。

### Request ID 傳播

`proxy.ts` 為每個請求產生唯一的 `X-Request-ID`（UUID v4），注入至下游的 Next.js request headers。Route Handler 與 Server Component 透過 `getRequestId()` 讀取，轉發給 API Server 後，API Server 的每個 response 都會在 **header**（`X-Request-ID`）與 **body**（`request_id` 欄位）帶回同一個 ID，BFF 原樣轉發給 browser，讓 BFF 與 API Server 的 log 可以用同一個 ID 串聯追蹤。

**Header 名稱**：`X-Request-ID`（與後端 `pkg/logger/requestid.go` 的 `RequestIDHeader` 常數一致，D 大寫）。

**驗證規則**：`proxy.ts` 中的 `isValidRequestId` 與後端邏輯相同——非空、長度 ≤ 128、僅含可印 ASCII（0x21–0x7E）。不合法時靜默產生新 UUID，防止 log injection。

```ts
// src/lib/request-id.ts
import { headers } from 'next/headers'

export async function getRequestId(): Promise<string> {
  return (await headers()).get('X-Request-ID') ?? crypto.randomUUID()
}
```

**Route Handler 使用範例：**

```ts
// src/app/api/[...path]/route.ts
import { getRequestId } from '@/lib/request-id'
import { getValidAccessToken } from '@/lib/session/session'

export async function GET(request: NextRequest, ...) {
  const [accessToken, requestId] = await Promise.all([
    getValidAccessToken(),
    getRequestId(),
  ])
  if (!accessToken) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // 轉發至 API Server，帶 X-Request-ID 供後端 log 串聯
  // 業務路徑須加 API_BASE_PATH（預設 /api，對齊後端 OpenAPI servers）
  const apiResponse = await fetch(`${config.api.baseUrl}${config.api.basePath}/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Request-ID': requestId,
    },
  })

  // 後端 response body 已含 request_id 欄位，原樣轉發即可
  // 同時在 response header 帶回，供前端從 header 讀取
  return new Response(apiResponse.body, {
    status: apiResponse.status,
    headers: { 'X-Request-ID': requestId },
  })
}
```

**Server Component 使用範例：**

```ts
import { getRequestId } from '@/lib/request-id'
import { getValidAccessToken } from '@/lib/session/session'

export default async function PlayersPage() {
  const [accessToken, requestId] = await Promise.all([
    getValidAccessToken(),
    getRequestId(),
  ])
  if (!accessToken) redirect('/login')

  const { data } = await apiClient.GET('/players', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Request-ID': requestId,
    },
  })
  return <PlayerList players={data.players} />
}
```

**測試：**

```ts
// src/lib/request-id.test.ts
it('should return X-Request-ID from headers when present')
it('should return a new UUID when X-Request-ID header is absent')
it('should validate requestId: accept valid ASCII string')
it('should validate requestId: reject empty string')
it('should validate requestId: reject string longer than 128 chars')
it('should validate requestId: reject string with control characters')
```

---

## 5.5 CMS 閒置自動登出（前端 UX 層）

後端 ADR 007 規定 CMS 必須在 15 分鐘無使用者互動時強制登出，這是 **UX 安全**（與後端的 access token 15 分鐘 + refresh sliding 1h 無關）。後端不負責此判斷，由前端實作。

> **Browser timer 並非安全邊界**：使用者可關閉 JS 繞過 timer，攻擊者拿到 token 也不會被 timer 擋。安全邊界在後端 access token 15 分鐘 + refresh token rotation；前端 timer 只是「合法使用者離開座位後 15 分鐘內降低被旁觀者操作的風險」這個 UX 場景。

> **為何 timer 在 Browser 端而非 BFF**：互動事件只能在 Browser 端偵測，BFF 無法知道使用者是否在頁面前活動。BFF 端的「閒置」只能以「沒打 API」近似，而後端的 refresh token sliding 1h TTL 已經提供這層保證（連續 1 小時無任何 API 呼叫 → refresh token JWT exp 自然失效）。

### 5.5.0 何時掛 / 何時不掛

| 場景 | Provider 行為 |
|------|--------------|
| 受保護區段 layout，有 `useSession()` 可用 | 掛 provider；effect 內 instantiate timer + channel |
| 公開區段（`/login`、`/api/health` 等） | **不掛**——這些頁面沒 `SessionProvider`，掛了 `useSession()` 會 throw |
| `idleConfig.idleTimeoutMs === 0`（如 public-web） | 掛 provider 但 effect 立即 return；不建任何 listener |
| Provider 收到 session 但 `absoluteExpiresAt - now ≤ 0` | timer 啟動後在第一個 tick 即觸發 onExpire（spec 5.5.3 演算法已涵蓋） |
| Dev 環境 React Strict Mode double mount | effect 的 cleanup 必須讓「卸載 → 重掛」等於「全新初始化」；多次 dispose 安全 |

### 5.5.1 設計原則

| 原則 | 落地 |
|------|------|
| **單一外層 provider，全站只掛一次** | `IdleTimerProvider` 包在 CMS 區段最外層 layout；多次嵌套會重複監聽 → CPU 浪費 + 多次重置 race |
| **純邏輯與 React 解耦** | timer 計時、throttle、stale message 判定等不引用 React；React 只負責 lifecycle 與事件源綁定。讓 vitest 不用 jsdom 即可測核心行為 |
| **以 wall-clock 為事實來源** | `lastActivityAt: number`（`Date.now()`）為唯一狀態；`setTimeout` 只是觸發重算的機制，不持有 timer 邏輯。筆電休眠 / Tab 凍結 / clock drift 後重新計算剩餘時間，不依賴 setTimeout 計數 |
| **abs_exp short-circuit** | 若 `absoluteExpiresAt - Date.now() < IDLE_TIMEOUT_MS`，剩餘時間以 `absoluteExpiresAt` 為準（cookie / Redis 都會在那個點自然過期，再計也沒意義） |
| **可觀測** | timer 觸發 → emit `auth.session.idle_logout` log + metric（spec 03 §2.5 / §3.3 已定義 shape），含 `userId` 與 `idleMs` |
| **不雙重登出** | logout 進行中或頁面正在卸載時，不再重複 fetch；用旗標 + AbortController 守護 |

### 5.5.2 模組結構

```
src/lib/idle/
├── idle-timer.ts            # 純邏輯：startTimer / resetTimer / scheduleExpiry / cancel
├── idle-timer.test.ts       # vitest，fakeTimers，不需 jsdom
├── auth-channel.ts          # BroadcastChannel('auth') 包裝 + stale 判定（§5.6 共用）
├── auth-channel.test.ts     # vitest，jsdom（BroadcastChannel polyfill）
├── idle-config.ts           # 依 CLIENT_ID 對應 idle 設定（cms-web = 15min / 30s warning）
└── index.ts                 # barrel

src/components/idle-timer-provider.tsx       # React 整合：監聽 DOM 事件 + visibility change
src/components/idle-timer-provider.test.tsx  # RTL + jsdom
src/components/idle-warning-modal.tsx        # 倒數 modal（a11y compliant）
src/components/idle-warning-modal.test.tsx
```

**為何拆 `idle-config.ts`**：未來 BFF 同時服務 public-web / mobile 時，idle threshold 會依 `client_id` 不同（spec 01 §5 `CLIENT_ID`）；獨立檔讓未來新增 client 只動一處。

#### 5.5.2.1 公開 API 簽章（TDD Red 階段的契約）

```ts
// ─────────────────────────────────────────────────────────────────────
// src/lib/idle/idle-timer.ts — 純邏輯 factory，無 React、無瀏覽器全域
// ─────────────────────────────────────────────────────────────────────

export type IdleTimerEvent =
  | { type: 'warning';  remainingMs: number }
  | { type: 'extended'; via: 'activity' | 'click' }   // log 用
  | { type: 'expire';   idleMs: number }

export type IdleTimerDeps = {
  /** wall-clock 取得，測試可注入 fake clock */
  now:    () => number
  /** 在指定 ms 後執行 fn，回傳可取消的 handle；測試可注入 fake scheduler */
  setTimer:   (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type IdleTimerOpts = {
  idleTimeoutMs:     number
  warningMs:         number
  absoluteExpiresAt: number          // 來自 ClientSession（§2.5）
  onEvent:           (e: IdleTimerEvent) => void
  deps?:             Partial<IdleTimerDeps>   // 預設 Date.now / setTimeout / clearTimeout
}

export type IdleTimerHandle = {
  /** 由 DOM activity 或 cross-tab 廣播觸發；自動 throttle 1s */
  notifyActivity(at?: number): void
  /** 由「立即登出」按鈕觸發；強制 onEvent({type:'expire',...}) 一次 */
  forceExpire(reason: 'manual'): void
  /** 解綁所有 timer，多次呼叫安全 */
  dispose(): void
  /** 偵錯用，回傳當下計算的剩餘 ms（不變更狀態） */
  remainingMs(): number
}

/** 不啟動 timer，呼叫 notifyActivity 才開始。Provider mount 後立即叫一次。 */
export function createIdleTimer(opts: IdleTimerOpts): IdleTimerHandle


// ─────────────────────────────────────────────────────────────────────
// src/lib/idle/auth-channel.ts — BroadcastChannel 包裝
// ─────────────────────────────────────────────────────────────────────

export type AuthChannelMessage =
  | { type: 'activity'; at: number; nonce: string }
  | { type: 'warning';  at: number; nonce: string }
  | { type: 'logout';   at: number; nonce: string }
  | { type: 'login';    at: number; nonce: string; userId: string }

export type AuthChannelOpts = {
  /** 用於 stale 過濾；缺漏代表「不過濾 createdAt」（如未登入頁面） */
  currentSession?: { createdAt: number; userId: string }
  onMessage:        (msg: AuthChannelMessage) => void
  /** 預設 60_000；own-nonce Set 在這個 ms 後 evict */
  nonceTtlMs?:      number
}

export type AuthChannelHandle = {
  postActivity(at?: number): void
  postWarning(at?: number):  void
  postLogout(at?: number):   void
  postLogin(userId: string, at?: number): void
  /** close 底層 channel，停止 emit / receive；多次呼叫安全 */
  dispose(): void
}

/**
 * 若 BroadcastChannel 不存在（Safari sandbox / SSR），回傳 no-op handle
 * （post 全為空函式、不掛 listener）。
 */
export function createAuthChannel(opts: AuthChannelOpts): AuthChannelHandle


// ─────────────────────────────────────────────────────────────────────
// src/lib/idle/idle-config.ts
// ─────────────────────────────────────────────────────────────────────

export type IdlePolicy = { idleTimeoutMs: number; warningMs: number }

/** idleTimeoutMs === 0 代表該 client_id 不啟用 idle timer */
export const idleConfig: IdlePolicy


// ─────────────────────────────────────────────────────────────────────
// src/components/idle-timer-provider.tsx
// ─────────────────────────────────────────────────────────────────────
'use client'

export type IdleTimerProviderProps = {
  children: React.ReactNode
  /** 測試 / Storybook 可覆寫，預設讀 idleConfig */
  policyOverride?: IdlePolicy
}

/**
 * 必須包在受保護區段 layout 內（依賴 SessionProvider 提供 useSession）。
 * idleTimeoutMs === 0 → 直接渲染 children，不掛任何 listener。
 * 公開區段（login page）絕對不掛這個 provider。
 */
export function IdleTimerProvider(props: IdleTimerProviderProps): JSX.Element


// ─────────────────────────────────────────────────────────────────────
// src/components/idle-warning-modal.tsx
// ─────────────────────────────────────────────────────────────────────
'use client'

export type IdleWarningModalProps = {
  /** undefined → 不顯示；給定數字 → 顯示倒數 */
  countdownSec: number | undefined
  onContinue:   () => void   // 點「繼續工作」/ ESC / 任何 activity 都會呼叫
  onLogoutNow:  () => void   // 點「立即登出」
}

export function IdleWarningModal(props: IdleWarningModalProps): JSX.Element | null
```

> **為何 `createIdleTimer` 是 factory 而非 class**：closure 比 class 更利於依賴注入測試（不需 `new`、不需 mock prototype）；TS 型別等價。
>
> **為何 deps 是 partial**：production 預設值寫在實作，但測試可只覆寫 `now` 而不動 `setTimer`，減少 mock 量。
>
> **為何 `IdleTimerEvent` 是 union 而非多個 callback**：單一 `onEvent` 在 React 端容易接（用 `useCallback` 一次包好所有路徑）；多 callback 容易漏掛。

### 5.5.3 演算法（含休眠 / 可見度 / abs_exp 邊界）

```
初始狀態:
  lastActivityAt = Date.now()
  expiryAt       = lastActivityAt + IDLE_TIMEOUT_MS
  warningShownAt = null
  loggingOut     = false

事件 source（passive listener）:
  - DOM: mousemove / mousedown / keydown / wheel / touchstart / scroll
  - Cross-tab: auth-channel 'activity' 訊息
  - visibilitychange: 'visible' → 重新檢查（不算 activity）

重置（throttle 1s）:
  if (loggingOut) return
  const now = Date.now()
  if (now - lastActivityAt < 1000) return        // throttle
  lastActivityAt = now
  expiryAt       = now + IDLE_TIMEOUT_MS
  reschedule()
  authChannel.postActivity(now)                   // 跨分頁同步

reschedule():
  cancelTimer()
  const remaining = effectiveExpiry() - Date.now()
  if (remaining <= 0)             { onExpire(); return }
  if (remaining <= WARNING_MS)    { showWarning() }
  // setTimeout 是觸發點，不依賴它計時；最大 ~25 天上限避免 32-bit 溢位
  timer = setTimeout(reschedule, Math.min(remaining, MAX_SAFE_TIMEOUT))

effectiveExpiry():
  return Math.min(expiryAt, absoluteExpiresAt)    // abs_exp short-circuit

visibility:
  document.visibilityState === 'visible' → reschedule()
  （隱藏 tab 期間 setTimeout 可能被瀏覽器節流；切回時必須以 wall-clock 重算）

onExpire（loggingOut = true）:
  emit observability:
    logger.info({ type: 'auth.session.idle_logout', userId, idleMs: now - lastActivityAt })
    metric('auth.session.idle_logout', 1, 'Count')
  authChannel.postLogout({ at: Date.now(), nonce })
  await sendLogout()
  window.location.replace('/login?reason=idle_timeout')

sendLogout():
  // 同 origin，credentials 自帶；CSRF Origin check 通過（§6.1）
  // pagehide / unload 路徑改用 sendBeacon，確保 in-flight 不被 tab 關閉吃掉
  if (document.visibilityState === 'hidden' && navigator.sendBeacon) {
    navigator.sendBeacon('/api/logout')
  } else {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,                            // tab 關閉時仍送出
    }).catch(() => {})                            // 失敗仍導頁，BFF 端 session 由 Redis TTL 自然過期
  }
```

> **為何不用 setInterval / 不每秒檢查**：setInterval 在 hidden tab 被瀏覽器降頻到 1Hz，且耗 CPU；單一 setTimeout 配 wall-clock 比對更省電、行為可預期。

> **為何 `MAX_SAFE_TIMEOUT`**：`setTimeout(fn, n)` 當 n > 2^31-1 (~24.85 天) 會立刻觸發。本案 timeout 為 15 分鐘遠低於上限，但 abs_exp 可能 8 小時甚至更長，計算 effectiveExpiry 時若直接餵 30 分鐘以上的數值給 setTimeout 是安全的；保留這個 clamp 是防呆。

> **為何 abs_exp short-circuit 仍要 emit log**：使用者可能整夜離開、回來時 abs_exp 過期 — 仍是 idle 場景，需被計入 metric 才能反映真實 UX。

### 5.5.4 警告 modal（WARNING_MS = 30 秒）

| 行為 | 規約 |
|------|------|
| 出現時機 | 剩餘時間 ≤ 30 秒時顯示 |
| 操作 | 「繼續工作」按鈕：重置 timer；「立即登出」按鈕：等同 onExpire |
| 自動行為 | 任何 DOM activity event 同樣會關閉 modal + 重置 timer |
| 跨分頁 | 任一分頁收到 activity 廣播 → 所有分頁同步關閉 modal |
| 可及性 | `role="alertdialog"` + `aria-live="polite"` + 鍵盤可達 + ESC 關閉等同「繼續」 |
| 倒數顯示 | 每秒更新「剩餘 X 秒」（用 `setInterval(1000)` 僅在 modal 顯示時掛，關閉立刻清） |
| Focus trap | modal 顯示時 trap focus；關閉後 restore 至原先聚焦元素 |

> **為何留 30 秒緩衝**：避免使用者離開回來時直接被踢；同類產品（Salesforce、ServiceNow、AWS Console）都採此模式。

### 5.5.5 邊界情況

| 情境 | 處理 |
|------|------|
| 筆電休眠 / Tab 凍結後恢復 | visibilitychange → reschedule()，以 `Date.now()` 重新計算；若 `Date.now() > effectiveExpiry()` → 直接 onExpire |
| 系統時間被使用者調回過去 | `Math.max(now - lastActivityAt, 0)` 確保不出現負值；極端情境下使用者看似多得到時間，但 abs_exp short-circuit 仍會兜底 |
| 多 modal 同時開（如同網頁載入時已有警告） | 任一分頁收到 'activity' 廣播 → 透過 `authChannel` 一起關閉；自家 modal 用單例 React state |
| Tab 關閉前未送出 logout | `sendBeacon` 保證最後一搏；BFF 端 session 由 Redis TTL 兜底（spec 02 §2.2 sliding TTL） |
| 使用者切到其他 Tab 而非離開 | Tab hidden ≠ idle；仍照常計時，因為「使用者沒在這個 BFF 頁面互動」就是 idle |
| 啟動時 abs_exp 已剩 < IDLE_TIMEOUT_MS | 直接以 effectiveExpiry = absoluteExpiresAt 為準；可能很快就觸發 logout，符合預期 |
| 使用者剛 login，舊分頁仍有舊 timer | login 廣播觸發所有分頁重置 timer（§5.6） |
| `BroadcastChannel` 不支援（如 Safari 舊版 / sandbox） | feature detect，若 undefined 則退化為「不跨分頁同步」；本地仍可運作 |

### 5.5.6 可觀測性必須 emit 的事件

| 事件 | log type | metric | 備註 |
|------|---------|--------|------|
| Timer 觸發 logout | `auth.session.idle_logout` | `auth.session.idle_logout` Count | spec 03 §2.5 / §3.3 已列；本模組是唯一 emission 點 |
| 警告 modal 顯示 | `auth.session.idle_warning` | `auth.session.idle_warning` Count | 用以分析「警告→繼續」vs「警告→登出」比例 |
| 警告 modal 被「繼續」延長 | `auth.session.idle_extended` | `auth.session.idle_extended` Count | 同上 |
| 跨分頁 activity 廣播 | 不 log（高頻、低價值） | 不發 | throttled 1Hz 仍可能每分鐘多次 |

> **`idleMs` 的明確定義**：等於「**`Date.now() - lastActivityAt`** 在 emission 時刻的值」。
> - `auth.session.idle_warning` 的 `idleMs` ≈ `idleTimeoutMs - warningMs`（顯示警告當下）
> - `auth.session.idle_logout` 的 `idleMs` ≥ `idleTimeoutMs`（可能略多，例如休眠後恢復）
> - `lastActivityAt` 不重置時 `idleMs` 持續累計；activity 後重置回 0
>
> **emission 路徑**：log + metric **emission 在 IdleTimerProvider 內**（持有 `useSession().userId` 與 BFF logger 相對應的 client-side metric beacon）；pure `idle-timer.ts` 只 `onEvent` 派發事件型別，**不直接 import logger**（保留純邏輯可測試性）。
>
> **Client-side metric emission**：呼叫 `POST /api/vitals`（spec 03 §6.1 已定義）or `/api/client-errors`（warning 不算錯），最後落到 BFF EMF。實作上 idle metric 可 piggyback `/api/vitals`，把 `{ name: 'auth.session.idle_logout', value: 1 }` 一起送。

### 5.5.7 設定（hardcoded 於 idle-config.ts）

不暴露為 env var，理由：閒置時長是 client policy（後端 ADR 007 規定 cms-web 必須 15 分鐘），env 改動會偏離 policy 紀律。

```ts
// src/lib/idle/idle-config.ts
import { config } from '@/lib/config'

const POLICIES: Record<string, { idleTimeoutMs: number; warningMs: number }> = {
  'cms-web':    { idleTimeoutMs: 15 * 60_000, warningMs: 30_000 },
  'public-web': { idleTimeoutMs:  0,          warningMs: 0      },   // 0 = 不掛 timer
  // mobile / ios-app 不適用（不走 web）
}

export const idleConfig = POLICIES[config.api.clientId] ?? POLICIES['cms-web']
```

`idleTimeoutMs === 0` → `IdleTimerProvider` 立即 early-return，不掛任何 listener（public-web 場景）。

### 5.5.8 SSR / hydration 規約

| 規則 | 說明 |
|------|------|
| **`'use client'` 強制** | `IdleTimerProvider` / `IdleWarningModal` / `SessionProvider` 都是 client component，檔首必須有 `'use client'` |
| **不在 module top-level 建立** `BroadcastChannel` / `setTimeout` | SSR 階段 `BroadcastChannel` 不存在；module top-level 執行的程式碼 = SSR build 時 throw。實作必須延後到 `useEffect` 或 lazy init |
| **feature detect 三項 globals** | `typeof BroadcastChannel`、`typeof navigator !== 'undefined' && 'sendBeacon' in navigator`、`typeof document !== 'undefined'`。任一缺漏採對應降級（auth-channel 變 no-op、sendBeacon fallback 到 fetch keepalive、跳過 visibilitychange） |
| **首次 render 必須與 SSR 一致** | provider 第一次 render 不可讀 `Date.now()` / `document.visibilityState` 寫進 state；初始狀態用 `props.initialSession.absoluteExpiresAt` 推算（純 props，SSR 與 client 一致），實際時間用在 `useEffect` 內 |
| **`useEffect` 內才 instantiate** | `createIdleTimer` / `createAuthChannel` 都在 `useEffect(() => { ... return () => handle.dispose() }, [])` 內叫，回傳清理函式 |
| **React Strict Mode 安全** | dev mode 會 mount / unmount / mount 兩次；effect 必須對「double mount」 idempotent。`dispose()` 必須能多次呼叫；BroadcastChannel `close()` 同樣 |
| **server component 內禁止 import client-only 模組** | `idle-timer.ts` 雖然是純邏輯但要走「只在 client 跑」紀律，避免被 server component 誤 import 後在 SSR rehydration 造成 bundle 膨脹。`'use client'` 由 provider 帶頭即可 |
| **HMR 安全** | dev 環境 fast refresh 重新跑 provider effect 時，舊 channel 必須關閉再開新；用 cleanup 回傳處理 |

```ts
// 示意：provider 的 effect 樣板
useEffect(() => {
  if (idleConfig.idleTimeoutMs === 0) return                  // public-web no-op

  const session = useSession()                                  // 必在 SessionProvider 內
  const channel = createAuthChannel({
    currentSession: { createdAt: session.createdAt, userId: session.userId },
    onMessage: handleMessage,
  })
  const timer = createIdleTimer({
    idleTimeoutMs:     idleConfig.idleTimeoutMs,
    warningMs:         idleConfig.warningMs,
    absoluteExpiresAt: session.absoluteExpiresAt,
    onEvent:           handleTimerEvent,
  })
  timer.notifyActivity()                                         // 啟動

  const ac = new AbortController()
  const reset = throttle(() => {
    timer.notifyActivity()
    channel.postActivity()
  }, 1000)
  for (const ev of ['mousemove','mousedown','keydown','wheel','touchstart','scroll'] as const) {
    window.addEventListener(ev, reset, { signal: ac.signal, passive: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') timer.notifyActivity(Date.now())
  }, { signal: ac.signal })
  window.addEventListener('pagehide', () => {
    // tab 關閉 / navigation 切走時的最後 ping：不延長壽命，只是讓 server 知道
    // 若 timer 正在 warning 階段且使用者直接關 tab → 不主動 logout，讓 server TTL 兜底
  }, { signal: ac.signal })

  return () => {
    ac.abort()
    timer.dispose()
    channel.dispose()
  }
}, [])   // empty deps：session 改變等同整頁載入，provider 會被卸載重建
```

## 5.6 多分頁協調

同一瀏覽器多分頁同時打 API 時，每個分頁都會發請求至 BFF，BFF 端的 [Redis Mutex（ADR 004）](../adr/004-token-refresh-mutex.md) 已涵蓋此情境：所有分頁的請求都對應同一個 `sid`，搶同一把 `refresh_lock:<sid>`，只有一個會實際呼叫後端 refresh。

**因此前端 Browser 不需要 BroadcastChannel / Web Lock 協調 refresh**（後端 ADR 007 §「前端配合」描述的是「直接持有 JWT 的 SPA」場景，本 BFF 架構不適用）。

**Browser 端仍須協調的場景：**

- **Idle timer 活動同步（重要 UX）**：idle timer **以「整個瀏覽器 session」為單位而非分頁**。任一分頁有 mousemove / keydown / click → 透過 `BroadcastChannel('auth')` 廣播 `{ type: 'activity', at: <ms> }`，所有分頁收到即重置自己的 idle timer。否則「A 分頁有人在用、B 分頁閒置 15 分鐘把所有人踢出」的 UX 不可接受
- **Logout 廣播**：任一分頁登出 → 廣播 `{ type: 'logout' }`，其他分頁立即跳 login
- **登入完成**：登入分頁廣播 `{ type: 'login' }`，其他分頁可依需求重新請求資料

**為何選 BroadcastChannel 而非 `navigator.locks` / `localStorage` 事件**：

| 工具 | 適用場景 | 為何不選 |
|------|---------|---------|
| **BroadcastChannel**（採用） | 跨分頁 fire-and-forget 訊息 | 同 origin、語意簡單、原生 polyfill 友好 |
| `navigator.locks` | 跨分頁互斥（同時只有一個分頁能做某事） | 本場景是「廣播 activity」非「搶資源」；用 lock 模型反而要設計 lock acquire / release 流程，過度設計 |
| `localStorage` storage event | 老瀏覽器跨分頁通訊 | 同步寫盤（會阻塞 main thread）、需自己 encode 訊息、不支援結構化 clone |

**訊息格式：**

```ts
type AuthChannelMessage =
  | { type: 'activity'; at: number;  nonce: string }          // 任一分頁有使用者互動
  | { type: 'warning';  at: number;  nonce: string }          // 任一分頁顯示警告 modal
  | { type: 'logout';   at: number;  nonce: string }          // 任一分頁登出（含 idle / 手動）
  | { type: 'login';    at: number;  userId: string; nonce: string }   // 任一分頁登入完成
```

**所有訊息必填 `nonce`**（`crypto.randomUUID()`，發送前 push 至本地 `Set<string>`，自己 echo 回來時跳過）。`activity` 也需 nonce —— 否則 throttle 後的 echo 仍會被自己接到、無意義耗 CPU。

**Own-nonce Set 必須有 TTL 上限**（預設 60 秒）：BroadcastChannel echo 通常在 ms 級回到自己，60 秒已綽綽有餘；TTL 防止 Set 無限長大。實作可用「環形 buffer 容量 256 + 寫入時 TTL evict」或「Map<nonce, expireAt> + 寫入時 sweep 過期項」，避免每次 emit 都全掃。

**廣播頻率控制：** `activity` 事件 throttle 1 秒（與本地 timer 重置同頻率）。

**Stale message 防護：** 收到方依以下規則丟棄：

| 訊息 | 丟棄條件 |
|------|---------|
| `logout` | `at < currentSession.createdAt`（更早 session 的 echo） |
| `logout` | nonce 已在自己的 own-emission Set |
| `logout` | 本分頁正在登入流程中（剛 `POST /api/login` 等待回應） |
| `activity` | 本分頁正在 logout 流程（`loggingOut === true`），不延長壽命 |
| `activity` | nonce 已在自己的 own-emission Set |
| `login` | `userId === currentUserId`（同帳號重新整理 / 多分頁同帳號登入） |
| `warning` | 本分頁的 warningShownAt > 接收訊息的 at（自己更新） |

> **為何要這層防護**：假設情境「A 分頁登出 → B 分頁切換帳號登入 → A 分頁的舊 logout 訊息此時才到」，若不加防護 B 分頁會被誤踢。`createdAt` 比對能擋住跨 session 的訊息回流。

**Channel 與資源清理：**

- `IdleTimerProvider` unmount → `channel.close()` + `removeEventListener('message', ...)`
- 監聽 DOM 事件清單必須完整清理（用 `AbortController.signal` 一次傳給所有 listener 是最乾淨的寫法）
- 任何 `setTimeout` / `setInterval` 在 unmount / loggingOut 時必須 clear，避免「component 卸載後 1 秒突然觸發 logout」

> **為何 activity 同步必要、refresh 同步不必要**：
>
> - **activity** 是 UX 決策（避免誤踢），純 Browser 概念，BFF 無從得知
> - **refresh** 是後端 token 換發流程，所有分頁的請求都對應同一 `sid`、搶同一把 BFF Redis Mutex（ADR 004），BFF 端已自動收斂——前端再加一層 BroadcastChannel 反而增加複雜度且無收益

---

## 6. 安全規格

### 6.1 CSRF 防護

採用 **SameSite=Lax Cookie + proxy.ts Origin check** 雙層 defense-in-depth（詳見 [ADR 013](../adr/013-csrf-defense-strategy.md)）：

1. **Layer 1 - SameSite=Lax**：browser 對絕大多數跨站請求不送 cookie
2. **Layer 2 - Origin check**：proxy.ts 對所有 state-changing 請求（POST/PUT/PATCH/DELETE）驗證 `Origin` header 必須在 `config.app.allowedOrigins` 白名單內，否則 403

**為何需要兩層：**

| 攻擊類型 | SameSite=Lax 是否擋下 | Origin check 是否擋下 |
|---|---|---|
| 跨站 form POST 攜帶 sid | ✅ | ✅ |
| 跨站 fetch with credentials | ✅ | ✅ |
| **Login CSRF**（受害者被登入到攻擊者帳號） | ❌（top-level POST 不擋） | ✅（攻擊者站台的 Origin 不在白名單） |

Origin check 對所有 state-changing 端點生效（含 `/api/login`、`/api/logout`、`/api/[...path]`）。原因：login CSRF 防護的關鍵就是擋住對 login 端點本身的跨站 POST。

**為何不採用 Double Submit Cookie / 對稱 CSRF token：** Origin check 已直接回答「請求是否來自自家頁面」，CSRF token 在本架構（BFF 同源 + SameSite=Lax）變成重複勞動。詳見 [ADR 013](../adr/013-csrf-defense-strategy.md)。

### 6.2 Session Fixation 防護

登入成功後必須產生新的 sessionId，不沿用登入前的 sessionId。攻擊者可預先固定 `sid` 給受害者（透過 cookie injection / URL 參數注入），若 BFF 沿用此 `sid` 寫入登入後狀態，攻擊者就持有了已登入的 sid。

**`POST /api/login` 處理 sid 的演算法：**

```
1. 從 request 讀 incoming sid cookie（若有）
2. 對後端呼叫 /auth/login，取得 token pair
3. 不論 incoming sid 是否合法、是否在 Redis 有對應 session：
   a. 若 incoming sid 存在 → DEL session:<incomingSid>（清掉攻擊者可能預植的 key）
   b. 產生新 sid = randomBytes(32).toString('hex')
   c. SET session:<newSid> 寫入 SessionData
4. Set-Cookie 用新 sid，瀏覽器舊 cookie 自動被覆蓋
```

**為何「無論合法與否」都要重新產生：** 即便 incoming sid 是過去合法 session 的 key，正確行為仍是換新——同一使用者連續兩次 login 之間，前一次的 session 應視為已結束，新 login 開全新生命週期。這也讓「攻擊者把自己預植 sid 送給受害者，等受害者登入後共用」的攻擊路徑直接消失。

**權限升級時的處理：** 本應用無「公開 → 已登入」之外的權限升級流程（沒有訪客身分晉升、沒有 step-up auth），故只需在 login 時處理。未來若加入「以低權限登入後升級到管理員」流程，須在升級點再次 regenerate sid。

### 6.3 Rate Limiting

| 端點 | 限制 | 鍵 | Redis 故障時 | 回應 |
|------|------|----|-------------|------|
| `POST /api/login`（proxy.ts，網路層） | 10 次/分鐘 | `login:<clientIp>` | **fail-closed**（503） | `429 Too Many Requests` + `Retry-After` |
| `POST /api/login`（Route Handler，account 層） | 5 次失敗/15 分鐘 | `login:fail:<usernameHash>` | **fail-closed**（503） | `429 { error: "account_locked" }` + `Retry-After` |
| `POST /api/register` | 5 次/分鐘 | `register:<clientIp>` | **fail-closed**（503） | `429 Too Many Requests` + `Retry-After` |
| `POST /api/logout` | 無限制 | — | — | — |
| 其他 `/api/*` | 100 次/分鐘 | `session:<userId>`（無 session fallback `ip:<clientIp>`） | **fail-open**（放行 + log + metric） | `429 Too Many Requests` + `Retry-After` |

> **雙層 login 限流（OWASP ASVS 11.1.2）**：proxy.ts 層 IP key 擋同一 IP 的爆破；Route Handler 層 user key 擋**分散式 credential stuffing**（攻擊者輪流換 IP 嘗試同一帳號）。`usernameHash` 採 SHA-256 前 8 bytes hex（與 [03-observability.md §2.5](./03-observability.md#25-認證事件-log) 的 `userHash` 同 scheme）；用 hash 而非明文 username 避免 Redis dump 洩漏 user enumeration list。後端 login 回 401 → BFF 對該 user key `INCR EX 900`；login 200 → `DEL` 該 key（成功登入清除累積）。

採**雙層 defense-in-depth**：

1. **API Gateway Throttling**（粗糙、邊緣防護）：account-level + per-route QPS 上限,在請求進入 ECS 前就拒絕惡意流量
2. **proxy.ts + Redis sliding window limiter**（精細、業務邏輯）：per-IP / per-session 計數,提供上表規格與客製化錯誤訊息

**IP 取得：** 不可取 XFF 最左值（browser 可偽造）。從 XFF 右側跳過信賴 proxy 數（`TRUSTED_PROXY_HOPS=2`，對應 CloudFront + API Gateway）後取真實 client IP。詳見 [ADR 011 §「Client IP 提取」](../adr/011-edge-security-hardening.md#client-ip-提取)。

**失效模式：** login 與其他端點策略不同——login 是高價值單一端點（密碼是攻擊集中點），fail-closed 比放任爆破更可接受；其他 API fail-open 可避免限流誤殺正常使用者。詳見 [ADR 011 §「Login limiter fail-closed 實作」](../adr/011-edge-security-hardening.md#login-limiter-fail-closed-實作)。

完整設計、演算法選擇詳見 [ADR 009 - Rate Limiting 實作層](../adr/009-rate-limiting-strategy.md)。

### 6.4 敏感資訊不外洩

#### Log redaction（必須涵蓋的欄位）

| 欄位路徑 | 來源 | 處置 |
|---------|------|------|
| `req.headers.cookie` | inbound | `remove`（不留 placeholder） |
| `req.headers.authorization` | inbound | `remove` |
| `req.headers["x-api-key"]` | inbound（防呆） | `remove` |
| `res.headers["set-cookie"]` | outbound | `remove` |
| `*.access_token` / `*.refresh_token` / `*.accessToken` / `*.refreshToken` | login / refresh / logout request & response body | `censor: "[REDACTED]"` |
| `*.password` | login / register request body | `censor: "[REDACTED]"` |
| `*.sessionId` / `*.sid` | 任何 log object | `censor: "[REDACTED]"` |
| query string token 殘留（如 `?access_token=...`、`?token=...`） | URL 整段 | 改用 `URL.searchParams` 預過濾後再 log；pino path redaction 抓不到 substring |

> **為何 logout body 的 `refresh_token` 必須列入：** §3.2 規定 logout request body 為 `{ refresh_token: "..." }`。若 BFF middleware 自動 log request body（為 debug 加上的常見模式），明文 refresh token 會落入 CloudWatch；其 TTL 內仍可換取 access token，等同帳號被竊取。redaction 規則明寫此 path，避免後人補 log 時忘記。

#### 其他

- Error response 不得回傳 JWT 相關欄位（即使是後端原始錯誤 body，BFF 也應檢查；後端目前不會在 error 帶 token，但合約層保留檢核）
- Redis key 使用 `session:` 前綴，ACL 限制 BFF 只能存取此前綴
- `username` / `email` 在 log 中只能以 `usernameHash` / `emailHash`（SHA-256 前 8 bytes hex）形式出現，不寫明文（對齊 §6.3 lockout key 與 [03-observability.md §2.5](./03-observability.md#25-認證事件-log)）

---

## 7. 錯誤處理

| 情境 | BFF 行為 | 回傳給 Browser |
|------|---------|--------------|
| Cookie 無 `sid` | — | `401 { error: "unauthenticated" }` |
| Redis session 不存在 | — | `401 { error: "unauthenticated" }` |
| `absoluteExpiresAt - now ≤ 0`（達後端 abs_exp） | 直接刪 session、清 Cookie，不呼叫後端 refresh | `401 { error: "absolute_expired" }` |
| Access token 過期，refresh 成功 | 靜默更新 session（保留 `absoluteExpiresAt`），重置 TTL | 正常回傳資料 |
| Access token 過期，refresh 收到 401（後端 error 之一：`token_expired` / `absolute_expired` / `invalid_token` / `replay_detected` / `session_not_found`） | 刪除 session，清除 Cookie；observability log 帶入後端 error code | `401 { error: "session_terminated" }` |
| 後端 refresh 回傳 `400 invalid_client`（CLIENT_ID 政策被改 / 環境變數錯設） | 刪 session，**告警 metric `auth.config.invalid_client`** | `401 { error: "session_terminated" }` |
| Access token 過期，refresh 遇到網路錯誤 / 5xx | 釋放 lock，**保留 session**（不刪、不自動 retry）；下個 user-driven request 進入時自然走 mutex 再試一次 | 本次回傳 `503 { error: "upstream_unavailable" }` |
| Refresh 期間等待者偵測到 `absoluteExpiresAt` 越線 | 等待者 return null，不再 poll | `401 { error: "absolute_expired" }` |
| 後端 family 已被其他裝置 `revoke-all` 撤銷 | refresh 收到 401 `session_not_found` → 刪除 session，清除 Cookie | `401 { error: "session_terminated" }` |
| 登出時後端 `/auth/logout` 失敗（網路 / 401 / 5xx） | 忽略，繼續刪除 BFF session 和 Cookie；metric `auth.logout.upstream_failure` | `200 { }` |
| 後端回傳 envelope 解析失敗（缺 `success` 或 `data` 欄位） | 視為 5xx 走 upstream 錯誤路徑；告警 metric `auth.envelope.parse_error` | `502 { error: "upstream_contract_violation" }` |
| 後端回傳 `401 session_revoked`（AuthMiddleware 命中黑名單） | **BFF 主動刪除本地 Redis session**（`deleteSession(sid)`）後原樣回傳 401 body；log `auth.proxy.session_revoked` | `401 { error: "session_revoked" }` |
| API Server 回傳其他 4xx（含 backend 標準 error envelope） | 原樣透傳（含 `request_id`） | 相同 status code + body |
| API Server 回傳 5xx | 原樣轉發；BFF 不加工 body | 相同 status code |
| `revoke-session` 嘗試撤銷自己當前 family（後端 400 `use_logout_instead`） | UI 應改呼叫 `/api/logout`；BFF 不特別處理，原樣透傳 | `400 { error: "use_logout_instead" }` |
| Register 失敗 `409 username_taken` | 原樣透傳 | `409 { error: "username_taken" }` |
| Register 失敗 `422 weak_password` | 原樣透傳（含後端 `details[]` 以便 UI 顯示哪條規則沒過） | `422 { error: "weak_password", details: [...] }` |
| Redis 連線失敗（refresh 路徑外） | — | `503 Service Unavailable` |
| Origin check 失敗（CSRF） | proxy.ts 直接攔截 | `403 { error: "forbidden" }`（見 §4） |

> **前端不需要區分後端 401 細分（`token_expired` / `absolute_expired` / `replay_detected` / `invalid_token` / `session_not_found`）**：UX 上都是「session 結束，跳 login」。但 **BFF 結構化 log 必須記下後端 error code** 以利除錯（見 [03-observability.md §2.5](./03-observability.md#25-認證事件-log)）：
> - `replay_detected` 是高優先告警（可能代表攻擊或 family 連帶廢）
> - `absolute_expired` 累計成長率異常代表 `client_id` policy 過短，需要調 abs_exp
> - `invalid_token` 突然增加可能代表 BFF↔backend 簽章 secret 不同步

---

## 8. API 契約

> **整體原則：** 後端對外採 snake_case + envelope `{ success, request_id, data }`；BFF 對 Browser 採 camelCase 扁平結構。轉換層集中於 `lib/auth/*.ts`，**不** 把 envelope 透傳到 Browser。`request_id` 仍透過 `X-Request-ID` response header 暴露給 Browser。

### POST `/api/login`

**Request（Browser → BFF）**
```json
{
  "username": "user@example.com",
  "password": "string"
}
```
> 為相容 UI 現有「email 欄位」習慣，BFF 接受 `email` 作為 alias；接到 `email` 時 BFF 在 zod schema 階段重命名為 `username`。對外文件統一稱 `username`。

**內部呼叫（BFF → API Server `POST /auth/login`）**
```json
{
  "username": "user@example.com",
  "password": "string",
  "client_id": "cms-web"
}
```
`client_id` 由 BFF 從 `CLIENT_ID` 環境變數注入，不允許 Browser 指定（避免使用者繞過 CMS 政策、套用較寬鬆的 client policy）。

**API Server 回應（200，envelope 內，對齊後端 OpenAPI `TokenPairEnvelope`）**
```json
{
  "success": true,
  "request_id": "0193b3f4-1234-7abc-9def-0123456789ab",
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "token_type": "Bearer",
    "expires_in": 900,
    "refresh_expires_in": 3600
  }
}
```

> **後端 response 不含 `absolute_expires_in`。** `abs_exp` 在 refresh_token JWT claims 內（後端 ADR 007 line 104），BFF 自行 base64-decode payload 取出（§3.1 step 4、§11.1）。

BFF 解 envelope 與計算 timestamp：

```ts
const now = Date.now()
const refreshClaims = readJwtClaims(data.refresh_token)   // base64-decode, no verify
// refreshClaims.abs_exp 是 unix seconds（per backend ADR 007 line 104）
const session: SessionData = {
  userId,
  clientId:          config.api.clientId,                       // 'cms-web' 等
  accessToken:       data.access_token,
  refreshToken:      data.refresh_token,
  expiresAt:         now + data.expires_in * 1000,
  absoluteExpiresAt: refreshClaims.abs_exp  * 1000,
  createdAt:         now,
}
```

存入 Redis 後不轉發給 Browser。

**Response 200（BFF → Browser）**
```json
{
  "userId": "string"
}
```
```http
Set-Cookie: __Host-sid=<sessionId>; HttpOnly; Secure; SameSite=Lax; Path=/;
            Max-Age=<min(SESSION_TTL_SECONDS, (absoluteExpiresAt - now) / 1000)>
X-Request-ID: <後端 request_id>
```
> production 用 `__Host-sid`，dev（HTTP）用 `sid`（§2.4）。

**Response 400（後端驗證失敗）** — 透傳後端 envelope
```json
{
  "success": false,
  "request_id": "0193b3f4-...",
  "error": "invalid input",
  "details": [
    { "field": "username", "message": "must not be empty" }
  ]
}
```

**Response 401（帳密錯誤）** — 透傳後端 envelope
```json
{
  "success": false,
  "request_id": "0193b3f4-...",
  "error": "unauthorized"
}
```

**Response 429（rate limit）** — 透傳後端或 BFF 限流 envelope，含 `Retry-After` header
```json
{
  "success": false,
  "request_id": "0193b3f4-...",
  "error": "too many requests"
}
```

---

### POST `/api/logout`

**Request（Browser → BFF）**：無 body，需攜帶 `sid` Cookie

**內部呼叫（BFF → API Server `POST /auth/logout`）**
```http
POST /auth/logout HTTP/1.1
Authorization: Bearer <accessToken>
X-Request-ID: <requestId>
Content-Type: application/json

{ "refresh_token": "<session.refreshToken>" }
```
**必須帶 body 的 `refresh_token`**（§3.2），否則後端只 blacklist access jti，整個 family 仍存活到 abs_exp。

**API Server 回應**：`204 No Content`（成功）或 `401`/`5xx`（一律忽略，繼續 BFF 端清理）

**Response 200（BFF → Browser，無論後端回什麼都回 200）**
```json
{}
```
```http
Set-Cookie: __Host-sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0
```

---

### 多裝置 session 管理（passthrough）

後端 `/auth/sessions` 三個端點皆透過 `/api/[...path]` catch-all proxy 轉發，不另開特化 route（詳見 §10「多裝置 Session 管理」）：

| Browser 端 | BFF 端 | 後端 |
|-----------|--------|------|
| `GET /api/auth/sessions` | catch-all proxy | `GET /auth/sessions` → 列出 family 清單 |
| `DELETE /api/auth/sessions/{fid}` | catch-all proxy | `DELETE /auth/sessions/{fid}` |
| `POST /api/auth/sessions/revoke-all` | catch-all proxy + **同 sid 自我登出處理** | `POST /auth/sessions/revoke-all` |

`revoke-all` 成功後當前 family 也被廢，BFF 須在收到後端 `204` 後自動清掉 BFF 端 session 並清 cookie（與 logout 同效），UI 收到 `200 { selfLoggedOut: true }` 後自行導去 login。

---

### GET|POST|PUT|DELETE `/api/[...path]`

轉發至 API Server（見 spec 01 §4.2 Proxy Handler 契約），response 原樣回傳。若 session 無效，回傳 `401 { error: "unauthenticated", requestId }`。

---

## 9. 測試規格

### Unit 測試（Vitest）

```ts
// lib/session/session.test.ts（verifySession）
it('should return null when sid format is invalid')
it('should return null when session key does not exist in Redis')
it('should return SessionData when sid is well-formed and session exists')

// lib/session/session.test.ts（getValidAccessToken）
it('should return null when sid cookie is absent')
it('should return null when verifySession returns null')
it('should return accessToken directly when token is not near expiry')
it('should return new accessToken after refresh when token is near expiry')
it('should acquire Redis lock before calling refresh endpoint')
it('should return token from updated session when lock is already held')
it('should return null when session is deleted after waiting for lock')
it('should release lock in finally block even when refresh endpoint throws')
it('should update session with new tokens after successful refresh')
it('should preserve absoluteExpiresAt in stored session after rotation (NOT extend)')
it('should re-emit Set-Cookie with refreshed Max-Age on successful refresh (sliding cookie)')   // §3.4 step 7
it('should keep Max-Age <= remaining time to absoluteExpiresAt when refreshing cookie')         // §3.4 step 7
it('should NOT delete session when refresh returns 5xx / network error')   // 規格保證
it('should delete session when refresh returns 401 regardless of backend error code')

// lib/session/session.test.ts（waiter abs_exp 邊界）
it('should return null when waiter detects absoluteExpiresAt has passed mid-poll')   // §3.4 step 8 終止 A
it('should not request refresh when absoluteExpiresAt has already passed at entry')   // §3.4 step 4

// lib/session/session.test.ts（race / fixation）
it('should handle logout request that arrives while refresh mutex is held')         // race
it('should NOT resurrect session when logout deletes it during refresh (CAS aborts SET)')  // §3.4 step 7 CAS
it('should revoke newly issued family when CAS aborts (refresh succeeded but session was deleted)')  // §3.4 step 7
it('should DEL old session key when login receives incoming sid cookie')            // §6.2
it('should issue a new sessionId on every successful login')                        // §6.2

// lib/session/session.test.ts（session 讀寫）
it('should generate a 64-char hex sessionId with 256 bits of entropy')
it('should store session data with correct TTL = min(SESSION_TTL, (absoluteExpiresAt - now) / 1000)')
it('should delete session from Redis on logout')

// lib/session/cookie.test.ts（cookie 屬性，§2.4）
it('should emit Set-Cookie with __Host-sid name in production')
it('should emit Set-Cookie with sid name in development')
it('should emit Set-Cookie with HttpOnly / Secure / SameSite=Lax / Path=/')
it('should NOT include Domain attribute in Set-Cookie when COOKIE_DOMAIN is unset')
it('should NOT include Partitioned attribute')
it('should set Max-Age to min(SESSION_TTL_SECONDS, Math.floor((absoluteExpiresAt - now) / 1000))')

// lib/auth/login.test.ts
it('should call API Server with username (not email) and client_id from CLIENT_ID env')
it('should map browser-supplied email to username when sending to backend')
it('should unwrap backend envelope { success, request_id, data } before reading TokenPair')
it('should compute expiresAt as Date.now() + expires_in * 1000')
it('should read absoluteExpiresAt from refresh_token JWT abs_exp claim (no signature verify)')   // §11.1
it('should treat malformed refresh JWT as upstream contract violation (502)')                   // §11.1
it('should treat missing abs_exp claim in refresh JWT as upstream contract violation (502)')    // §11.1
it('should store snake_case backend fields as camelCase in Redis session')
it('should return userId after successful login')
it('should throw InvalidCredentialsError when API returns 401 unauthorized')
it('should return 429 account_locked when login:fail:<usernameHash> >= 5 (per-account lockout)')
it('should INCR login:fail:<usernameHash> with EXPIRE 900 on backend 401')
it('should DEL login:fail:<usernameHash> on backend 200 (successful login clears counter)')
it('should NOT INCR lockout counter on backend 5xx / network error (credential not invalid)')
it('should hash username via SHA-256 first 8 bytes hex before using as Redis key')
it('should fail-closed (503) when Redis fails during lockout check')
it('should pass through backend 400 invalid input body (including details[]) to browser')
it('should normalize backend error code "invalid input" to invalid_input via normalizeErrorCode')
it('should normalize backend error code "too many requests" to too_many_requests')
it('should match snake_case codes (token_expired) without modification')
it('should set Redis session TTL to min(SESSION_TTL, (absoluteExpiresAt - now) / 1000)')
it('should not allow Browser to override client_id from request body')
it('should write Set-Cookie with __Host-sid prefix in production')
it('should clear pre-existing session before issuing new sid (fixation, §6.2)')
it('should treat backend response missing data field as upstream contract violation (502)')

// lib/auth/logout.test.ts（§3.2）
it('should send refresh_token in body to backend /auth/logout (family revocation)')
it('should set Authorization: Bearer <accessToken> header')
it('should expect 204 from backend logout')
it('should clear BFF session even when backend logout returns 5xx')
it('should clear BFF session even when backend logout returns 401')
it('should clear BFF session even when backend logout has network error')
it('should return 200 to browser regardless of backend logout result')
it('should emit auth.logout.upstream_failure metric on backend logout error')
it('should send Set-Cookie Max-Age=0 even when no session existed')

// lib/auth/refresh.test.ts（refreshTokens 的 HTTP 呼叫行為）
it('should POST to /auth/refresh with body { refresh_token } (snake_case)')
it('should unwrap envelope and return camelCase TokenPair { accessToken, refreshToken, expiresAt }')
it('should NOT return abs_exp from refresh response (rotation does not extend abs_exp; absoluteExpiresAt preserved by caller)')
it('should throw TokenRefreshError when API returns 401 (any backend error code)')
it('should preserve backend error code on the thrown error for log purposes')
it('should throw UpstreamError when API returns 5xx')
it('should throw UpstreamError on network failure')
it('should NOT auto-retry refresh on any failure (replay protection)')

```

### proxy.ts 測試（Vitest）

```ts
// proxy.test.ts
// CSRF Origin check（ADR 013）
it('should allow GET regardless of Origin')
it('should allow state-changing request with allowed Origin')
it('should reject state-changing request with disallowed Origin (403)')
it('should reject state-changing request without Origin header (403)')
it('should reject state-changing request with Origin: null literal string (403)')   // §4 新增
it('should apply Origin check to /api/login (login CSRF protection)')
it('should apply Origin check to /api/logout')

// 公開路徑（ADR 007 + 012）
it('should bypass session check for /api/health and /api/health/deep')

// Session redirect 事件 log（observability）
it('should emit auth.proxy.redirect log with reason=no_sid')
it('should emit auth.proxy.redirect log with reason=invalid_session')

// CSP nonce（spec 01 §10.3.1）
it('should generate a new nonce per request')
it('should set Content-Security-Policy header with the generated nonce')
it('should set x-nonce request header for downstream Server Components')

// Rate limit（§4 step 5；ADR 009 + ADR 011）
it('should call checkLimit AFTER verifySession (order matters: session key requires session)')
it('should key /api/login limiter on client IP not session')
it('should key other endpoints on session userId when session exists')
it('should fall back to client IP for limiter key on public paths without session')
it('should return 429 with Retry-After when limit exceeded')
it('should return 503 service_unavailable when Redis fails on /api/login (fail-closed)')
it('should emit ratelimit.fail_closed metric on /api/login Redis failure')
it('should allow request and emit ratelimit.fail_open metric on Redis failure for non-login endpoints')
it('should derive client IP from XFF index (length - TRUSTED_PROXY_HOPS) per ADR 011')
it('should NOT apply rate limit to /api/logout')

// Cookie name 常數使用（§2.4）
it('should read sid cookie via SESSION_COOKIE_NAME constant (not hardcoded "sid")')
```

### Component 測試（React Testing Library）

```ts
// app/(auth)/login/page.test.tsx  — v1 已實作，UI 細節見 §3.1 「登入頁 UI 設計」與 ADR 021
// 測試環境：// @vitest-environment jsdom（per-file directive，不改全域 vitest config）

// 表單渲染
it('should render the username field, password field, and submit button')
it('should require both username and password to submit (HTML validation)')

// 提交行為
it('should POST credentials to /api/login when the form is submitted')
it('should disable both inputs and the submit button while the request is in flight')

// 錯誤顯示
it('should render an alert with the backend message when the API returns an error')
it('should fall back to the error code when no message is provided')
it('should render a network-error alert when fetch rejects')

// Redirect 與 open-redirect 防護
it('should redirect to "/" by default on successful login')
it('should redirect to the safe ?redirect= target after successful login')
it('should reject protocol-relative redirect targets to prevent open-redirect')
it('should reject absolute external redirect targets to prevent open-redirect')

// TODO（spec 列入但 v1 尚未實作；落地需後端契約與多分頁 AuthChannel 配套）
it('should show field-level errors from backend 400 invalid_input details[]')
it('should broadcast postLogin via AuthChannel before window.location.replace')   // 見 §3.1 步驟 8 與 §5.6
```

### Idle timer 純邏輯測試（Vitest + fakeTimers，**不需 jsdom**）

```ts
// src/lib/idle/idle-timer.test.ts
// — 計時 & throttle
it('should reset lastActivityAt on touch within throttle window without emit')
it('should reset lastActivityAt and schedule expiry on touch outside throttle window')
it('should call onExpire exactly once when timer reaches IDLE_TIMEOUT_MS')
it('should NOT call onExpire when activity occurs before timeout')
it('should be a no-op after loggingOut flag is set (idempotent)')

// — wall-clock 容錯
it('should onExpire immediately when Date.now() jumps past expiryAt (laptop sleep)')
it('should NOT panic on negative delta (system clock moved backwards)')
it('should re-clamp setTimeout delay to MAX_SAFE_TIMEOUT when remaining > 2^31-1 ms')

// — abs_exp short-circuit
it('should use absoluteExpiresAt when it is earlier than idle expiry')
it('should onExpire immediately when absoluteExpiresAt already passed at start')
it('should emit auth.session.idle_logout log even on abs_exp short-circuit')

// — 警告階段
it('should call onWarning when remaining time <= WARNING_MS')
it('should call onWarning at most once per idle cycle')
it('should clear warning state when activity resets the timer')

// — 觀測 emission（注入 spy logger / metric）
it('should emit auth.session.idle_logout log with userId + idleMs at expire')
it('should emit auth.session.idle_warning when warning shows')
it('should emit auth.session.idle_extended when warning dismissed by activity')
```

### Auth channel 純邏輯測試（Vitest + jsdom，BroadcastChannel 須 polyfill）

```ts
// src/lib/idle/auth-channel.test.ts
it('should attach nonce to every outbound message')
it('should drop messages whose nonce matches own emission Set (echo suppression)')
it('should drop logout whose at < currentSession.createdAt (stale-session guard)')
it('should drop activity while local loggingOut === true')
it('should drop login whose userId equals currentUserId')
it('should release own-emission nonce after reasonable TTL (memory bound)')
it('should close() the underlying BroadcastChannel and stop emitting on dispose')
it('should feature-detect BroadcastChannel and become a no-op when undefined')
```

### IdleTimerProvider 整合測試（RTL + jsdom）

```ts
// src/components/idle-timer-provider.test.tsx
// — listener 掛載 / 卸載
it('should attach passive listeners on mount and detach on unmount')
it('should use AbortController.signal so all listeners are cleaned up together')
it('should NOT mount when idleConfig.idleTimeoutMs === 0 (public-web)')

// — 事件路徑
it('should reset timer on any of [mousemove, mousedown, keydown, wheel, touchstart, scroll]')
it('should call reschedule on document visibilitychange to visible')

// — logout 路徑
it('should call fetch /api/logout with credentials: same-origin and keepalive: true')
it('should call navigator.sendBeacon when document hidden at expiry time')
it('should navigate to /login?reason=idle_timeout after logout settles')
it('should set loggingOut flag before fetch to prevent re-entry')
it('should NOT throw or hang if /api/logout fetch rejects')

// — 警告 modal 互動
it('should show IdleWarningModal when warning phase triggers')
it('should reset timer when modal "繼續" button clicked')
it('should onExpire immediately when modal "立即登出" button clicked')
it('should close modal on cross-tab activity broadcast')
it('should restore focus to previously-focused element when modal closes')

// — 跨分頁
it('should broadcast activity (throttled 1s) on local DOM event')
it('should reset local timer when receiving fresh activity broadcast')
it('should navigate to /login when receiving fresh logout broadcast')
it('should not respond to own broadcasts (echo suppression)')
```

### IdleWarningModal 無障礙測試（RTL + jsdom）

```ts
// src/components/idle-warning-modal.test.tsx
it('should render with role="alertdialog" and aria-live="polite"')
it('should trap focus inside modal while open')
it('should restore focus to opener element on close')
it('should close on Escape key (equivalent to "繼續")')
it('should display countdown seconds and update each second')
it('should clear countdown interval on unmount')
```

### E2E 測試（Playwright）

```ts
// e2e/auth.spec.ts
test('should login with valid credentials and access protected page')
test('should logout and be redirected to login page')
test('should redirect to login when accessing protected page without session')
test('should preserve redirect URL after login')
test('should reject cross-origin POST to /api/login (login CSRF)')
test('should sync idle timer across tabs via BroadcastChannel')
test('should revoke all sessions and self-logout via /api/auth/sessions/revoke-all')   // §10
```

---

## 10. 多裝置 Session 管理

後端 OpenAPI 已定義三個 family（裝置）管理端點，前端透過 `/api/[...path]` catch-all proxy 直接代理，**不另開特化 route handler**（業務邏輯純粹是 BFF 不應介入的後端職責）。

### 端點對應

| Browser 端 | 後端端點 | 用途 |
|-----------|---------|------|
| `GET /api/auth/sessions` | `GET /auth/sessions` | 列出當前使用者的所有 family（每個對應一個登入裝置） |
| `DELETE /api/auth/sessions/{fid}` | `DELETE /auth/sessions/{fid}` | 撤銷指定裝置；不能撤銷自己當前 family（後端會回 `400 use_logout_instead`） |
| `POST /api/auth/sessions/revoke-all` | `POST /auth/sessions/revoke-all` | 全裝置登出（密碼變更、帳號異常時用） |

### `revoke-all` 的 BFF 後處理（特殊處理）

`revoke-all` 後當前 family 也被廢，BFF 必須清乾淨自己這端的 session：

```ts
// app/api/[...path]/route.ts 對 POST /api/auth/sessions/revoke-all 的特殊處理
// （仍走 catch-all proxy，但在後端 204 後額外動作）
async function handleRevokeAllPostprocessing(request, upstreamStatus) {
  if (upstreamStatus !== 204) return // 後端未成功就不動 BFF state

  const sid = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (sid) await redis.del(`session:${sid}`)

  // 回應改為 200 + { selfLoggedOut: true } 並附 Set-Cookie clear
  return new Response(JSON.stringify({ selfLoggedOut: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSidCookie(),
    },
  })
}
```

### `fid` 從何而來（與 ADR 010 §決策 6 的關係）

ADR 010 §決策 6 規定「前端不持有 `fid` 作為自己的狀態」。本機制不違反此原則：

- `fid` 由後端 `GET /auth/sessions` response（`SessionInfo.fid`）即時提供
- UI 收到清單後，使用者點「登出此裝置」時把對應 `fid` 直接放進 URL `DELETE /api/auth/sessions/{fid}`
- BFF 不解碼、不快取、不寫入 session 任何 `fid` 欄位

換言之：`fid` 是「後端用來識別 family 的 opaque id」，前端可以**從 API 收到並回傳給 API**，但不持久化到 BFF session 或 Browser 儲存。

### 測試

```ts
// e2e / unit
it('should proxy GET /api/auth/sessions to backend without modification')
it('should pass SessionInfo array through to browser unchanged')
it('should pass DELETE /api/auth/sessions/{fid} through and surface 400 use_logout_instead body')
it('should clear BFF session and Cookie when POST /api/auth/sessions/revoke-all returns 204')
it('should return 200 { selfLoggedOut: true } after revoke-all post-processing')
it('should NOT clear BFF session if backend revoke-all returns non-204')
```

---

## 11. 後端契約對接（實作前確認事項）

本節記錄 BFF 與後端契約對接時的關鍵實作細節。**無阻擋性 gap**，但實作時務必依此處理避免常見誤解。

### 11.1 `abs_exp` 來源：refresh token JWT claim（無須後端 OpenAPI 變更）

**結論：** 後端 ADR 007 §「Token 規格」line 104 明列 refresh token JWT claims 為 `iss, sub, utype, jti, fid, aud, exp, abs_exp, iat`，**`abs_exp` 已在 JWT 內**。BFF 對 refresh token 做 base64-decode payload（不驗簽）即可取出。

**實作位置：** `lib/auth/jwt-claims.ts`

```ts
// lib/auth/jwt-claims.ts
import { Buffer } from 'node:buffer'

/**
 * 解析 JWT payload claims，不驗簽。BFF 沒有 JWT_REFRESH_SECRET，無法驗簽。
 * 此函式僅用於從 refresh token 取出 abs_exp 作為 hint —— 安全把關仍在後端。
 *
 * 不可用於：
 *  - access token 驗證（後端負責）
 *  - 信賴 claim 值做安全決策（abs_exp 之外的 claim 一律忽略）
 */
export type RefreshTokenClaims = {
  abs_exp: number   // unix seconds；後端 ADR 007 line 104 規定
  exp:     number   // unix seconds；refresh sliding TTL
  jti:     string   // 後端 audit ID，BFF 不持有（ADR 010 §決策 6）
}

export function readJwtClaims(jwt: string): RefreshTokenClaims {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed_jwt')
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4)
  const json = Buffer.from(padded, 'base64').toString('utf8')
  const claims = JSON.parse(json)
  if (typeof claims.abs_exp !== 'number') throw new Error('missing_abs_exp_claim')
  return claims
}
```

**為何此模式安全（防呆解釋）：**

| 攻擊向量 | 結果 | 為何不影響安全 |
|---------|------|---------------|
| 攻擊者竄改 refresh JWT 把 `abs_exp` 改更大 | BFF 誤判 family 還活著，繼續打後端 refresh | 後端 `VerifyRefresh` 從 Redis state 拿真實 `AbsoluteExp`，拒絕；攻擊者要竄改本來就需先拿到 token，竄改不代表知道 secret |
| 攻擊者把 `abs_exp` 改更小 | BFF 提早 short-circuit、刪 session | 攻擊者把合法使用者「自己的 token」做 DoS——但攻擊者要做這件事得先持有 token，反正他既然有 token 就能直接打 API；無 security breach |
| BFF 解析失敗 | `readJwtClaims` 拋 error，login 流程失敗 | 視為「後端契約異常」走 502；對應測試 §9 |
| 後端 ADR 改 abs_exp claim 名稱 | login / refresh 流程立刻 broken | 屬於後端 breaking change，會在 PR review / integration test 捕獲 |

> **與 ADR 010 §決策 6 的關係：** §決策 6 寫的是「前端**不持有** `fid` / `jti`」——這是禁止把後端 audit ID 當作 BFF state（避免耦合）。讀 `abs_exp` 來計算 session lifetime 不違反此原則（abs_exp 不是 audit ID，且 BFF 只用其 timestamp 設 TTL，不長期保存原始 claim）。**ADR 010 需補一條補述明確區分這兩件事。**

> **此模式為業界標準：** Auth0 SDK（`@auth0/auth0-spa-js` 內部 `parseClaims`）、Okta SDK（`@okta/okta-auth-js` 的 `decodeToken`）、Microsoft `@azure/msal-browser` 均採同模式（client 解 token payload 取 expiry 作為 hint，伺服器才是 source of truth）。

**新增測試（§9）：**

```ts
// lib/auth/jwt-claims.test.ts
it('should decode abs_exp from a well-formed JWT payload')
it('should throw on malformed JWT (not 3 parts)')
it('should throw when abs_exp claim is missing')
it('should throw when abs_exp claim is not a number')
it('should NOT verify the signature (BFF has no secret)')
it('should handle base64url alphabet (- and _ instead of + and /)')
it('should handle missing base64 padding')
```

### 11.2 `username` 接受 email 格式

後端 `LoginRequest.username` 為一般字串，但本應用實質以 email 作 lookup。需要後端確認：

- `username` 接受任意 ≤ 128 字元字串（含 `@` 與 `.`）
- 不對 `username` 做 email-format 驗證（讓 BFF / 前端決定要不要強制 email 格式）

**現況推測（讀後端 infrastructure spec）：** 後端 `Player.Email` 即 username 來源，已支援。但 OpenAPI 對 `username` 沒有 format 描述，需口頭確認或在 OpenAPI 補 `description: "email-formatted username"`。

### 11.3 `request_id` 在 query string 出現的場景（無）

後端目前無 OAuth callback / SSO 等場景會把 token / code 放 query string。若未來引入，**spec 03 §2.4 的 query 過濾必須先到位**。視為 future ADR。

### 11.4 Domain endpoints OpenAPI 補全

目前 OpenAPI 只有 `/auth/*`。BFF spec 提及 `/api/players`、`/api/reports` 等業務端點，這些必須在 OpenAPI 中定義後 BFF 才能啟動實作（SDD 守則）。**本 spec 的 scope 限於 auth/session**——business endpoints 由各自的 spec / 後端 endpoint 規格負責。

---

## 12. 關聯文件

- [BFF 架構規格](./01-bff-architecture.md)
- [ADR 001 - 部署架構](../adr/001-deployment-architecture.md)
- [ADR 002 - BFF 路由結構設計](../adr/002-bff-route-structure.md)
- [ADR 003 - Session 函式 API 設計](../adr/003-session-api-design.md)
- [ADR 004 - Token Refresh 並發控制：Redis Mutex](../adr/004-token-refresh-mutex.md)
- [ADR 005 - BFF Proxy Header 轉發規則](../adr/005-proxy-header-forwarding.md)
- [ADR 010 - 對齊後端 ADR 007：client_id、refresh 失敗不重試、多分頁協調](../adr/010-align-with-backend-adr007-jwt.md)
- [ADR 011 - 邊緣安全強化（XFF 信賴 + login fail-closed）](../adr/011-edge-security-hardening.md)
- [ADR 012 - 健康檢查端點 shallow / deep 分離](../adr/012-health-probe-scope.md)
- [ADR 013 - CSRF 防護策略（SameSite=Lax + Origin Check）](../adr/013-csrf-defense-strategy.md)
- [ADR 021 - 採用 Tailwind v4 + shadcn/ui 作為前端 styling 堆疊](../adr/021-tailwind-v4-shadcn-ui.md)
- [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md) ⚠️ 取代後端 ADR 002
