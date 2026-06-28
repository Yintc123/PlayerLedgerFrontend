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
> - 所有錯誤回應採 envelope：`{ "success": false, "request_id": "...", "error": "<snake_case>", "details": [...] }`；BFF 對 4xx **原樣透傳** body 給 Browser（前端據此處理 validation 錯誤）
> - 欄位命名：後端 snake_case（`access_token`、`expires_in`），BFF 內部與對 Browser 一律 camelCase。轉換層集中於 `lib/auth/*.ts` 與 `lib/api-client/`
> - Login 欄位名：後端 `LoginRequest.username`（**不是 email**），BFF 對 Browser 接受 `username` 也兼容 `email` alias（§8）
> - **`abs_exp` 來源：refresh token JWT claim**（後端 ADR 007 §「Token 規格」line 104 列出 refresh JWT claims 含 `abs_exp`）。BFF 對 refresh token 做 **base64-decode payload 不驗簽**，讀出 `abs_exp` 寫進 session。詳見 §3.1 與 §11.1

### Next.js 16 API 注意事項

Next.js 15 起，`cookies()` 與 `headers()` 改為非同步 API，Next.js 16 延續此設計。
本文件所有「從 Cookie 讀取 sessionId」的實作，包含 Route Handler 與 Server Component，均需 `await`：

```ts
// ❌ Next.js 14 以前
import { cookies } from 'next/headers'
const sid = cookies().get('sid')?.value

// ✅ Next.js 15+ / 16
import { cookies } from 'next/headers'
const sid = (await cookies()).get('sid')?.value
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
TTL:   min(SESSION_TTL_SECONDS, absoluteExpiresAt - now)
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
| `MaxAge` | `min(SESSION_TTL_SECONDS, absoluteExpiresAt - now)` | 與 Redis TTL 同步；達 abs_exp 後 cookie 自動失效，等同 server-side TTL 兜底 |
| `Domain` | **不設**（Host-only cookie，最安全） | `__Host-` 前綴**禁止** `Domain` 屬性。若未來業務需要跨子網域共享 session，必須改名（不能用 `__Host-` 前綴）並另開 ADR 評估安全影響；**禁止設為 `.playerledger.com` 等通配形式**——任一子網域 XSS 即洩漏 sid |
| `Partitioned` | **不設** | CHIPS（第三方 cookie 分區）僅適用於 cross-site iframe 嵌入；本架構是 first-party only，加上反而限制功能且不增加安全性。若未來需要被嵌入到第三方頁面才評估 |

> **為何用 `__Host-` 前綴：** 它是瀏覽器原生的「我絕對是 host-only cookie」宣告，攻擊者即使透過 Cookie injection 漏洞嘗試從子網域寫入也會被瀏覽器拒絕（任何帶 `Domain=` 屬性的同名 cookie 都會被丟掉）。RFC 6265bis §4.1.3 規範。

> **變數命名注意：** spec 02 後續所有「`sid` cookie」字樣，在 production 環境實際 name 為 `__Host-sid`。`request.cookies.get(SESSION_COOKIE_NAME)` 應從 `lib/session/cookie.ts` 匯入常數，不要硬編。

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
2. 呼叫 API Server `POST /auth/login`，body **必須帶 `client_id`**（BFF 對應 `cms-web`，由 `CLIENT_ID` 環境變數注入）；前端送 `email` 也接受，BFF 將 `email` 欄位映射到後端 `username`（後端僅認 `username` 一個欄位名）
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

> **後端欄位命名對應：** 後端 OpenAPI 採 snake_case，BFF 內部型別採 camelCase。轉換層集中在 `lib/auth/login.ts` 與 `lib/auth/refresh.ts`，**不污染 SessionData 結構**。

> **`username` vs `email`：** 後端 OpenAPI `LoginRequest.required: [username, password, client_id]`，欄位名為 `username`。本應用 `username` 實質上即 email（後端 `UserService` 以 email 作 lookup），但欄位**契約名稱必須是 `username`**，BFF 在送出前做映射。

> **為何 BFF 不自己決定 `client_id`：** 雖然目前 BFF 只服務 CMS 後台（固定 `cms-web`），未來若同一 Next.js BFF 同時服務公開 web（`public-web`），會由部署環境變數區分；硬編碼會綁死，做成 config 才能切換。

> **為何 BFF 不驗簽就直接讀 refresh JWT claim 安全：** BFF 沒有 `JWT_REFRESH_SECRET`（也不應該有），無法驗簽。但 `abs_exp` 在 BFF 端**只用作 hint**——不論值是否被竄改，安全把關都在後端：
> - 若竄改成更大值 → BFF 誤判 family 還活著，繼續打 refresh → 後端 `VerifyRefresh` 從 Redis state 取真實 `AbsoluteExp`，拒絕
> - 若竄改成更小值 → BFF 提早 short-circuit，使用者比預期早登出（DoS but no security breach）
> - 攻擊者本來就有 refresh JWT 才能竄改，他能竄改不代表他知道 secret，仍無法簽出有效新 token
>
> 此模式為標準 BFF / SDK 行為（同 Auth0 SDK、Okta SDK、Microsoft Identity 等）。詳見 §11.1。

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

1. (await cookies()).get('sid')?.value
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
   ├─ 成功 → SET session:<sid>：
   │           accessToken / refreshToken / expiresAt 用後端新值（`expires_in` 計算）
   │           **absoluteExpiresAt 保留原值**（rotation 不延長 family abs_exp）
   │
   │           可選 debug 檢查：readJwtClaims(newRefreshToken).abs_exp * 1000 應等於
   │           session.absoluteExpiresAt（後端 ADR 007 line 266 規定 rotation 重簽時
   │           abs_exp 從 state.AbsoluteExp 取，不延長）；若不符 → log warn
   │           （可能是後端 bug、policy 異動、或 family 被人為延長），但仍以儲存值為準
   │
   │         DEL lock，return 新 accessToken
   ├─ 失敗 401 → DEL session，DEL lock，return null
   │              （不論 token_expired / absolute_expired / replay_detected / session_not_found / invalid_token，
   │                前端統一走 login；backend error code 寫入 observability log，不影響行為）
   └─ 失敗 網路錯誤 / 5xx → DEL lock，return null（**不刪 session**，下次請求重試一次 refresh）
      （finally 保證 lock 一定被釋放，即使 refreshTokens 拋出例外）

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
> - 網路錯誤 / 5xx 可能只是後端暫時抖動，session 仍可能有效；刪了反而誤踢；下次請求發現 lock 已釋放會自然重試一次
> - **但等待者 / 下次請求不得自動重試多次**：規則仍是「refresh 失敗 → 一次重試後若仍失敗 → 走 login」，避免反覆觸發後端

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
- 持鎖者遇到網路錯誤 / 5xx → 僅 DEL lock，**不刪 session**；下次請求可再嘗試一次 refresh（但不得無上限重試）
- 等待者輪詢中發現 session 已被刪除 → return null
- 等待者超過 max wait（持鎖者 crash 或 refresh 異常緩慢）→ return null；下個請求發現 lock 已 TTL 超時，可重新搶鎖嘗試
- 所有請求收到 null → 回傳 `401` 給瀏覽器 → 導向登入頁

> **絕對禁止：在 refresh 失敗後自動重試 refresh 端點。** 即便等待者 polling 期間發現持鎖者失敗、想自己再 refresh 一次，都不可以。後端 ADR 007 的 replay detection 設計就是針對「同一個 refresh token 被使用多次」觸發，自動重試會把合法使用者打成攻擊者、整個 family 連帶被廢。

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
 *  1. POST `${API_BASE_URL}/auth/refresh` body: `{ "refresh_token": refreshToken }`
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

export async function proxy(request: NextRequest) {
  const sid = request.cookies.get('sid')?.value
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

## 4. Next.js Proxy 路由保護

**Next.js 16：`middleware.ts` → `proxy.ts`**

Next.js 16 將路由保護檔案從 `middleware.ts` 改名為 `proxy.ts`，語意更精確（「在 App 前面的網路邊界」）。
`proxy.ts` 僅支援 Node.js Runtime，無法設定，不需要宣告 `runtime`。
`middleware.ts` 仍保留，但僅用於需要 Edge Runtime 的場景（地理位置判斷等），路由保護一律改用 `proxy.ts`。

```ts
// proxy.ts（Next.js 16）
import { NextRequest, NextResponse } from 'next/server'
import { verifySession } from '@/lib/session/session'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger/logger'

// 不需要 session 即可存取的公開路徑（exact match，避免前綴誤判，詳見 ADR 007）
// 新增公開路徑時：1) 在此處加入精確路徑 2) 對應 handler 自行處理 sid 缺失的情況
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/api/login',
  '/api/logout',
  '/api/health',        // shallow health（ECS / docker）— 詳見 ADR 012
  '/api/health/deep',   // deep health（CD smoke test / dashboard）— 詳見 ADR 012
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
  if (!PUBLIC_PATHS.has(pathname)) {
    const sid = request.cookies.get('sid')?.value
    if (!sid) {
      logger.info({ type: 'auth.proxy.redirect', reason: 'no_sid', path: pathname, requestId }, 'redirect to login')
      return NextResponse.redirect(loginUrl(request, true))
    }

    const session = await verifySession(sid)
    if (!session) {
      logger.info({ type: 'auth.proxy.redirect', reason: 'invalid_session', path: pathname, requestId }, 'redirect to login')
      return NextResponse.redirect(loginUrl(request, true))
    }
  }

  // 5. 注入下游 request headers（公開與受保護路徑都注入）
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
   - 從 request 取出 `sid` Cookie；無 Cookie → 302 至 `/login?redirect=<原始路徑>`
   - 檢查 `sid` 格式（`/^[0-9a-f]{64}$/`）；格式不合 → 302 至 `/login`
   - `GET session:<sid>`；key 不存在 → 302 至 `/login?redirect=<原始路徑>`
   - Session 有效 → 繼續
5. **下游 header 注入** + **response CSP** → `NextResponse.next()`

每個 redirect 事件都會發 `auth.proxy.redirect` log（`reason` 為 `no_sid` / `invalid_session`），供 debug 「使用者一直被踢回 login」的高頻問題（詳見 [03-observability.md §2.5](./03-observability.md#25-認證事件-log)）。

---

## 5. BFF Proxy Route Handler

所有 API 請求透過 `/api/[...path]/route.ts` 轉發：

```
Browser 請求                     轉發至 API Server
GET  /api/players            →   GET  {API_BASE_URL}/players
POST /api/players/{id}/topup →   POST {API_BASE_URL}/players/{id}/topup
```

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
  const apiResponse = await fetch(`${process.env.API_BASE_URL}/${path}`, {
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

**實作位置：** Browser 端的 React 組件（如 `IdleTimer` provider，包在 `app/layout.tsx` 或 CMS 區段 layout 內）。

**演算法：**

```
1. 監聽 mousemove / keydown / click / touchstart 事件
2. 每次事件觸發重置 idle timer（throttle 1s，避免每次滑鼠移動都重置）
3. timer 達 15 分鐘無重置 → 主動發 fetch('/api/logout', { method: 'POST' })
4. logout 完成（無論 BFF 回應）→ window.location.href = '/login?reason=idle_timeout'
```

> **為何 timer 在 Browser 端而非 BFF：** 互動事件只能在 Browser 端偵測，BFF 無法知道使用者是否在頁面前活動。BFF 端的「閒置」只能以「沒打 API」近似，而後端的 refresh token sliding 1h TTL 已經提供這層保證（連續 1 小時無任何 API 呼叫 → refresh token JWT exp 自然失效）。

> **Browser timer 並非安全邊界**：使用者可關閉 JS 繞過 timer，攻擊者拿到 token 也不會被 timer 擋。安全邊界在後端 access token 15 分鐘 + refresh token rotation；前端 timer 只是「合法使用者離開座位後 15 分鐘內降低被旁觀者操作的風險」這個 UX 場景。

## 5.6 多分頁協調

同一瀏覽器多分頁同時打 API 時，每個分頁都會發請求至 BFF，BFF 端的 [Redis Mutex（ADR 004）](../adr/004-token-refresh-mutex.md) 已涵蓋此情境：所有分頁的請求都對應同一個 `sid`，搶同一把 `refresh_lock:<sid>`，只有一個會實際呼叫後端 refresh。

**因此前端 Browser 不需要 BroadcastChannel / Web Lock 協調 refresh**（後端 ADR 007 §「前端配合」描述的是「直接持有 JWT 的 SPA」場景，本 BFF 架構不適用）。

**Browser 端仍須協調的場景：**

- **Idle timer 活動同步（重要 UX）**：idle timer **以「整個瀏覽器 session」為單位而非分頁**。任一分頁有 mousemove / keydown / click → 透過 `BroadcastChannel('auth')` 廣播 `{ type: 'activity', at: <ms> }`，所有分頁收到即重置自己的 idle timer。否則「A 分頁有人在用、B 分頁閒置 15 分鐘把所有人踢出」的 UX 不可接受
- **Logout 廣播**：任一分頁登出 → 廣播 `{ type: 'logout' }`，其他分頁立即跳 login
- **登入完成**：登入分頁廣播 `{ type: 'login' }`，其他分頁可依需求重新請求資料

**訊息格式：**

```ts
type AuthChannelMessage =
  | { type: 'activity'; at: number }                          // 任一分頁有使用者互動
  | { type: 'logout';   at: number;  nonce: string }          // 任一分頁登出
  | { type: 'login';    at: number;  userId: string }         // 任一分頁登入完成
```

**廣播頻率控制：** `activity` 事件 throttle 1 秒（與本地 timer 重置同頻率），避免每次滑鼠移動都廣播。

**Stale message 防護：** 訊息需附 `at` (Date.now()) 與隨機 `nonce`，收到方依以下規則丟棄：

- 收到 `logout` 但 `at < currentSession.createdAt` → 忽略（屬於更早的 session，分頁切換 / login 順序競爭）
- 收到自己廣播的訊息（透過比對 `nonce` 或在發送前 `nonce = crypto.randomUUID()` + 記在 Set 中，自己 echo 回來時跳過）→ 忽略
- 收到 `login` 但 `userId === currentUserId` → 忽略（同帳號登入廣播，無需重啟資料載入）

> **為何要這層防護**：假設情境「A 分頁登出 → B 分頁切換帳號登入 → A 分頁的舊 logout 訊息此時才到」，若不加防護 B 分頁會被誤踢。`createdAt` 比對能擋住跨 session 的訊息回流。

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

| 端點 | 限制 | Redis 故障時 | 回應 |
|------|------|-------------|------|
| `POST /api/login` | 10 次/分鐘/IP | **fail-closed**（503） | `429 Too Many Requests` + `Retry-After` |
| `POST /api/logout` | 無限制 | — | — |
| 其他 `/api/*` | 100 次/分鐘/session（無 session fallback 用 IP） | **fail-open**（放行 + log + metric） | `429 Too Many Requests` + `Retry-After` |

採**雙層 defense-in-depth**：

1. **API Gateway Throttling**（粗糙、邊緣防護）：account-level + per-route QPS 上限,在請求進入 ECS 前就拒絕惡意流量
2. **proxy.ts + Redis sliding window limiter**（精細、業務邏輯）：per-IP / per-session 計數,提供上表規格與客製化錯誤訊息

**IP 取得：** 不可取 XFF 最左值（browser 可偽造）。從 XFF 右側跳過信賴 proxy 數（`TRUSTED_PROXY_HOPS=2`，對應 CloudFront + API Gateway）後取真實 client IP。詳見 [ADR 011 §「Client IP 提取」](../adr/011-edge-security-hardening.md#client-ip-提取)。

**失效模式：** login 與其他端點策略不同——login 是高價值單一端點（密碼是攻擊集中點），fail-closed 比放任爆破更可接受；其他 API fail-open 可避免限流誤殺正常使用者。詳見 [ADR 011 §「Login limiter fail-closed 實作」](../adr/011-edge-security-hardening.md#login-limiter-fail-closed-實作)。

完整設計、演算法選擇詳見 [ADR 009 - Rate Limiting 實作層](../adr/009-rate-limiting-strategy.md)。

### 6.4 敏感資訊不外洩

- Log 中不得出現 `accessToken`、`refreshToken`、`sessionId`
- Error response 不得回傳 JWT 相關欄位
- Redis key 使用 `session:` 前綴，ACL 限制 BFF 只能存取此前綴

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
| Access token 過期，refresh 遇到網路錯誤 / 5xx | 釋放 lock，**保留 session**；下次請求可再嘗試一次 | 本次回傳 `503 { error: "upstream_unavailable" }`；下次請求視 refresh 結果 |
| Refresh 期間等待者偵測到 `absoluteExpiresAt` 越線 | 等待者 return null，不再 poll | `401 { error: "absolute_expired" }` |
| 後端 family 已被其他裝置 `revoke-all` 撤銷 | refresh 收到 401 `session_not_found` → 刪除 session，清除 Cookie | `401 { error: "session_terminated" }` |
| 登出時後端 `/auth/logout` 失敗（網路 / 401 / 5xx） | 忽略，繼續刪除 BFF session 和 Cookie；metric `auth.logout.upstream_failure` | `200 { }` |
| 後端回傳 envelope 解析失敗（缺 `success` 或 `data` 欄位） | 視為 5xx 走 upstream 錯誤路徑；告警 metric `auth.envelope.parse_error` | `502 { error: "upstream_contract_violation" }` |
| API Server 回傳 4xx（含 backend 標準 error envelope） | 原樣透傳（含 `request_id`） | 相同 status code + body |
| API Server 回傳 5xx | 原樣轉發；BFF 不加工 body | 相同 status code |
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
it('should NOT delete session when refresh returns 5xx / network error')   // 規格保證
it('should delete session when refresh returns 401 regardless of backend error code')

// lib/session/session.test.ts（waiter abs_exp 邊界）
it('should return null when waiter detects absoluteExpiresAt has passed mid-poll')   // §3.4 step 8 終止 A
it('should not request refresh when absoluteExpiresAt has already passed at entry')   // §3.4 step 4

// lib/session/session.test.ts（race / fixation）
it('should handle logout request that arrives while refresh mutex is held')         // race
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
it('should set Max-Age to min(SESSION_TTL_SECONDS, absoluteExpiresAt - now) / 1000')

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
it('should pass through backend 400 invalid input body (including details[]) to browser')
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
```

### Component 測試（React Testing Library）

```ts
// app/(auth)/login/page.test.tsx
it('should disable submit button while login is in progress')
it('should show error message on invalid credentials')
it('should show field-level errors from backend 400 invalid input details[]')   // 新增
it('should redirect to dashboard on successful login')
it('should redirect to original URL after login when redirect param exists')
```

### Idle timer 跨分頁同步測試（Vitest + jsdom）

```ts
// components/idle-timer.test.tsx
it('should broadcast activity event on mousemove (throttled to 1s)')
it('should reset local timer when receiving activity event from another tab')
it('should broadcast logout event with at + nonce on timer expiry')
it('should ignore logout broadcast whose at < currentSession.createdAt (stale, §5.6)')
it('should ignore logout broadcast whose nonce matches own emission (echo)')
it('should ignore login broadcast whose userId === current userId')
it('should navigate to /login?reason=idle_timeout when timer expires')
it('should navigate to /login when receiving fresh logout event from another tab')
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
- [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md) ⚠️ 取代後端 ADR 002
