# ADR 011 - 邊緣安全強化：信賴 XFF 來源與 Login Limiter 失效策略

## 狀態

已採用（補充 [ADR 009 - Rate Limiting](./009-rate-limiting-strategy.md) 兩處遺留決策：Client IP 取得方式、Redis 故障時 login 端點的失效模式。ADR 009 採用 sliding window + Redis 的核心決策不變）

## 背景

ADR 009 在實作 rate limit 時遺留兩個未充分審視的安全決策：

1. **Client IP 取自 `xff.split(',')[0]`（最左值）**：在 BFF 前面有多層 proxy（CloudFront → API Gateway → ECS）的架構下，這個值不可信。CloudFront 與 API Gateway 預設都是「append」而非「override」XFF，最左邊永遠是 browser 提供的版本——攻擊者可自塞 `X-Forwarded-For: 1.2.3.4` 繞過 per-IP login 爆破限流。

2. **所有 limiter 統一 fail open**：Redis 連線失敗時放行請求。對一般 API 是合理（避免限流誤殺正常使用者），但 `POST /api/login` fail open 等於 Redis 一掛就無限暴力破解——這是高價值端點不能接受的退化。

## 評估

### 決策 1：Client IP 從 XFF 右側信賴跳數提取

XFF 在 append 模式下從左到右是「越早經過 → 越不可信」。本架構固定為 CloudFront + API Gateway 兩層 proxy，可信的真實 client IP 位於倒數第 2 個位置：

```
browser 偽造或無 →  CF append browser IP  →  APIGW append CF edge IP
       │                      │                       │
   [fake]            [fake, real-browser]   [fake, real-browser, cf-edge]
                                                       ▲
                                              ECS 收到的 XFF
```

- `ips[len-1]` = CF edge IP（per-IP 限流會把所有同 edge 的使用者算成同一人，失去意義）
- `ips[len-2]` = **真實 browser IP**（CF 寫入時 browser 已無法竄改後面的值）
- `ips[0]` = browser 自填欄位（不可信）

| 方案 | 缺點 |
|------|------|
| `xff[0]` | browser 可偽造，**不採用** |
| `xff[-1]` | 是 CF edge IP，per-IP 限流失準 |
| **`xff[-2]`（採用）** | 跳過 APIGW 的 CF edge 紀錄，取 CF 看到的真實 browser IP |
| `CloudFront-Viewer-Address` | 語意最明確，但需 CF origin request policy 額外設定才傳到 origin，與本專案「基礎設施簡單」原則衝突 |

### 決策 2：Login limiter Redis 故障時 fail-closed

| 端點 | Redis 故障時 | 理由 |
|------|-------------|------|
| `POST /api/login` | **fail-closed**（503） | Redis 一掛即放行 = 帳號爆破無防護；登入短暫不可用優於密碼被爆破 |
| `POST /api/logout` | 無限流 | 不適用 |
| 其他 `/api/*` | **fail-open**（放行 + log + metric） | 限流是第二層防線，API Gateway 已提供粗糙保護；fail-closed 會誤殺所有正常使用者 |

兩種策略並存的合理性：login 是攻擊面集中（密碼是最值錢的單一憑證），其他 API 攻擊面分散（每個 endpoint 影響不同）。對單一高價值端點 fail-closed，整體系統不致全面 503。

## 決策

### Client IP 提取

```ts
// lib/rate-limit/client-ip.ts
const TRUSTED_PROXY_HOPS = 2  // CloudFront + API Gateway

export function getClientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for')
  if (!xff) return 'unknown'

  const ips = xff.split(',').map((s) => s.trim()).filter(Boolean)
  // 從右側跳過信賴 proxy 數，取真實 client IP
  // 例：[fake, real-browser, cf-edge]，TRUSTED_PROXY_HOPS=2 → 取 index -2 = real-browser
  const index = ips.length - TRUSTED_PROXY_HOPS
  if (index < 0) return 'unknown'  // XFF 不夠長代表請求未經完整 proxy 鏈，視為不可信
  return ips[index]
}
```

`TRUSTED_PROXY_HOPS` 寫死於程式碼，與架構強耦合——若改用 ALB 取代 API Gateway（單層 proxy），需同步調整為 1。**禁止做成 env var**：誤設會造成靜默的安全降級。

> **CD 驗證**：smoke test 階段應發一個 `X-Forwarded-For: 1.2.3.4` 偽造請求，驗證 BFF log 中的 `clientIp` 不等於 `1.2.3.4`。若等於，代表 proxy 鏈跳數與假設不符，必須調整 `TRUSTED_PROXY_HOPS`。

### Login limiter fail-closed 實作

```ts
// proxy.ts 或 /api/login/route.ts
try {
  const result = await checkLimit(`login:${ip}`, 10, 60)
  if (!result.allowed) return tooManyRequests(result)
} catch (err) {
  if (request.nextUrl.pathname === '/api/login') {
    logger.error({ err, type: 'ratelimit.fail_closed' }, 'login limiter failed; refusing request')
    metric('ratelimit.fail_closed', 1, 'Count', { route: '/api/login' })
    return new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503 })
  }
  // 其他端點 fail-open
  logger.warn({ err, type: 'ratelimit.fail_open' }, 'limiter failed; allowing request')
  metric('ratelimit.fail_open', 1, 'Count', { route })
}
```

### Alarm 補強

| Alarm | 閾值 | 嚴重度 |
|---|---|---|
| `ratelimit.fail_closed > 0 in 1 minute` | 任意觸發 | 紅色（login 完全不可用） |
| `ratelimit.fail_open > 10 in 5 minutes` | 累計 | 黃色（Redis 異常但仍放行） |

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/adr/009-rate-limiting-strategy.md` | §「Client IP 取得」與「失效模式」加修訂註記指向本 ADR |
| `docs/specs/02-auth-session.md` §6.3 | 失效模式表新增 login fail-closed |
| `docs/specs/03-observability.md` §3.3 / §3.4 | 新增 `ratelimit.fail_closed` 與 `ratelimit.fail_open` metric 與對應 alarm |
| `proxy.ts` / `lib/rate-limit/` | 實作端對應修改 |

## 參考

- [CloudFront 與 origin 之間的 X-Forwarded-For 行為](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-http-headers.html#header-meaning)
- [OWASP - Securing reverse proxy headers](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
