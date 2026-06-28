# ADR 009 - Rate Limiting 實作層：API Gateway + proxy.ts Redis-based 雙層

## 狀態

已採用（補充 spec 02 §6.3 中尚未決定的「在哪一層實作」）

> **修訂註記**：本 ADR §「Client IP 取得」與 §「失效模式」由 [ADR 011 - 邊緣安全強化](./011-edge-security-hardening.md) 修訂：
>
> - **Client IP 不可取 XFF 最左值**（browser 可偽造）；改取從右側跳過信賴 proxy 數的位置，本架構 `TRUSTED_PROXY_HOPS=2` 取 `xff[-2]`
> - **`POST /api/login` 失效模式改為 fail-closed**（其他端點仍 fail-open），避免 Redis 故障時帳號爆破無防護
>
> 本 ADR 採用 sliding window + Redis 雙層 defense-in-depth 的核心決策不變。

## 背景

spec 02 §6.3 列出了 rate limit 規則（login 10 次/min/IP、其他 API 100 次/min/session、logout 無限制），但實作層次寫的是「在 API Gateway 或 `proxy.ts` 層實作」——兩個選項並列,沒有結論。

實際上兩種方案各有所長,且彼此互補。本 ADR 確定雙層 defense-in-depth 設計。

## 各方案能力對比

| 維度 | API Gateway Throttling | proxy.ts + Redis |
|------|----------------------|------------------|
| 計費 / 流量單位 | 帳號層級 / route 層級 | 任意維度（IP、session、user）|
| 精細度 | 粗（per route 全域 QPS） | 細（per IP、per session）|
| 響應速度 | 在請求進入 Lambda / ECS 前就擋掉 | 進入 BFF container 後才擋 |
| 一致性（跨 container） | 天然 | 需 Redis 統籌 |
| 程式碼可控性 | 低（AWS console / Terraform）| 高（純程式碼，可單元測試）|
| 變更成本 | 改基礎設施 | 改一行 |
| 對攻擊面的縮減 | 高（拒絕在邊緣） | 中（仍進入 BFF）|
| 對使用者的訊息 | 標準 429,訊息不可客製 | 可附 `Retry-After`、繁中錯誤訊息 |

**結論：兩者解決的問題不同,不是「二選一」。**

## 評估的三種策略

### 方案 A：只用 API Gateway

優點：純基礎設施,無程式碼負擔
缺點：
- 無法做 per-session / per-user 限流（API Gateway 不認識 session）
- 訊息與行為不可客製,使用者體驗差
- 對 BFF 內部邏輯（refresh、複雜路由）無能為力

### 方案 B：只用 proxy.ts + Redis

優點：邏輯集中,可測試,精細控制
缺點：
- 大量惡意流量仍會進入 BFF container（Redis INCR + DEL 是有成本的）
- 沒有「邊界拒絕」能力,DoS 攻擊放大效應大
- 單一防線,proxy.ts bug 直接破功

### 方案 C（採用）：雙層 defense-in-depth

```
攻擊流量
   │
   ▼
[ API Gateway Throttling ]  ← 粗糙、邊緣防護、抗 DoS
   │   QPS 上限、burst 上限
   ▼
[ proxy.ts + Redis Limiter ]  ← 精細、per-session/IP、業務邏輯
   │   per route + per identity 計數
   ▼
正常請求
```

兩層擋掉的攻擊類型不同,且彼此互補：
- API Gateway 在請求進入 ECS 前就拒絕,**保護 BFF 不被打爆**
- proxy.ts Redis-based 提供**業務邏輯需要的精細控制**(login 防爆破、API 防濫用)

## 決策

### Layer 1: API Gateway HTTP API Throttling

| 設定 | 值 | 理由 |
|------|-----|------|
| Account-level burst | 5000 | AWS 預設,容許短期高峰 |
| Account-level steady | 10000 req/s | 高於可能合法峰值 |
| Per-route `/api/login` | 50 req/s | 防全球範圍登入爆破 |
| Per-route `/api/[...]` | 1000 req/s | 一般 API 上限 |

設定位置：Terraform / CloudFormation,與 API Gateway 同檔。

### Layer 2: proxy.ts + Redis Limiter

採用 sliding window counter,實作要點：

```ts
// lib/rate-limit/limiter.ts
async function checkLimit(key: string, limit: number, windowSeconds: number): Promise<{
  allowed: boolean
  remaining: number
  resetAt: number
}> {
  const now = Date.now()
  const windowStart = now - windowSeconds * 1000
  const redisKey = `ratelimit:${key}`

  // Sliding window: 用 sorted set 存每次請求時間戳
  // member 名稱用 now + hrtime 確保同毫秒內不衝突，避免 UUID 在 hot path 的多餘成本
  const member = `${now}:${process.hrtime.bigint()}`
  const pipe = redis.pipeline()
  pipe.zremrangebyscore(redisKey, 0, windowStart)  // 清掉舊紀錄
  pipe.zadd(redisKey, now, member)                  // 加當前
  pipe.zcard(redisKey)                              // 算總數
  pipe.expire(redisKey, windowSeconds)              // 重置 TTL
  const results = await pipe.exec()

  const count = results![2][1] as number
  return {
    allowed:   count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt:   now + windowSeconds * 1000,
  }
}
```

### 限流規則（與 spec 02 §6.3 對齊）

| 端點 | Key | 限制 | 視窗 | 429 回應 |
|------|-----|------|------|---------|
| `POST /api/login` | `login:<client_ip>` | 10 次 | 60 秒 | `{ error: "rate_limit_exceeded", retryAfter: <s> }` + `Retry-After: <s>` |
| `POST /api/logout` | — | 無限制 | — | — |
| 其他 `/api/*` | `api:<sid>` | 100 次 | 60 秒 | 同上 |

無 session 時,fallback 用 IP 作 key（避免登入前完全無防護）。

### Client IP 取得

⚠️ **本節的原描述已被 [ADR 011](./011-edge-security-hardening.md) 修訂。** 取 `xff[0]`（最左值）在 CloudFront + API Gateway append 模式下是 **browser 可偽造的值**，會被攻擊者繞過 per-IP login 爆破限流。

實作改為從 XFF 右側跳過信賴 proxy 數（`TRUSTED_PROXY_HOPS=2`，對應 CloudFront + API Gateway 兩跳）後取真實 client IP。完整實作與 CD 驗證方式詳見 [ADR 011 §「Client IP 提取」](./011-edge-security-hardening.md#client-ip-提取)。

## 為何採 sliding window 而非 fixed window 或 token bucket

| 演算法 | 優點 | 缺點 |
|--------|------|------|
| Fixed window | 實作簡單 | 視窗交界處可能 2 倍突發（59 秒打 100 次 + 60 秒再打 100 次）|
| Token bucket | 平滑限流 | Redis 上實作較複雜（需算 token 補充） |
| **Sliding window** | 平滑、實作合理 | Redis sorted set 每次操作 O(log N),但 N ≤ limit,可忽略 |

選 sliding window：精確度足以滿足規格,實作只用 4 個 Redis 操作（pipeline 一次往返）,複雜度低。

## 失效模式

⚠️ **本節已由 [ADR 011](./011-edge-security-hardening.md) 修訂**：`POST /api/login` 改為 fail-closed，其他端點維持 fail-open。

| 情境 | 端點 | 行為 |
|------|------|------|
| Redis 連線失敗 | `POST /api/login` | **fail-closed**（回 503）。理由：login 是高價值單一端點，Redis 掛就放行 = 帳號爆破無防護 |
| Redis 連線失敗 | 其他 `/api/*` | **fail-open**（記 log + metric，允許請求通過）。限流是第二層防線，API Gateway 仍提供粗糙保護；fail-closed 會誤殺所有正常使用者 |
| Redis 速度異常（> 100ms） | 全部 | 同對應端點策略，加 metric 警示 |
| Lock contention | — | sliding window 不需要 lock，無此問題 |

完整實作（含 metric / alarm）詳見 [ADR 011 §「Login limiter fail-closed 實作」](./011-edge-security-hardening.md#login-limiter-fail-closed-實作)。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` §6.3 | 從「在 API Gateway 或 proxy.ts 層實作」改為明確指向本 ADR,並補充失效模式 |
| `proxy.ts` | 加入 rate limit check（在 session 驗證後） |
| `lib/rate-limit/limiter.ts` | 新增 sliding window limiter 實作 |
| Terraform / IaC | API Gateway throttling 設定 |

## 參考

- [Cloudflare: Sliding Window Rate Limiting](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- [AWS API Gateway throttling docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
- OWASP API Security Top 10: API4:2023 Unrestricted Resource Consumption
