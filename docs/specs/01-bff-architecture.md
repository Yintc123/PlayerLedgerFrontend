# BFF 架構規格書

## 1. 概覽

PlayerLedger Frontend 採用 **BFF（Backend for Frontend）** 模式，由 Next.js Server 作為瀏覽器的唯一對口，代理所有對後端 API Server 的請求。

### 核心原則

- 瀏覽器只認識 Next.js Server，完全不知道 API Server 的存在
- JWT 永遠不離開 Next.js Server（儲存在 server-side session，不進 Cookie、localStorage）
- 瀏覽器與 Next.js Server 的身份識別以 **HttpOnly Cookie（sessionId）** 為唯一憑證
- 所有 API 呼叫型別由 OpenAPI Schema 產生，不允許猜測性呼叫

---

## 2. 系統架構

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│                                                                 │
│  Cookie: sessionId=<opaque>  (HttpOnly, Secure, SameSite=Lax)  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  CloudFront + API Gateway                                       │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js Server（BFF 層）                                       │
│                                                                 │
│  Route Handlers  ── Session Store (Redis) ──▶ { jwt, userId }  │
│       │                                                         │
│       │ Authorization: Bearer <jwt>                             │
│       ▼                                                         │
│  API Client（型別由 OpenAPI Schema 產生）                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTPS + JWT
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Go API Server                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 層級職責

| 層級 | 技術 | 職責 |
|------|------|------|
| CDN | CloudFront | 靜態資源快取（`_next/static/`）、HTTPS 終止 |
| 入口 | API Gateway | 流量路由（Demo/Dev 環境） |
| BFF | Next.js Server | Session 管理、JWT 代理、請求轉換、授權檢查 |
| Session Store | Redis（ElastiCache） | 儲存 sessionId → { accessToken, refreshToken, userId, clientId, expiresAt, absoluteExpiresAt } |
| API Server | Go Lambda | 業務邏輯，以 JWT 驗證身份（family-based rotation，見後端 ADR 007） |

---

## 3. 請求流程

### 3.1 一般 API 請求

```
Browser                 Next.js BFF              Redis          API Server
   │                        │                      │                │
   │── GET /api/xxx ────────▶│                      │                │
   │   Cookie: sid=<id>      │── GET session ───────▶│                │
   │                        │◀─ { jwt, userId } ────│                │
   │                        │                      │                │
   │                        │── GET /xxx ──────────────────────────▶│
   │                        │   Authorization: Bearer <jwt>          │
   │                        │◀─ 200 { data } ───────────────────────│
   │◀── 200 { data } ───────│                      │                │
```

### 3.2 Next.js Server Component（SSR）請求

```
Browser                 Next.js Server            Redis          API Server
   │                        │                      │                │
   │── GET /players ────────▶│                      │                │
   │   Cookie: sid=<id>      │── GET session ───────▶│                │
   │                        │◀─ { jwt, userId } ────│                │
   │                        │── GET /api/players ───────────────────▶│
   │                        │◀─ 200 { players } ────────────────────│
   │◀── 200 HTML（含資料）──│                      │                │
```

---

## 4. 目錄結構

```
src/
├── app/
│   ├── (auth)/
│   │   └── login/
│   │       └── page.tsx            # GET  /login — 登入頁面（HTML）
│   ├── api/
│   │   ├── login/
│   │   │   └── route.ts            # POST /api/login — 建立 session，發 Cookie
│   │   ├── logout/
│   │   │   └── route.ts            # POST /api/logout — 銷毀 session，清 Cookie
│   │   └── [...path]/
│   │       └── route.ts            # ANY  /api/* — BFF Proxy（login/logout 不會被攔）
│   └── layout.tsx
│
├── lib/
│   ├── config.ts                   # 環境變數集中讀取、驗證、匯出型別化常數
│   ├── config.test.ts
│   │
│   ├── session/
│   │   ├── session.ts              # verifySession() + getValidAccessToken()（含 Redis Mutex）
│   │   ├── session.test.ts
│   │   ├── redis.ts                # ioredis singleton（開發環境 HMR 安全）
│   │   └── cookie.ts               # Cookie 屬性常數（name、MaxAge 等）
│   │
│   ├── request-id.ts               # getRequestId()：從 next/headers 讀取 X-Request-ID
│   ├── request-id.test.ts
│   │
│   ├── api-client/
│   │   ├── client.ts               # openapi-fetch 實例（不內建 auth，由呼叫端傳 header）
│   │   ├── client.test.ts
│   │   └── generated/              # 由 openapi-typescript 產生，勿手動修改
│   │       └── types.gen.ts        # paths 型別（openapi-fetch 泛型參數）
│   │
│   └── auth/
│       ├── login.ts                # 呼叫 /auth/login，取得 JWT pair，建立 Redis session
│       ├── login.test.ts
│       ├── logout.ts               # 刪除 Redis session
│       ├── logout.test.ts
│       ├── refresh.ts              # refreshTokens()：呼叫 /auth/refresh，回傳新 token pair
│       └── refresh.test.ts
│
├── proxy.ts                        # 路由保護（Next.js 16，Node.js Runtime）
└── schema/
    └── openapi.yaml                # OpenAPI Schema（API 唯一契約）
```

**路由優先序（Next.js App Router）**

Next.js 以「具體路由優先於 catch-all」解析衝突，因此 `/api/login` 與 `/api/logout` 不會被 `[...path]` 攔截：

```
POST /api/login   → app/api/login/route.ts       ✅ 精確匹配，優先
POST /api/logout  → app/api/logout/route.ts      ✅ 精確匹配，優先
GET  /api/players → app/api/[...path]/route.ts   ✅ catch-all 接住
```

### 4.1 Route Handler 執行慣例

所有 `app/api/**/route.ts` 必須在檔案頂部明示 runtime 與快取行為：

```ts
// app/api/[...path]/route.ts 與 app/api/health/route.ts 等所有 BFF route 共用
export const runtime = 'nodejs'        // 需 ioredis、Node fetch keep-alive 池、process.* APIs
export const dynamic = 'force-dynamic' // 阻止 Next.js 對 GET handler 做 build-time 預渲染或 ISR
```

**為何必須明示：**

- Next.js 16 對未標 `runtime` 的 route handler，編譯器會嘗試判斷可用 runtime；Edge runtime 不支援 `ioredis` 與 Node 專屬 API，誤判會在 build 時報錯但訊息隱晦
- 未標 `dynamic` 的 GET handler 可能被 Next.js 視為純函式做 static optimization，BFF 回應會被快取，session-aware 行為失效
- `force-dynamic` 也隱含 `revalidate = 0` 與不開啟 fetch cache，避免 upstream 回應被誤快取

**CORS：** BFF 與 Browser 同源（CloudFront → API Gateway → BFF 共用 hostname），**不啟用任何 CORS**。`next.config.ts` 不設 `Access-Control-Allow-Origin`，route handler 不送 CORS 回應 header。若未來需要跨來源呼叫，需先評估安全影響並另開 ADR——不要默默放寬。

### 4.2 Proxy Handler 契約（`app/api/[...path]/route.ts`）

BFF 代理是整套架構的心臟，本節定義其完整契約。實作須通過 §4.3 的 TDD 測試清單。

#### 支援的 HTTP method

```ts
export async function GET(req, ctx)    { return handleProxy(req, ctx) }
export async function POST(req, ctx)   { return handleProxy(req, ctx) }
export async function PUT(req, ctx)    { return handleProxy(req, ctx) }
export async function PATCH(req, ctx)  { return handleProxy(req, ctx) }
export async function DELETE(req, ctx) { return handleProxy(req, ctx) }
// HEAD / OPTIONS 不導出 —— Next.js 自動回 405，符合「BFF 不參與 CORS preflight」原則
```

#### URL 組合規則

| 輸入 | 結果 |
|------|------|
| Browser: `GET /api/players?cursor=abc&limit=20` | Upstream: `GET ${API_BASE_URL}/players?cursor=abc&limit=20` |
| Browser: `POST /api/players/123/topup` | Upstream: `POST ${API_BASE_URL}/players/123/topup` |
| Browser: `GET /api/?foo=bar`（空 path 段） | 400 `{error:"invalid_path"}` — 拒絕，不該發生 |

- `params.path: string[]` 由 Next.js 解析，**不做** `decodeURIComponent`（catch-all 保持原樣，避免雙重 decode）
- Query string 用 `req.nextUrl.searchParams` 取得**完整原始字串**直接拼接，**不重新 build**——避免 URL encoding 差異造成簽章類請求失敗
- 不正規化 trailing slash：browser 給什麼上游就拿到什麼

#### Header 轉發

依循 [ADR 005](../adr/005-proxy-header-forwarding.md) 的白名單策略：

- **Browser → Upstream**：只轉發 `Content-Type` / `Accept` / `Accept-Language` / `Accept-Encoding`；BFF 自行注入 `Authorization` / `X-Request-ID` / `traceparent` / `tracestate`
- **Upstream → Browser**：只轉發 `Content-Type` / `Cache-Control` / `X-Request-ID`；丟棄所有 hop-by-hop（RFC 7230 §6.1 全集）與 `Set-Cookie`

#### Body 轉發

- 採 **Read-and-Resend**：`body = await req.text()`（ADR 005）
- 不支援 streaming body / multipart file upload（v1 不需要；未來檔案上傳須走 S3 presigned URL，不經 BFF）
- Request body 上限 **1 MB**——超過直接 413 `{error:"payload_too_large"}`，避免 DoS

#### Timeout 與取消行為

```ts
async function callUpstream(req: NextRequest, url: string) {
  // 同時受 client 斷線與 BFF hard timeout 控制
  const signal = AbortSignal.any([
    req.signal,                                      // client 斷線時取消 upstream
    AbortSignal.timeout(config.api.timeoutMs),       // §5 API_TIMEOUT_MS，預設 20s
  ])
  return fetch(url, { method, headers, body, signal })
}
```

- `AbortSignal.any` 必要：若只用 `AbortSignal.timeout` 而不接 `req.signal`，client 關閉分頁時 BFF 仍會跑滿 20 秒 upstream call，浪費 socket 與 quota
- Timeout 觸發 → 回 **504**；客戶端斷線觸發 → 回 **499**（仿 nginx，雖非標準但對 metric 區隔有用）；upstream 5xx → 回 **502**；upstream 4xx → 透傳

#### 錯誤回應 shape

統一錯誤 body 格式（Browser 直接看到的）：

```json
{
  "error": "upstream_timeout",
  "requestId": "550e8400-...",
  "message": "upstream did not respond within the allowed time"
}
```

| HTTP | `error` | 觸發條件 | message 暴露程度 |
|------|---------|---------|-----------------|
| 400 | `invalid_path` | path 段為空、含非法字元 | 安全（無敏感資訊） |
| 413 | `payload_too_large` | request body > 1 MB | 安全 |
| 499 | `client_closed_request` | `req.signal` 中斷 | client 端通常已斷線，回應僅供 log |
| 502 | `upstream_failure` | upstream 網路錯誤、ECONNREFUSED 等 | **不可** include `cause.code` / stack；只給 `requestId` |
| 504 | `upstream_timeout` | `AbortSignal.timeout` 觸發 | 安全 |
| 透傳 | `<由 upstream 決定>` | upstream 回 4xx：body 直接透傳 | 由後端 ADR 004/005/006 控制 |

#### Authorization 注入規則

每筆轉發前：

1. `getValidAccessToken()`（spec 02 §3.4）取得有效 accessToken
2. 若回 `null` → **不打上游**，直接回 401 `{error:"unauthenticated", requestId}` 並指示 client 重新登入
3. 取得 token → 設 `Authorization: Bearer <token>` 加到 outbound headers，**覆蓋** browser 可能誤帶的任何 `Authorization`

### 4.3 Proxy Handler 測試規格

```ts
// app/api/[...path]/route.test.ts

// HTTP method
it('should export GET handler that forwards to upstream')
it('should export POST handler that forwards to upstream')
it('should export PUT / PATCH / DELETE handlers that forward to upstream')
it('should return 405 for HEAD and OPTIONS (handlers not exported)')

// URL 組合
it('should append catch-all path to API_BASE_URL preserving slashes')
it('should forward original query string unchanged')
it('should NOT re-encode query string parameters')
it('should return 400 invalid_path when path segment is empty')

// Header 白名單（依 ADR 005）
it('should forward Content-Type / Accept / Accept-Language / Accept-Encoding to upstream')
it('should NOT forward Cookie to upstream')
it('should NOT forward Host to upstream')
it('should NOT forward X-Forwarded-* to upstream')
it('should override Authorization header even if browser sent one')
it('should inject X-Request-ID from req or generate UUID v4 when absent')
it('should inject traceparent / tracestate via OTel propagation.inject')

// Header 過濾（response 端）
it('should NOT forward Set-Cookie from upstream to browser')
it('should NOT forward Transfer-Encoding / Connection / Keep-Alive / TE / Trailer / Upgrade')
it('should NOT forward Proxy-Authenticate / Proxy-Authorization')
it('should forward Content-Type / Cache-Control / X-Request-ID to browser')

// Body
it('should forward POST body to upstream verbatim')
it('should return 413 when request body exceeds 1 MB')
it('should not call upstream when body is invalid JSON for application/json POST')   // optional

// Auth
it('should return 401 unauthenticated when getValidAccessToken returns null')
it('should NOT call upstream when session is invalid')
it('should set Authorization: Bearer <token> from session on upstream call')

// Timeout / cancellation
it('should abort upstream fetch when AbortSignal.timeout(API_TIMEOUT_MS) fires')
it('should abort upstream fetch when client disconnects (req.signal)')
it('should return 504 upstream_timeout on timeout')
it('should return 499 client_closed_request when req.signal aborts')

// Error shape & info-leak
it('should return 502 upstream_failure on ECONNREFUSED')
it('should NOT include upstream error stack / cause.code in 502 response body')
it('should include requestId in every error response')
it('should pass through upstream 4xx body unchanged')   // 後端 ADR 004 validation errors 透傳
```

---

## 5. 環境變數

| 變數名稱 | 必填 | 說明 |
|---------|------|------|
| `REDIS_HOST` | ✅ | Redis 主機名稱或 IP |
| `REDIS_PORT` | ❌ | Redis 埠號，預設 `6379` |
| `REDIS_PASSWORD` | ❌ | Redis 密碼；無密碼時留空 |
| `REDIS_DB` | ❌ | Redis 資料庫索引，預設 `0` |
| `API_BASE_URL` | ✅ | Go API Server 的 Base URL |
| `API_TIMEOUT_MS` | ❌ | 對上游 API Server 單次 `fetch` 的 hard timeout，預設 `20000`（20 秒，對齊 §12.1 API Gateway 29 秒上限的安全餘量）。**不可設定大於 25000**——超過會被 API Gateway 直接砍而非走 BFF 自己的 timeout 路徑 |
| `CLIENT_ID` | ✅ | BFF 對應的後端 client policy 鍵值（如 `cms-web` / `public-web`）；login 時注入 request body 取得對應 refresh / absolute TTL，詳見後端 ADR 007。允許值由後端 `JWT_CLIENT_POLICIES` 定義。**必填**——由 ECS Task Definition 在每個環境明確指定，不在程式碼設預設值（避免 staging 誤用 cms-web 政策） |
| `PUBLIC_ORIGIN` | ✅ | BFF 對外服務的完整 origin（含 scheme + hostname + port），例 `https://playerledger.com`。供 proxy.ts 的 Origin check 使用，詳見 [ADR 013](../adr/013-csrf-defense-strategy.md) |
| `ALLOWED_ORIGINS_EXTRA` | ❌ | 額外允許的 origin（逗號分隔）。開發環境用以加入 `http://localhost:3000`；**production 應留空** |
| `SESSION_TTL_SECONDS` | ❌ | Session 閒置存活上限，預設 `28800`（8 小時，對齊 cms-web `abs_exp`）。實際 TTL 取 `min(SESSION_TTL_SECONDS, absoluteExpiresAt - now)`。**若 `CLIENT_ID` 改為 abs_exp 較長的 client（如 public-web 24h、mobile 180d），應同步調整此值** |
| `REFRESH_THRESHOLD_SECONDS` | ❌ | Token refresh 提前量，預設 `180`（3 分鐘）。**後端 access token 有效期為 15 分鐘**（後端 ADR 007），threshold 須遠小於此值（建議 ≤ 1/4），避免 token 已過期才開始 refresh |
| `REFRESH_LOCK_TTL_SECONDS` | ❌ | Redis mutex 最長持鎖時間，預設 `10`（秒） |
| `COOKIE_DOMAIN` | ❌ | Cookie Domain。**預設留空（Host-only cookie，最安全）**；只在「需要跨子網域共享 session」時才設定，且必須具體指明（如 `app.playerledger.com`）。設成 `.playerledger.com` 等於開放給所有子網域，任一子網域 XSS 即洩漏 sid——除非業務必要，避免之 |
| `NODE_ENV` | ❌ | `production` 時強制 Cookie `Secure` flag |
| `LOG_LEVEL` | ❌ | pino log 級別，預設 `info` |
| `APP_VERSION` | ❌ | build 時注入的 image tag，供 log 標記 |

> **不暴露為 env 的調校參數：** `TRUSTED_PROXY_HOPS`（ADR 011 固定為 2，因 CloudFront → API Gateway → ECS 路徑層數已知）、`HOP_BY_HOP_HEADER_BLOCKLIST`（ADR 005 寫死於 lib/api-client，源自 RFC 7230）。這些值與架構強耦合，不應由 env 改動。

---

## 6. Config 模組

### 6.1 設計原則

對齊後端 config 模組設計（後端 infrastructure.md §4）：

- 所有環境變數集中於 `src/lib/config.ts` 讀取，**禁止在其他模組直接存取 `process.env`**
- 必填欄位缺失或格式不合法 → 拋出 Error，Node.js 程序啟動失敗（fail fast）
- 匯出單一 `config` 物件，型別安全，呼叫端不再需要 `!` 斷言或 `??` 預設值

### 6.2 實作

```ts
// src/lib/config.ts

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function optionalInt(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  if (isNaN(parsed)) throw new Error(`${key} must be an integer, got: ${value}`)
  return parsed
}

// 對齊後端 OpenAPI schema ClientID enum，不允許未列值
// 若後端新增 client policy，CI schema-check job 會偵測 enum 異動並要求同步更新此清單
const ALLOWED_CLIENT_IDS = ['cms-web', 'public-web', 'ios-app', 'android-app'] as const
type ClientId = typeof ALLOWED_CLIENT_IDS[number]

function clientId(key: string): ClientId {
  const value = required(key)
  if (!(ALLOWED_CLIENT_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `${key}="${value}" is not a valid client_id. ` +
      `Allowed: ${ALLOWED_CLIENT_IDS.join(', ')} (per backend OpenAPI ClientID enum)`,
    )
  }
  return value as ClientId
}

export const config = {
  session: {
    ttlSeconds:              optionalInt('SESSION_TTL_SECONDS', 28800),  // 8h，對齊 cms-web abs_exp
    refreshThresholdSeconds: optionalInt('REFRESH_THRESHOLD_SECONDS', 180),
    refreshLockTtlSeconds:   optionalInt('REFRESH_LOCK_TTL_SECONDS', 10),
    cookieDomain:            process.env.COOKIE_DOMAIN || undefined,
  },
  redis: {
    host:     required('REDIS_HOST'),
    port:     optionalInt('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db:       optionalInt('REDIS_DB', 0),
  },
  api: {
    baseUrl:   required('API_BASE_URL'),
    clientId:  clientId('CLIENT_ID'),                          // 啟動時驗證屬於 OpenAPI ClientID enum，fail-fast
    timeoutMs: optionalInt('API_TIMEOUT_MS', 20_000),          // 上游 fetch 主動 timeout（§12.1）
  },
  app: {
    publicOrigin:   required('PUBLIC_ORIGIN'),
    allowedOrigins: new Set([
      required('PUBLIC_ORIGIN'),
      ...(process.env.ALLOWED_ORIGINS_EXTRA?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
    ]),
  },
  isProd: process.env.NODE_ENV === 'production',
} as const
```

> **為何 CLIENT_ID 在啟動時驗證 enum：** ECS Task Definition env 一旦設錯（如打成 `cms_web` 或 `cms-Web`），後端 login 會回 `400 invalid_client`，但 BFF 已經處在 production 流量上、所有登入都會失敗——錯誤發現時刻太晚。啟動時 fail-fast，Task 起不來，ECS rolling deploy 會自動 rollback。

### 6.3 各模組使用方式

| 模組 | 使用的 config 欄位 |
|------|------------------|
| `lib/session/redis.ts` | `config.redis` |
| `lib/session/session.ts` | `config.session.ttlSeconds`、`config.session.refreshThresholdSeconds`、`config.session.refreshLockTtlSeconds` |
| `lib/session/cookie.ts` | `config.session.ttlSeconds`、`config.session.cookieDomain`、`config.isProd` |
| `lib/auth/login.ts` | `config.api.baseUrl`、`config.api.clientId`、`config.api.timeoutMs` |
| `lib/auth/refresh.ts` | `config.api.baseUrl`、`config.api.timeoutMs` |
| `lib/api-client/client.ts` | `config.api.baseUrl`、`config.api.timeoutMs` |
| `proxy.ts` | `config.app.allowedOrigins` |

### 6.4 測試規格

```ts
// src/lib/config.test.ts
it('should throw when REDIS_HOST is missing')
it('should throw when API_BASE_URL is missing')
it('should throw when CLIENT_ID is missing')           // 不提供 default，缺值即失敗（§5 註）
it('should throw when CLIENT_ID is not in OpenAPI ClientID enum (e.g. "cms_web", "CMS-WEB")')
it('should throw when PUBLIC_ORIGIN is missing')
it('should throw when REDIS_PORT is not a valid integer')
it('should throw when API_TIMEOUT_MS is not a valid integer')
it('should use default values for all optional variables')
it('should default api.timeoutMs to 20000 when API_TIMEOUT_MS is unset')
it('should set isProd to true when NODE_ENV is production')
it('should set isProd to false when NODE_ENV is development')   // 負面案例
it('should parse ALLOWED_ORIGINS_EXTRA into the allowedOrigins set')
it('should always include PUBLIC_ORIGIN in allowedOrigins regardless of ALLOWED_ORIGINS_EXTRA')
it('should ignore empty entries and trim whitespace in ALLOWED_ORIGINS_EXTRA')
```

---

## 7. 測試策略（Overview）

遵循 CLAUDE.md 的 TDD 規則，測試分三層：

### Unit（Vitest）

測試對象：session 讀寫、JWT 解析、Cookie 設定邏輯

```ts
// lib/session/session.test.ts
it('should return null when session does not exist')
it('should store and retrieve jwt from session')
it('should delete session on logout')
```

### Component（React Testing Library）

測試對象：登入表單提交、錯誤訊息顯示、重導向行為

```ts
// app/(auth)/login/page.test.tsx
it('should show error message when credentials are invalid')
it('should redirect to dashboard after successful login')
```

### E2E（Playwright）

測試對象：完整登入 → 查詢 → 登出流程

```ts
// e2e/auth.spec.ts
test('complete login and logout flow')
test('should redirect to login when session expires')
```

---

## 8. GitHub Actions CI

### 8.1 設計原則

對齊後端 CI 設計模式（後端 infrastructure.md §23）：

- 觸發時機：**PR 開啟 / 更新**與 **push 到 main**
- 五個 job 平行執行：`typecheck`、`lint`、`schema-check`、`test-unit`、`test-e2e`
- `build` job 等待全部通過才執行
- E2E job 以 GitHub Actions `services` 啟動 Redis 容器
- 失敗時上傳 Playwright report artifact 供除錯

### 8.2 Job 相依關係

```
typecheck ─────────┐
lint ──────────────┤
schema-check ──────┤
test-unit ─────────┤
test-e2e ──────────┼──→ build ──→ image-scan ──→ deploy（push to main only）
audit-deps ────────┤
audit-licenses ────┘
```

安全掃描 job（`audit-deps`、`audit-licenses`）與其他驗證 job 並行,不阻擋彼此但**全部都得通過 build 才會跑**。
`image-scan` 掃描 build 產出的 Docker image。
`deploy` 只在 push to main 時觸發,PR 不部署（避免 fork PR 拿到 production credentials）。

### 8.3 npm scripts（`package.json` 必須定義）

| script | 指令 | 用途 |
|--------|------|------|
| `typecheck` | `tsc --noEmit` | 型別檢查 |
| `lint` | `next lint` | ESLint |
| `test` | `vitest run` | Unit + Component 測試（單次執行） |
| `test:watch` | `vitest` | 開發時監聽模式 |
| `test:e2e` | `playwright test` | E2E 測試 |
| `build` | `next build` | 生產建置 |
| `generate:types` | `openapi-typescript src/schema/openapi.yaml -o src/lib/api-client/generated/types.gen.ts` | 從 OpenAPI Schema 產生型別 |

### 8.4 Workflow 設定

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '22'

jobs:
  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npm run lint

  schema-check:
    name: OpenAPI Schema & Generated Types
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      # 1. Schema 語法驗證
      - run: npx --yes @redocly/cli lint src/schema/openapi.yaml
      # 2. 重新產生型別，確認 committed 的 types.gen.ts 與 schema 同步
      - run: npm run generate:types
      - name: Verify generated types are up to date
        run: git diff --exit-code src/lib/api-client/generated/

  test-unit:
    name: Unit & Component Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      # Unit / Component 測試 mock 所有外部依賴（Redis、API Server），不需服務
      - run: npm run test

  test-e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build
        env:
          REDIS_HOST: localhost
          REDIS_PORT: 6379
          API_BASE_URL: ${{ secrets.E2E_API_BASE_URL }}
      - run: npm run test:e2e
        env:
          REDIS_HOST: localhost
          REDIS_PORT: 6379
          API_BASE_URL: ${{ secrets.E2E_API_BASE_URL }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7

  audit-deps:
    name: Dependency Vulnerability Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      # 只擋 high / critical,允許 moderate（依社群實踐,moderate 多為 transitive deps 偶發報告）
      - run: npm audit --audit-level=high --omit=dev

  audit-licenses:
    name: License Compliance
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      # 禁止 GPL / AGPL 等 copyleft 授權混入生產依賴
      - run: npx --yes license-checker --production --failOn 'GPL;AGPL;LGPL'

  build:
    name: Build & Push Image
    runs-on: ubuntu-latest
    needs: [typecheck, lint, schema-check, test-unit, test-e2e, audit-deps, audit-licenses]
    permissions:
      id-token: write    # OIDC 取得 AWS 暫時憑證,避免長期 access key
      contents: read
    outputs:
      image-tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - name: Generate image tag
        id: meta
        run: echo "tag=${GITHUB_SHA::7}-$(date -u +%Y%m%d%H%M%S)" >> "$GITHUB_OUTPUT"
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ secrets.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
          tags: |
            ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ steps.meta.outputs.tag }}
            ${{ steps.ecr.outputs.registry }}/playerledger-frontend:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  image-scan:
    name: Container Image Vulnerability Scan
    runs-on: ubuntu-latest
    needs: build
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions:
      id-token: write
      contents: read
      security-events: write   # 把結果上傳到 GitHub Security tab
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ secrets.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr
      - name: Run Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ needs.build.outputs.image-tag }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'HIGH,CRITICAL'
          exit-code: '1'        # high / critical 直接擋 deploy
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif
```

### 8.5 必填 GitHub Secrets

| Secret | 說明 |
|--------|------|
| `E2E_API_BASE_URL` | E2E 測試指向的 Go API Server URL |
| `AWS_DEPLOY_ROLE_ARN` | OIDC 信任的 IAM Role ARN,有 ECR push 與 ECS update-service 權限 |
| `AWS_REGION` | 部署目標區域（如 `ap-northeast-1`） |
| `ECS_CLUSTER` | ECS 叢集名稱（CD job 使用） |
| `ECS_SERVICE` | ECS 服務名稱（CD job 使用） |
| `ECS_TASK_FAMILY` | ECS Task Definition family 名稱 |

> **不存 AWS access key 為長期 secret**: 採用 GitHub OIDC + IAM Role assumption,每次 workflow 取得有效期 1 小時的暫時憑證。長期 access key 一旦洩漏無法立即作廢,OIDC 暫時憑證限縮爆炸半徑。詳見 [AWS OIDC 設定指南](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)。

### 8.6 schema-check 的 SDD 保護機制

`schema-check` job 的 `git diff --exit-code` 確保 `types.gen.ts` 與 `openapi.yaml` 保持同步：

```
開發者修改 schema/openapi.yaml
→ 忘記執行 npm run generate:types
→ PR 觸發 CI
→ schema-check job 重新產生型別後發現 diff
→ CI 失敗，強制開發者同步更新型別
```

這是 SDD 工作流程的強制守門機制，避免型別與實際 API 契約脫節。

---

## 9. 健康檢查端點

> **設計變更（[ADR 012](../adr/012-health-probe-scope.md)）**：原本單一 `/api/health` 內聯檢查 Redis + 上游 API Server 的設計會造成連鎖故障（API Server 抖動 → BFF 全部被 ECS 替換）。改為兩個端點分離：
>
> - **`/api/health`（shallow）**：只檢查 BFF 自身依賴（process + Redis），供 ECS Target Group 與 Docker HEALTHCHECK 使用
> - **`/api/health/deep`**：額外檢查上游 API Server，供 CD smoke test、外部 uptime monitor、人為 dashboard 使用，**禁止放進 Target Group**

### 9.1 `/api/health`（shallow，給 ECS 用）

**目的：** 反映「BFF 自身能不能服務」，不綁定上游狀態。

**端點：** `GET /api/health`（公開，須加入 `proxy.ts` 的 `PUBLIC_PATHS`）

**回應（healthy）：**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "status": "ok",
  "timestamp": "2026-06-28T01:23:45.678Z",
  "checks": {
    "redis": { "status": "ok", "latencyMs": 1 }
  }
}
```

**回應（unhealthy）：**

```http
HTTP/1.1 503 Service Unavailable
{
  "status": "unhealthy",
  "checks": {
    "redis": { "status": "error", "error": "ECONNREFUSED", "latencyMs": 5000 }
  }
}
```

**檢查項目：**

| 項目 | 操作 | timeout | 失敗判定 |
|------|------|---------|---------|
| `redis` | `redis.ping()` | 2s | 例外或非 `"PONG"` |

**Timeout 實作方式（必須以 ioredis 內建機制，而非 `Promise.race`）：**

```ts
// lib/session/redis.ts —— ioredis 已有 commandTimeout，比手動 race 更精確
import Redis from 'ioredis'
export const healthRedis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  commandTimeout: 2000,   // 指令層級 timeout，整個 ping round-trip 2s 後 reject
  connectTimeout: 2000,   // connect 階段 timeout（重啟後第一次健康檢查觸發）
  maxRetriesPerRequest: 0,  // 健康檢查不重試，2s 內必有答案
  enableOfflineQueue: false, // Redis 斷線時直接 reject，不暫存指令
})
```

**為何不用 `Promise.race(ping, setTimeout(2000))`：**
- `Promise.race` 在 timeout 觸發後，背景的 `ping` 仍會繼續執行佔用 socket，直到 connect 自己超時（可能 30s+），造成 socket 堆積
- ioredis 的 `commandTimeout` 會主動切斷該 command 並在 stream 上發 error，乾淨地釋放資源
- 「Redis ping 在 30s 後才回 PONG」這種殭屍狀態，`Promise.race` 抓不到（因為 ping 最終會 resolve），ECS 會卡在「曾經 healthy」直到下次檢查

### 9.2 `/api/health/deep`（深度，給人類用）

**目的：** 驗證整鏈路（BFF → Redis + BFF → API Server）。**不可供 ECS 自動替換用**。

**端點：** `GET /api/health/deep`（公開，須加入 `PUBLIC_PATHS`）

**回應結構：** 同 shallow，但 `checks` 多一個 `apiServer` 欄位。

**檢查項目：**

| 項目 | 操作 | timeout | 失敗判定 |
|------|------|---------|---------|
| `redis` | 同 shallow | 2s | 同 shallow（ioredis `commandTimeout`） |
| `apiServer` | `GET ${API_BASE_URL}/health` | 3s | 非 2xx 或網路錯誤；用 `AbortSignal.timeout(3000)` |

所有檢查並行（`Promise.allSettled`）。整體 endpoint 內部 timeout 不超過 4s（< ECS Target Group 5s timeout，但 deep 本來就不放 Target Group）。

**回應 body 注意事項（防資訊洩漏）：**

- `error` 欄位只填 error name / code（如 `"ECONNREFUSED"`、`"TimeoutError"`）
- **絕不**包含 `error.stack`、`error.cause`、`error.message`（後者可能含內部 hostname / 連線字串）
- 對應測試見 §9.5

### 9.3 為何 shallow 仍需包含 Redis（而非純 process-alive）

純 process-alive 無法分辨「Node.js 程序活著但 Redis 掛了」的殭屍狀態。Redis 是 BFF 的**內部依賴**（同 VPC、無第二來源），失聯時 session 全壞，task 必須被替換才能讓 ECS 在新 AZ / 新節點重啟。API Server 不是內部依賴（跨服務、有獨立監控），所以不放 shallow。

### 9.4 ECS Target Group 設定

| 設定 | 值 | 理由 |
|------|-----|------|
| Path | `/api/health` | 對應 shallow 端點 |
| Protocol | HTTP | container 內部 |
| Healthy threshold | 2 | 連續 2 次成功才視為健康，避免單次抖動誤判 |
| Unhealthy threshold | 3 | 連續 3 次失敗才視為不健康，容忍偶發網路抖動 |
| Timeout | 5 秒 | 大於 endpoint 內部 timeout（2s） |
| Interval | 30 秒 | AWS 預設，平衡靈敏度與成本 |
| Success codes | `200` | 503 視為不健康 |

### 9.5 測試規格

```ts
// app/api/health/route.test.ts（shallow）
it('should return 200 when redis is reachable')
it('should return 503 when redis ping fails')
it('should timeout redis check after 2 seconds (ioredis commandTimeout fires)')
it('should release the socket cleanly when ping times out')   // 對應 §9.1 殭屍 socket 反例
it('should set Cache-Control no-store to prevent stale health responses')
it('should NOT call upstream API server')
it('should NOT include error.stack / error.cause / error.message in unhealthy response')   // 資訊洩漏
it('should return 200 within 2s + small overhead (slo budget for ECS Target Group 5s)')

// app/api/health/deep/route.test.ts（deep）
it('should return 200 when both redis and apiServer are reachable')
it('should return 503 when redis ping fails')
it('should return 503 when apiServer health endpoint returns 5xx')
it('should return mixed status (redis ok, apiServer fail) as 503 unhealthy')   // 混合失敗
it('should run redis and apiServer checks in parallel (total time ≤ max of individual timeouts)')
it('should timeout apiServer check after 3 seconds')
it('should NOT include error.stack / error.cause / error.message in unhealthy response')
```

---

## 10. 安全 Headers

### 10.1 設計原則

對齊 OWASP Secure Headers Project 建議,以**保守預設值**設定每一個 header。允許清單由開發者主動放寬,而非預設寬鬆。

設定位置：Next.js `next.config.ts` 的 `headers()` 函式。**不在 CloudFront 設定**——讓 headers 與應用程式版本一起部署,避免「程式碼改了但 CloudFront 設定還是舊的」失同步。

### 10.2 Header 清單

| Header | 值 | 理由 |
|--------|-----|------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 強制 HTTPS,2 年 TTL,可送 HSTS preload list |
| `Content-Security-Policy` | 見 §10.3 | 防 XSS,使用 nonce 機制 |
| `X-Content-Type-Options` | `nosniff` | 阻止瀏覽器猜測 MIME type |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 跨站只送 origin,同站送完整 URL |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), interest-cohort=()` | 明確關閉本應用不用的瀏覽器 API |
| `X-Frame-Options` | `DENY` | 防 clickjacking;CSP `frame-ancestors` 是現代版本,保留此 header 為舊瀏覽器 fallback |
| `Cross-Origin-Opener-Policy` | `same-origin` | 隔離跨來源視窗,防 Spectre 類攻擊 |
| `Cross-Origin-Resource-Policy` | `same-origin` | 限制資源被跨站嵌入 |

**刻意不設的 headers：**
- `Server`、`X-Powered-By`：Next.js 預設會帶,需於 `next.config.ts` 設 `poweredByHeader: false` 移除,避免洩漏技術棧
- `Expect-CT`：已被瀏覽器棄用（CT 改由 TLS 強制）

### 10.3 CSP 策略

Next.js 的 inline scripts（hydration、Server Component runtime）需要 nonce 才能執行。CSP 採用 **per-request nonce + strict-dynamic** 模式：

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-<random>' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests;
```

**為何 `style-src` 允許 `unsafe-inline`：** Next.js / styled-jsx / Tailwind 在 SSR 時會 inline 部分 critical CSS，完全禁用 inline style 會大幅破壞渲染。權衡後接受此風險（CSS injection 的攻擊面遠小於 script injection）。

### 10.3.1 Nonce 端到端注入流程

Next.js 16 的 nonce 機制需要三段協作，缺一不可——否則整個頁面 hydration 會失敗（瀏覽器把 framework 的 inline script 全部擋掉）。

```
┌── proxy.ts ──────────────────────────────────────┐
│  1. 產生 per-request nonce                       │
│  2. 設定 Content-Security-Policy response header │
│  3. 將 nonce 寫入 request header `x-nonce`,      │
│     供下游 Server Component 透過 headers() 讀取  │
└──────────┬───────────────────────────────────────┘
           │ next request headers 帶 `x-nonce`
           ▼
┌── app/layout.tsx ────────────────────────────────┐
│  4. (await headers()).get('x-nonce') 讀出 nonce   │
│  5. 傳給 <Script nonce={nonce}> 與任何 inline    │
│     <script nonce={nonce}>                        │
└──────────────────────────────────────────────────┘
```

#### proxy.ts 端

```ts
// proxy.ts（節錄，已合併 §10.3 CSP 與其餘保護邏輯）
import { NextRequest, NextResponse } from 'next/server'

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ')
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')

  // ... 其餘檢查（Origin / session / rate limit）...

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('X-Request-ID', requestId)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', buildCsp(nonce))
  return response
}
```

#### Root layout 端

```tsx
// app/layout.tsx
import { headers } from 'next/headers'
import Script from 'next/script'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html>
      <body>
        {children}
        {/* Next.js Script 必須帶 nonce,否則被 CSP 擋 */}
        <Script src="/some-script.js" nonce={nonce} strategy="afterInteractive" />
      </body>
    </html>
  )
}
```

> **為何 nonce 透過 request header 而非 cookie / context 傳遞**：Next.js Server Component 沒有跨組件的可變 context，request header 是 framework 唯一支援的「per-request 注入」管道。`headers()` API 會自動取到 proxy.ts 在 `NextResponse.next({ request: { headers } })` 內設置的版本。

> **為何 nonce 不能在 layout 內 `randomUUID()` 自己產**：CSP header 必須與頁面 script 的 nonce 一致，但 CSP header 由 proxy.ts 寫入 response，layout 沒有機會修改 response header。唯一保證一致的做法是 proxy.ts 統一產生並透過 request header 傳下去。

#### 測試規格（補充至 §10.5）

```ts
it('should generate a new nonce per request')
it('should set Content-Security-Policy header with nonce-<value>')
it('should set x-nonce request header for downstream Server Components')
it('should reject inline script without nonce in browser')
```

### 10.4 next.config.ts 範例

```ts
// next.config.ts
import type { NextConfig } from 'next'

const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security',     value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options',        value: 'nosniff' },
  { key: 'Referrer-Policy',               value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  { key: 'X-Frame-Options',               value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy',    value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy',  value: 'same-origin' },
]

const config: NextConfig = {
  poweredByHeader: false,   // 移除 X-Powered-By: Next.js
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
    ]
  },
}

export default config
```

CSP header 因含 per-request nonce,**不在 `next.config.ts` 設定**,改由 `proxy.ts` 動態組裝後注入到 response。

### 10.5 測試規格

```ts
// e2e/security-headers.spec.ts
test('should set HSTS header with preload directive')
test('should set X-Content-Type-Options nosniff on all responses')
test('should set strict Referrer-Policy on all responses')
test('should not leak X-Powered-By header')
test('should inject CSP nonce on each page request')
test('should reject inline script without nonce in browser console')
```

### 10.6 驗證工具

部署後以以下工具驗證：

- [securityheaders.com](https://securityheaders.com) — 目標分數 A+ 
- [Mozilla Observatory](https://observatory.mozilla.org) — 目標分數 90+

CI 階段可選擇性加入 `@security-headers/cli` 自動掃描（屬 nice-to-have,非必要）。

---

## 11. CD Pipeline

### 11.1 設計原則

- **CI 與 CD 分離**：CI 在 `.github/workflows/ci.yml`,CD 在 `.github/workflows/cd.yml`,各自有清楚邊界
- **環境分離**：staging 與 production 是獨立的 ECS Cluster + Service,有獨立 IAM Role
- **Production 強制人工 approval**：staging 自動,production 需 GitHub Environment approval
- **無中斷部署**：使用 ECS rolling deployment (`minimumHealthyPercent: 100`)
- **可回滾**：保留前 5 個 image tag,出問題可改 task definition 指向舊 tag

### 11.2 觸發時機

| 觸發 | 動作 |
|------|------|
| Push to main 且 CI + image-scan 全通過 | 自動部署 staging |
| Staging 部署成功 + 人工 approve | 部署 production |
| Manual workflow_dispatch | 可指定任意 image tag 部署到任意環境（緊急回滾用）|

### 11.3 Workflow 設定

```yaml
# .github/workflows/cd.yml
name: CD

on:
  workflow_run:
    workflows: ["CI"]
    branches: [main]
    types: [completed]
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
      image-tag:
        required: true
        description: 'Image tag to deploy (e.g., abc1234-20260628120000)'

env:
  AWS_REGION: ${{ secrets.AWS_REGION }}

jobs:
  # 從觸發本 workflow 的 CI run 抓 image-tag。
  # workflow_run 不會直接傳 outputs，需要透過 artifact 跨 workflow 傳遞。
  # CI build job 須對應上傳 image-tag.txt 作為 artifact（內容為單行 tag 字串）。
  resolve-tag:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.tag.outputs.value }}
    permissions:
      actions: read
      contents: read
    steps:
      - name: Resolve image tag
        id: tag
        env:
          GH_TOKEN: ${{ github.token }}
          DISPATCH_TAG: ${{ github.event.inputs.image-tag }}
          RUN_ID: ${{ github.event.workflow_run.id }}
        run: |
          set -euo pipefail
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "value=$DISPATCH_TAG" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          # 從 CI run 下載 image-tag artifact
          gh run download "$RUN_ID" --name image-tag --dir /tmp/tag --repo "${{ github.repository }}"
          TAG=$(cat /tmp/tag/image-tag.txt)
          echo "value=$TAG" >> "$GITHUB_OUTPUT"

  deploy-staging:
    needs: resolve-tag
    if: github.event.workflow_run.conclusion == 'success' || github.event.inputs.environment == 'staging'
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      # 必須在 render task-definition 之前 login，否則 steps.ecr.outputs.registry 為空
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr

      - name: Render new task definition
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: deploy/task-definition.staging.json
          container-name: playerledger-frontend
          image: ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ needs.resolve-tag.outputs.image-tag }}

      - name: Deploy to ECS Staging
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.render.outputs.task-definition }}
          cluster: ${{ secrets.ECS_CLUSTER }}-staging
          service: ${{ secrets.ECS_SERVICE }}-staging
          wait-for-service-stability: true     # 等到 deployment 穩定才視為成功
          wait-for-minutes: 10

      - name: Smoke test
        # 走 /api/health/deep 驗證整鏈路（含上游 API Server），ECS Target Group 用的是 shallow 版
        run: |
          for i in {1..10}; do
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://staging.playerledger.com/api/health/deep)
            [ "$STATUS" = "200" ] && exit 0
            sleep 5
          done
          echo "Smoke test failed: /api/health/deep did not return 200"
          exit 1

      - name: Verify trusted client IP extraction
        # 對應 ADR 011：驗證 BFF 不會把 browser 偽造的 XFF 當成 client IP
        # 預期 log 中的 clientIp ≠ 1.2.3.4（會是真實 CF edge → browser IP）
        run: |
          curl -s -H 'X-Forwarded-For: 1.2.3.4' https://staging.playerledger.com/api/health/deep > /dev/null
          echo "Check CloudWatch Logs: clientIp must not be 1.2.3.4"

  deploy-production:
    needs: [resolve-tag, deploy-staging]
    if: github.event_name == 'workflow_run' || github.event.inputs.environment == 'production'
    runs-on: ubuntu-latest
    environment: production    # GitHub Environment,設定要求人工 approval
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr

      - name: Render new task definition
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: deploy/task-definition.production.json
          container-name: playerledger-frontend
          image: ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ needs.resolve-tag.outputs.image-tag }}

      - name: Deploy to ECS Production
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.render.outputs.task-definition }}
          cluster: ${{ secrets.ECS_CLUSTER }}-production
          service: ${{ secrets.ECS_SERVICE }}-production
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Smoke test
        run: |
          for i in {1..10}; do
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://playerledger.com/api/health/deep)
            [ "$STATUS" = "200" ] && exit 0
            sleep 5
          done
          exit 1
```

> **CI 對應補充：** §8.4 的 `build` job 在 push image 之後須加一步上傳 image-tag artifact，供本 workflow 跨 workflow 讀取：
>
> ```yaml
> - name: Persist image tag for CD
>   if: github.event_name == 'push' && github.ref == 'refs/heads/main'
>   run: echo -n "${{ steps.meta.outputs.tag }}" > image-tag.txt
> - uses: actions/upload-artifact@v4
>   if: github.event_name == 'push' && github.ref == 'refs/heads/main'
>   with:
>     name: image-tag
>     path: image-tag.txt
>     retention-days: 30
> ```
>
> **不可直接用 `github.sha`：** CI 推的 image tag 是 `${GITHUB_SHA::7}-<timestamp>`，這個格式無法在 CD 時重建（時間戳已遺失），所以必須由 CI 顯式傳遞。

### 11.4 ECS Task Definition 樣板

Task definition 以版本控制管理,範本檔案放在 `deploy/task-definition.{env}.json`：

```json
{
  "family": "playerledger-frontend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCOUNT:role/playerledger-frontend-task-role",
  "containerDefinitions": [
    {
      "name": "playerledger-frontend",
      "image": "PLACEHOLDER_FILLED_BY_CI",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV",    "value": "production" },
        { "name": "REDIS_HOST",  "value": "your-cluster.cache.amazonaws.com" },
        { "name": "REDIS_PORT",  "value": "6379" },
        { "name": "API_BASE_URL",  "value": "https://api.playerledger.com" },
        { "name": "CLIENT_ID",     "value": "cms-web" },
        { "name": "PUBLIC_ORIGIN", "value": "https://playerledger.com" }
      ],
      "secrets": [
        { "name": "REDIS_PASSWORD", "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:redis-password" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/api/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 30
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/playerledger-frontend",
          "awslogs-region": "REGION",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

**為何敏感值用 ECS Secrets 而非環境變數：** Environment 區段的值在 ECS Console / API 直接可見,Secrets 區段的值僅引用 Secrets Manager / SSM ARN,實際內容 task 啟動時才注入,且不會顯示在 Console。

### 11.5 ECS Service 設定要點

| 設定 | 值 | 理由 |
|------|-----|------|
| `desiredCount` | ≥ 2 | 至少 2 個 task,避免單點 |
| `deploymentConfiguration.minimumHealthyPercent` | 100 | rolling deployment 不允許舊 task 全數下線 |
| `deploymentConfiguration.maximumPercent` | 200 | 新 task 全部 ready 後才下線舊 task |
| `deploymentConfiguration.deploymentCircuitBreaker.enable` | true | 部署失敗自動回滾 |
| `deploymentConfiguration.deploymentCircuitBreaker.rollback` | true | 同上 |
| `healthCheckGracePeriodSeconds` | 60 | container 啟動到開始接收健康檢查的緩衝時間 |

### 11.6 回滾流程

部署出問題時：

1. **自動回滾**：若 ECS Circuit Breaker 偵測到新 task 連續啟動失敗,自動切回舊 task definition
2. **手動回滾**：找到上一個成功的 image tag（ECR console 或 `aws ecr list-images`）,執行 `workflow_dispatch` 指定該 tag 部署
3. **緊急停用**：直接到 ECS console 把 `desiredCount` 降為 0（會 503,但比繼續壞要好）

**為何不採 Blue-Green 部署：** Blue-Green 需要兩套完整環境,成本翻倍,且需要 CodeDeploy 整合（複雜度上升）。本專案規模下 rolling deployment + Circuit Breaker 已足夠安全,Blue-Green 留待流量規模證明需要時再升級。

---

## 12. 工程規範

### 12.1 SSR 與長時請求

本專案以 API Gateway 為入口（demo 階段），請求最長 **29 秒**會被強制截斷。為避免「使用者看到空白頁」：

- 預期超過 **20 秒**的 SSR 頁面或 API 必須改用分頁、async job + polling 或 client-side fetch + skeleton
- 報表類查詢若可能超過 20 秒，後端應提供 async 模式（`POST /reports` 建立 job → `GET /reports/{id}` 輪詢）
- `fetch()` 呼叫上游 API Server 必須帶 `AbortSignal.timeout(20_000)` 主動上限,避免被 API Gateway 在最後一刻砍掉、使用者看到 504 而非可控錯誤

正式 production 改用 ALB 後此限制消失，但分頁 / async 設計仍是可擴展性的最佳實踐。

### 12.2 測試命名以 spec 為準

依 CLAUDE.md 的 TDD 規範，所有測試名稱已在對應 spec 寫好（如 `02-auth-session.md §9`、`01-bff-architecture.md §6.4 / §9.5`）。實作時：

1. 先讀對應 spec 的測試清單
2. 依清單建立失敗測試（Red）
3. 實作最少程式碼讓測試通過（Green）
4. spec 沒列的測試代表設計階段未要求，新增前先評估是否該回頭更新 spec

避免「測試與 spec 不同步」，這是 SDD + TDD 結合的核心紀律。

---

## 13. 關聯文件

- [認證與 Session 規格](./02-auth-session.md)
- [Observability 規格](./03-observability.md)
- [Dockerfile 與 Build 規格](./04-dockerfile-build.md)
- [ADR 001 - 部署架構](../adr/001-deployment-architecture.md)
- [ADR 002 - BFF 路由結構設計](../adr/002-bff-route-structure.md)
- [ADR 003 - Session 函式 API 設計](../adr/003-session-api-design.md)
- [ADR 004 - Token Refresh 並發控制：Redis Mutex](../adr/004-token-refresh-mutex.md)
- [ADR 005 - BFF Proxy Header 轉發規則](../adr/005-proxy-header-forwarding.md)
- [ADR 006 - SessionId 不採用 HMAC 簽章](../adr/006-sessionid-no-hmac.md)
- [ADR 007 - 路由保護：公開路徑白名單放在 Handler 內](../adr/007-public-paths-in-handler.md)
- [ADR 008 - Token Refresh 等待者改用 bounded polling](../adr/008-refresh-waiter-bounded-polling.md)
- [ADR 009 - Rate Limiting 實作層](../adr/009-rate-limiting-strategy.md)
- [ADR 010 - 對齊後端 ADR 007 JWT 變更](../adr/010-align-with-backend-adr007-jwt.md)
- [ADR 011 - 邊緣安全強化（XFF 信賴 + login fail-closed）](../adr/011-edge-security-hardening.md)
- [ADR 012 - 健康檢查端點 shallow / deep 分離](../adr/012-health-probe-scope.md)
- [ADR 013 - CSRF 防護策略（SameSite=Lax + Origin Check）](../adr/013-csrf-defense-strategy.md)
- [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md)
