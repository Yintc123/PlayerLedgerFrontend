# ADR 010 - 對齊後端 ADR 007：client_id、refresh 不重試、idle 與多分頁協調

## 狀態

已採用（對齊 [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md)，後端 ADR 002 已被取代）

## 背景

2026-06-28 後端發佈 ADR 007，將 JWT 設計從「單一 session + 7 天 refresh token」改為「family-based rotation + 多裝置 + replay detection」。重點變更：

| 項目 | 舊（後端 ADR 002） | 新（後端 ADR 007） |
|------|------------------|------------------|
| Access token TTL | 1 小時 | **15 分鐘**（純 stateless） |
| Refresh token TTL | 7 天（固定） | **滑動 1h + 絕對 `abs_exp`**（依 client policy） |
| Session 隔離 | 單一 session，新登入踢舊裝置 | **多 family**（每 login 一個 `fid`，多裝置互不影響） |
| Rotation | 每次 refresh 換新 | 同 + 舊 jti **再次出現即觸發 replay → family 廢** |
| Client 差異 | 全部統一 | **`client_id` 對應不同 refresh/abs TTL**（cms-web/public-web/ios-app） |
| Grace window | 無 | **10 秒**容忍網路重試 |
| 失敗處理 | 任意重試 | **禁止自動重試**，重試即誤觸 replay |

前端 BFF 必須對應調整以下決策。

## 評估與決策

### 決策 1：login 帶 `client_id`，由 BFF env var 注入

**理由：**
- 後端 ADR 007 要求 login request 必須帶 `client_id`，後端據此套對應 policy（refresh TTL、abs_exp）
- 同一 BFF 程式碼未來可能同時部署為 CMS 後台與公開 web 兩種 instance（不同 `client_id`）；硬編碼會綁死
- **不允許 Browser 在 request body 指定 `client_id`**：使用者可繞過 CMS 8 小時 abs_exp、套用較寬鬆的 ios-app policy

**做法：** 環境變數 `CLIENT_ID`（必填），在 `lib/auth/login.ts` 注入 BFF → 後端的 login request body，Browser 端對應的 `POST /api/login` request body 不接受此欄位。

### 決策 2：Refresh 失敗一律走 login，BFF 內最多一次重試（網路錯誤限定）

**理由：**
- 後端 replay detection 對「同一 refresh token 用兩次」極敏感，自動重試會把合法使用者打成攻擊者，整條 family 連帶被踢
- 但網路錯誤（fetch 失敗、5xx）不是「token 已被用過」訊號，session 仍可能有效；保留 session 讓下次請求自然重試一次（透過 mutex），比直接踢使用者更友善

**做法：**

```
持鎖者 refresh：
  ├─ 200 success     → 更新 session，回 token
  ├─ 401             → DEL session、清 cookie，前端走 login（無論 OpenAPI ErrorResponse.error 是 token_expired / absolute_expired / invalid_token / replay_detected / session_not_found）
  └─ 網路錯誤 / 5xx  → 僅 DEL lock，保留 session；下次請求若 token 仍即將過期，會再搶鎖嘗試一次
                       （但 BFF 本身不在迴圈內自動 retry——下次 retry 是來自下一個 user request）

等待者：
  └─ 只 polling 既有 session，不自己呼叫 refresh 端點
```

### 決策 3：BFF 預先檢查 `absoluteExpiresAt`，已過就直接刪 session

**理由：**
- 後端 ADR 007 的 refresh token JWT 內帶 `abs_exp`（claims line 104），`VerifyRefresh` 會回 `401 absolute_expired`（OpenAPI ErrorResponse.error 之一）
- BFF 若還呼叫 refresh，必然 401；既浪費網路也增加後端 audit log 雜訊
- 在 BFF 端即可判斷（session 內已存 `absoluteExpiresAt`）

**做法：** `getValidAccessToken` 在步驟 4 加判斷：若 `absoluteExpiresAt - now ≤ 0`，立即 DEL session、return null。

**`absoluteExpiresAt` 的來源：** 後端 `TokenPair` response 本身不含 `absolute_expires_in` 欄位，BFF 從 **refresh_token JWT claim 的 `abs_exp`** 取得（base64-decode payload，不驗簽——BFF 無 `JWT_REFRESH_SECRET`）。此值只作為 hint，安全把關仍在後端 `VerifyRefresh`。詳見 [spec 02 §11.1](../specs/02-auth-session.md#111-abs_exp-來源refresh-token-jwt-claim無須後端-openapi-變更)。

### 決策 4：CMS 15 分鐘 idle timer 在 Browser 端實作

**理由：**
- 後端 ADR 007 §「前端配合」明確規定：「監聽 mousemove / keydown / click 重置 idle timer，15 分鐘無互動 → 主動登出」
- 這是 UX 安全層（非安全邊界），互動事件只能在 Browser 偵測
- 後端的 refresh sliding 1h TTL 是另一層保證（連續 1 小時無 API 呼叫 → refresh JWT exp 自然失效）

**做法：** Browser 端 `IdleTimer` React provider，包在 CMS 區段 layout；事件去抖 1 秒，達 15 分鐘呼叫 `POST /api/logout` 後跳 `/login?reason=idle_timeout`。

### 決策 5：BFF 架構不需要 BroadcastChannel 協調 refresh，但需要協調 idle / logout

**理由：**
- 後端 ADR 007 §「前端配合」要求「同瀏覽器多分頁用 BroadcastChannel 或 `navigator.locks.request()` 協調 refresh」——這是針對「直接持有 JWT 的 SPA」場景
- 本專案 BFF 架構下，所有分頁的請求都對應同一個 `sid`，搶同一把 Redis `refresh_lock:<sid>`，BFF 端的 [ADR 004 Mutex](./004-token-refresh-mutex.md) 已自然涵蓋
- 但 idle 登出、登入狀態同步仍需 Browser 端協調，否則 A 分頁登出後 B 分頁仍以為自己有 session

**做法：**
- Refresh 協調：**不做**（BFF Redis Mutex 已涵蓋）
- Logout 廣播：`BroadcastChannel('auth')` 廣播 `{ type: 'logout' }`；所有分頁收到立即跳 login
- Login 完成：同上廣播 `{ type: 'login' }`，其他分頁可依需求重新請求資料

### 決策 6：前端不**持有** `fid` / `jti`

**理由：**
- 後端 family 識別碼（`fid`）與 token 識別碼（`jti`）是後端的 audit 概念；前端 log 僅持有 `userId` + `requestId` 即可，透過共同 `requestId` 與後端 audit log 串聯
- 減少 BFF 對後端內部資料結構的耦合，後端日後改 family 結構不影響前端

**做法：** Session 結構不存 `fid` / `jti`；log fields 不寫 `fid`、`jti`。

**範圍補述（重要區分）：** 本決策禁止的是「把 `fid` / `jti` 當作 BFF 自己的長期 state 來持有」，**不是**禁止讀 JWT claims。

- ❌ 不允許：把 `fid`、`jti` 寫進 `SessionData`、cookie、log fields 作為長期 state
- ❌ 不允許：依賴 `fid` 做 BFF 端的存取決策（屬於後端 family 邏輯）
- ✅ 允許：讀 refresh token JWT claim 取 `abs_exp` 來計算 session lifetime（決策 3）。`abs_exp` 是 timestamp 不是 audit ID，BFF 用完即丟（只存衍生的 `absoluteExpiresAt` ms timestamp）
- ✅ 允許：暫時持有從後端 `GET /auth/sessions` response 取得的 `fid`，作為 UI「登出此裝置」按鈕的 callback 參數立即回傳給後端（spec 02 §10）。不寫入 BFF session、不在 BFF log 累計

本補述對應 [spec 02 §11.1](../specs/02-auth-session.md#111-abs_exp-來源refresh-token-jwt-claim無須後端-openapi-變更)。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` | §1 加入後端 ADR 007 摘要；§2.2 SessionData 新增 `clientId`、`absoluteExpiresAt`；§3.1 login 流程加 `client_id`；§3.4 演算法加 `absoluteExpiresAt` 預檢、區分 401 vs 5xx；新增 §5.5 idle timer、§5.6 多分頁協調；§7 錯誤表更新；§8 API 契約更新；§9 測試清單更新 |
| `docs/specs/01-bff-architecture.md` | §2 Session Store 描述更新；§5 env vars 新增 `CLIENT_ID`、修改 `REFRESH_THRESHOLD_SECONDS` 預設與註解；§6.2 config 模組加入 `api.clientId`；§11.4 Task Definition env 加入 `CLIENT_ID` |
| `docs/specs/03-observability.md` | §2.5 auth 事件加入 `clientId` / `outcome` / `backendError`（對齊 OpenAPI ErrorResponse.error） / `replay_detected` / `idle_logout`；§3.3 metrics 加入 `auth.token.refresh.replay_detected`、`auth.session.idle_logout`；§3.4 alarms 加 replay 告警 |
| `docs/adr/005-proxy-header-forwarding.md` | `X-Request-Id` 大小寫修正為 `X-Request-ID`（對齊後端 `RequestIDHeader` 常數） |

## 對照後端 ADR 007 的責任分工

| 項目 | 後端負責 | 前端 BFF 負責 | Browser 負責 |
|------|---------|--------------|-------------|
| Access token 簽發 / 驗證 | ✅ | — | — |
| Family 狀態（Redis Lua CAS） | ✅ | — | — |
| Replay detection | ✅ | — | — |
| Grace window | ✅ | — | — |
| `client_id` policy | ✅（policy 表） | ✅（注入 `CLIENT_ID`） | — |
| Refresh token 儲存 | — | ✅（Redis session） | — |
| Refresh 並發收斂 | — | ✅（Redis Mutex） | — |
| 預檢 `absoluteExpiresAt` | — | ✅ | — |
| Refresh 失敗不重試 | — | ✅（policy） | — |
| 15 分鐘 idle 自動登出 | — | — | ✅ |
| 多分頁 logout 廣播 | — | — | ✅ |
| `X-Request-ID` 沿用 | ✅ | ✅ | （可選提供） |

## 參考

- [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md)
- [ADR 004 - Token Refresh 並發控制：Redis Mutex](./004-token-refresh-mutex.md)
- [ADR 008 - Token Refresh 等待者改用 bounded polling](./008-refresh-waiter-bounded-polling.md)
- [02-auth-session.md](../specs/02-auth-session.md)
- OAuth 2.0 Security Best Current Practice（draft-ietf-oauth-security-topics）
