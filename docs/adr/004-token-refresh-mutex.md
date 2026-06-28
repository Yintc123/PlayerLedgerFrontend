# ADR 004 - Token Refresh 並發控制：Redis Mutex

## 狀態

已採用（核心決策仍然有效）

> **修訂註記 1**：本 ADR 步驟 5 的等待者實作「`await sleep(100ms)` → 一次性檢查」已由 [ADR 008 - Token Refresh 等待者改用 bounded polling](./008-refresh-waiter-bounded-polling.md) 修訂為輪詢直到 session 更新、被刪除、或達 max wait timeout。
>
> **修訂註記 2（2026-06-28）**：後端 [ADR 007](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md) 引入 family-based rotation + replay detection 與 grace window（10 秒）。Redis Mutex 仍是 BFF 端正確的併發控制工具，但持鎖者的失敗處理改為「401 刪 session、網路錯誤 / 5xx 保留 session」，且**任何狀況下不得在 BFF 內自動重試 refresh**（避免誤觸 replay）。詳見 [ADR 010 - 對齊後端 ADR 007](./010-align-with-backend-adr007-jwt.md) 與 [02-auth-session.md §3.4](../specs/02-auth-session.md#34-token-refresh-流程靜默更新--mutex)。
>
> 本 ADR 的核心決策——「使用 Redis `SET NX EX` 作為分散式 mutex 解決 token refresh race condition」——以及 mutex 的 key 格式、TTL 安全網設計、為何用 Redis 而非 in-memory mutex 等內容,仍然成立。請以本 ADR 理解整體機制,以 ADR 008 理解 waiter 內部的等待策略，以 ADR 010 理解與後端 ADR 007 的對齊。

## 背景

BFF 在每次 API 請求前會檢查 access token 是否即將過期（距到期 < `REFRESH_THRESHOLD`，預設 5 分鐘）。
若即將過期，BFF 自動呼叫 Go API Server 的 `POST /auth/refresh` 換取新的 token pair。

當頁面同時發出多個 API 請求（例如一個 SSR 頁面打三支 API），且 access token 剛好落在 refresh 閾值內，
每個請求都會獨立偵測到「需要 refresh」，並拿**同一個 refresh token** 同時呼叫 API Server。

若 Go API Server 實作 **refresh token rotation**（每次 refresh 後舊 token 立即作廢，換發新 token），
第一個請求成功後，其餘請求的 refresh token 已失效，API Server 回傳 `401`。
BFF 收到 `401` 後刪除 Redis session，使用者被強制登出——但 token 根本沒有真正過期。

```
t=0ms  Request A、B、C 同時讀 session → access token 剩 4 分鐘 → 全部進入 refresh

t=50ms A → POST /auth/refresh { RT_old }  ─▶  API Server
       B → POST /auth/refresh { RT_old }  ─▶  API Server（同一個舊 token）
       C → POST /auth/refresh { RT_old }  ─▶  API Server（同一個舊 token）

t=80ms A ← 200 { AT_new, RT_new }   RT_old 作廢
       B ← 401                        RT_old 已被 A 消費
       C ← 401                        RT_old 已被 A 消費

t=90ms B → DEL session → 回傳 401 給瀏覽器  ← 使用者被登出
       C → DEL session → 回傳 401 給瀏覽器
```

此 bug 在開發環境幾乎不會出現（手動操作，一次一個請求），
但在生產環境只要一個頁面同時打兩支以上 API 就可能觸發。

## 評估

### 方案 X：加大 REFRESH_THRESHOLD

縮小「多個請求同時落在 refresh 區間」的機率（例如閾值從 5 分鐘縮短至 30 秒）。

**缺點：治標不治本。**
閾值再小，只要在同一毫秒有兩個請求同時進來，race condition 就存在。

### 方案 Y：要求 API Server 讓 refresh 端點冪等

API Server 收到同一個 refresh token 的重複請求，回傳相同結果而非 `401`。

**缺點：**
- 需要改後端，增加跨團隊協調成本
- 降低 refresh token rotation 的安全性（refresh token 不再是一次性憑證）

### 方案 Z（採用）：Redis Mutex（`SET NX EX`）

在執行 refresh 前，以 Redis 的原子操作 `SET NX EX` 搶佔一把分散式鎖。
同一時間只有搶到鎖的請求執行 refresh；其他請求等鎖釋放後重新讀 session，
直接取用已更新的 token，不再呼叫 refresh 端點。

**優點：**
- 不需要改後端
- 不影響 refresh token rotation 的安全性
- Redis 已是現有基礎設施，無額外依賴
- 對跨 ECS container 的並發同樣有效

## 決策

採用 **Redis Mutex**。

### Mutex 設計

```
Key:   refresh_lock:<sessionId>
Value: "1"
TTL:   REFRESH_LOCK_TTL_SECONDS（預設 10 秒）
```

TTL 是安全網：若持鎖者在 refresh 過程中 crash（容器被終止、OOM），
Redis key 在 10 秒後自動過期，下一個請求可重新搶鎖。
無 TTL 的鎖在 crash 情境下會永久卡死。

### getValidAccessToken 演算法

```
1. GET session:<sessionId>
   └─ 不存在 → return null

2. expiresAt - now > REFRESH_THRESHOLD？
   └─ 是 → return accessToken          ← 快速路徑，絕大多數請求走這裡

3. SET refresh_lock:<sessionId> "1" NX EX 10
   ├─ 成功（搶到鎖）→ 步驟 4
   └─ 失敗（別人持鎖）→ 步驟 5

4. 【持鎖者】呼叫 POST /auth/refresh { refreshToken }
   ├─ 成功 → SET session:<id>（更新 tokens），DEL lock，return 新 accessToken
   └─ 失敗 401 → DEL session，DEL lock，return null
      （finally 區塊保證 lock 一定被釋放，即使 refresh 拋出例外）

5. 【等待者】await sleep(100ms)
   → GET session:<sessionId>
   ├─ 存在 → return accessToken（持鎖者已更新）
   └─ 不存在 → return null（持鎖者 refresh 失敗，session 已刪）
```

### 為何等待者可以 await sleep 而不阻塞伺服器

Node.js 是單執行緒 + 非阻塞 I/O 模型。`await sleep(100ms)` 將函式暫停並把控制權還給 Event Loop，
執行緒在這 100ms 內可以繼續處理其他請求或 I/O 事件，不會卡住整個伺服器。

這與多執行緒語言（Java / Go）的 `Thread.sleep()` 本質不同——
那裡 sleep 是讓一條執行緒休眠，其他執行緒繼續跑；
Node.js 只有一條執行緒，`await` 是讓當前 async 函式暫停，Event Loop 繼續。

### 為何需要 Redis Mutex 而非 in-memory Mutex

ECS Fargate 可能同時運行多個 Next.js container，每個 container 有獨立的 Node.js 程序與記憶體空間。
In-memory mutex（如 JavaScript 的 `Map`）只在單一程序內有效，跨 container 看不到彼此的鎖狀態。
Redis 是各 container 的共享協調點，`SET NX EX` 的原子性在分散式環境下仍然成立。

```
Container 1                    Container 2
    │                               │
    ├─ SET refresh_lock NX ─▶ Redis ◀─ SET refresh_lock NX ─┤
    │  → OK（搶到）                  │  → nil（搶不到）
    │  → 執行 refresh               │  → sleep(100ms) → 重讀 session
```
