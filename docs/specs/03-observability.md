# Observability 規格書

## 1. 概覽

可觀測性以三個維度組成：

| 維度 | 工具 | 目的 |
|------|------|------|
| **Logs**(結構化日誌) | `pino` + CloudWatch Logs | 記錄每個請求、auth 事件、錯誤 |
| **Metrics**(數值指標) | CloudWatch Embedded Metric Format(EMF) | QPS、latency、錯誤率、業務指標 |
| **Traces**(分散式追蹤) | OpenTelemetry + AWS X-Ray exporter | 跨 BFF / API Server / Redis 的請求鏈路 |

三者透過共同的 `X-Request-ID` 串聯,任何一筆觀測資料都可從另兩個維度跳轉到對應上下文。

---

## 2. 結構化日誌

### 2.1 工具選型

採用 **[pino](https://github.com/pinojs/pino)**,理由：

| 比較項 | pino | winston | bunyan |
|--------|------|---------|--------|
| 效能(ops/sec) | 最快(~50k) | 慢(~5k) | 中等(~15k) |
| 設計理念 | JSON-first、零格式化 | 多 transport、字串模板 | JSON、但維護鬆散 |
| Next.js 整合 | 官方 example | 需 wrapper | 需 wrapper |
| 維護狀態 | 活躍 | 活躍 | 停滯 |

效能在 BFF 這層很關鍵——log 每個請求,慢的 log 會直接拖慢 P99 延遲。pino 是 Node.js 生態事實上的標準。

### 2.2 Log 等級規範

| Level | 數值 | 使用情境 |
|-------|------|---------|
| `fatal` | 60 | 程序即將終止(例如 Redis 永久失敗) |
| `error` | 50 | 應該被人類調查的錯誤(API 5xx 連續、未預期 exception、**refresh 收到 401 連動踢人**) |
| `warn` | 40 | 不正常但可接受(refresh 競爭、rate limit hit、後端 5xx 偶發) |
| `info` | 30 | 正常業務事件(login 成功、logout、token refresh) |
| `debug` | 20 | 開發排查用(僅 `NODE_ENV !== 'production'`) |
| `trace` | 10 | 極詳細追蹤(預設關閉,需透過 env var 開啟) |

**production 預設 level = `info`**,以 `LOG_LEVEL` env var 覆寫。

### 2.3 必含欄位

每筆 log 都必須含（欄位命名遵循 [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/general/logs/) 的 resource attributes）：

```json
{
  "level": "info",
  "time": "2026-06-28T01:23:45.678Z",
  "pid": 1,
  "hostname": "ip-10-0-1-23",
  "service.name": "playerledger-frontend",
  "service.version": "abc1234-20260628120000",
  "service.namespace": "playerledger",
  "deployment.environment": "production",
  "cloud.region": "ap-northeast-1",
  "cloud.availability_zone": "ap-northeast-1a",
  "aws.ecs.task.arn": "arn:aws:ecs:ap-northeast-1:123:task/cluster/abc",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "msg": "..."
}
```

| 欄位 | 來源 | 用途 |
|------|------|------|
| `requestId` | `getRequestId()` 從 `X-Request-ID` 取得 | **跨服務串聯**——後端 log、X-Ray trace、CloudWatch metric 都帶同一個 ID。Header 大小寫須與後端 `pkg/logger/requestid.go` 的 `RequestIDHeader = "X-Request-ID"` 一致；驗證規則（非空、≤ 128、僅 `0x21–0x7E`）也須對齊，不合法時靜默產生新 UUID（見 [02-auth-session.md §5](./02-auth-session.md#request-id-傳播)） |
| `traceId` / `spanId` | pino mixin 從 `trace.getActiveSpan()` 抽（見 §4.5） | **W3C trace 串接**——X-Ray console 可從 trace 直接跳到 CloudWatch Logs Insights |
| `service.name` | 固定值 | CloudWatch Logs Insights 過濾，對齊 OTel `service.name` resource attribute |
| `service.version` | build 時注入(`APP_VERSION` image tag) | 知道 log 來自哪版程式；事故時對應 commit |
| `service.namespace` | 固定值 `playerledger` | 多服務時依 namespace 分組 |
| `deployment.environment` | `NODE_ENV` / `DEPLOY_ENV` | 區分 staging / production |
| `cloud.region` / `cloud.availability_zone` | ECS Metadata endpoint（task metadata v4） | 多 AZ 故障分析 |
| `aws.ecs.task.arn` | ECS Metadata endpoint | 對應具體 ECS task instance，跨 task 比對行為差異 |

> **取得 ECS metadata**：runtime 從 `process.env.ECS_CONTAINER_METADATA_URI_V4` 取，啟動時抓一次快取為 base fields，不要每筆 log 重打。fetch 失敗（本機開發）以空字串落地，不可導致 logger 初始化失敗。

### 2.4 HTTP 請求 / 回應 log

每個 HTTP 請求進出 BFF 都要 log,但**禁止 log 敏感欄位**：

```json
{
  "level": 30,
  "time": "...",
  "requestId": "...",
  "type": "http.request",
  "method": "POST",
  "path": "/api/players/123/topup",
  "query": "",
  "userAgent": "Mozilla/5.0 ...",
  "clientIp": "203.0.113.1",
  "userId": "user-abc"
}

{
  "level": 30,
  "time": "...",
  "requestId": "...",
  "type": "http.response",
  "status": 200,
  "durationMs": 87,
  "responseSize": 1245
}
```

**禁止欄位（即使有也不能 log）：**

| 欄位 | 為何禁止 |
|------|---------|
| `accessToken` / `refreshToken` / JWT | 一旦進入 CloudWatch 即使被刪也可能已被 indexed,風險不可逆 |
| `sessionId`(`sid`) | 可用於冒充使用者 |
| `password` | 顯而易見 |
| `email` | 個資,僅在必要時 hash 後 log |
| `Cookie` / `Set-Cookie` 完整內容 | 內含 sid |
| Request body / Response body 全文 | 可能含密碼、token、PII;只 log size |

實作要點：所有 sensitive key 集中在 `lib/logger/redact-paths.ts`,以 pino 的 `redact` 選項自動處理：

```ts
// lib/logger/redact-paths.ts
export const REDACT_PATHS = [
  // Token 類欄位（任何深度）
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.id_token',
  '*.access_token',
  '*.refresh_token',
  '*.token',
  '*.jwt',
  '*.apiKey',
  '*.api_key',

  // Session / 密碼類
  '*.sid',
  '*.sessionId',
  '*.password',
  '*.passwd',
  '*.secret',

  // 個資（必要時改 hash，預設整段擋掉）
  '*.email',
  '*.phone',
  '*.ssn',

  // Request / Response headers
  'headers.cookie',
  'headers["set-cookie"]',
  'headers.authorization',
  'headers["proxy-authorization"]',
  'headers["x-csrf-token"]',
  'headers["x-api-key"]',
  // 大小寫變體：pino redact 不會自動 case-insensitive
  'headers.Cookie',
  'headers.Authorization',

  // Request body / query 全文預設不 log（只記 size）；萬一有人錯誤地把整段 body 塞進 log，這幾條再擋一層
  '*.body.password',
  '*.body.email',
  '*.requestBody',
]
```

> **特別注意 query string 與 OAuth callback**：登入回呼類路徑可能在 query 中夾帶 token（`?code=...&state=...`、`?access_token=...`），spec 02 §4 路由保護應在記 log 前以 `URL.searchParams` 列入 `sensitiveQueryKeys` 並換成 `[REDACTED]`，不能依賴 pino redact paths（query 是 string，path-based redact 抓不到）。`http.request` log 的 `query` 欄位必須是過濾後版本。

### 2.5 認證事件 log

login / logout / refresh / proxy redirect 都要 log,但**只 log 結果與識別碼,不 log token**：

```json
{ "level": 30, "type": "auth.login.success",  "userId": "u-1", "clientId": "cms-web", "absoluteExpiresAt": 1719572625000, "clientIp": "..." }
{ "level": 40, "type": "auth.login.failure",  "reason": "invalid_credentials", "email_hash": "...", "clientId": "cms-web" }
{ "level": 30, "type": "auth.logout",          "userId": "u-1" }
{ "level": 30, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": true,  "latencyMs": 84, "outcome": "rotated" }
{ "level": 30, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": false, "waitMs": 240, "outcome": "waited" }
{ "level": 50, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": true,  "failed": true, "outcome": "expired",          "backendError": "token_expired" }
{ "level": 50, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": true,  "failed": true, "outcome": "absolute_expired",  "backendError": "absolute_expired" }
{ "level": 50, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": true,  "failed": true, "outcome": "replay_detected",   "backendError": "replay_detected" }
{ "level": 40, "type": "auth.token.refresh",   "userId": "u-1", "isHolder": true,  "failed": true, "outcome": "network_error",   "errorClass": "FetchError" }
{ "level": 30, "type": "auth.session.idle_logout", "userId": "u-1", "idleMs": 900000 }

// proxy.ts 路由保護事件（高頻 debug 需求：「為何使用者一直被踢回 login」）
{ "level": 30, "type": "auth.proxy.redirect",     "reason": "no_sid",          "path": "/players" }
{ "level": 30, "type": "auth.proxy.redirect",     "reason": "invalid_session", "path": "/players" }
{ "level": 40, "type": "auth.proxy.csrf_blocked", "method": "POST", "path": "/api/login", "origin": "https://attacker.example" }
```

**欄位說明：**

| 欄位 | 來源 | 用途 |
|------|------|------|
| `clientId` | session.clientId | 區分 cms-web / public-web / mobile，後端 ADR 007 client policy 分流 |
| `absoluteExpiresAt` | session.absoluteExpiresAt | family 絕對上限，便於追溯使用者實際 session 壽命 |
| `outcome` | `rotated` / `waited` / `expired` / `absolute_expired` / `replay_detected` / `network_error` | refresh 結果分類，**「replay_detected」是高優先告警事件，可能代表後端 family 已被廢、合法者連帶被踢** |
| `backendError` | 後端 OpenAPI `ErrorResponse.error` 值（`token_expired` / `absolute_expired` / `invalid_token` / `replay_detected` / `session_not_found` 等 snake_case code） | 對應後端 audit log 的事件，便於跨服務串接 |
| `idleMs` | 前端 idle timer 觸發時的累計閒置毫秒 | 確認 CMS 15 分鐘閒置登出行為 |

> **特別關注 `replay_detected`：** 此事件應觸發告警（CloudWatch alarm + 累計 metrics）。後端 ADR 007 將 replay 視為「攻擊或合法者搶 rotation」混合訊號，短期內同一 `userId` 多次 replay 強烈暗示帳號被盯上。

> **不在前端 log 寫 `fid` / `jti`：** 這些是後端 family 識別碼，前端不應持有；用 `userId` + `requestId` 已足夠透過後端 audit log 反查（同 `requestId` 同時出現在 BFF 與後端）。

`email_hash` 是 email 的 SHA-256 前 8 byte hex,用於相關性分析(同一 email 多次失敗 → 暴力破解)而不洩漏實際 email。

### 2.6 Pino 設定

```ts
// lib/logger/logger.ts
import pino from 'pino'
import { REDACT_PATHS } from './redact-paths'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'playerledger-frontend',
    env:     process.env.NODE_ENV,
    version: process.env.APP_VERSION,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact:    { paths: REDACT_PATHS, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),  // 改用 string 而非數字,Logs Insights 更直觀
  },
})

// 取得 per-request logger（自動帶 requestId）
export function getRequestLogger(requestId: string) {
  return logger.child({ requestId })
}
```

### 2.7 與 ECS / CloudWatch 整合

ECS Task Definition 用 `awslogs` driver(spec 01 §11.4 已設定),pino 寫到 stdout/stderr 即自動進 CloudWatch Logs。**不在 BFF 內呼叫 CloudWatch SDK**——避免額外 SDK 依賴,且 stdout 失敗的可能性遠低於 SDK 呼叫失敗。

CloudWatch Log Group：`/ecs/playerledger-frontend`
保留期：staging 7 天,production 30 天(成本與除錯需求平衡)

### 2.8 CloudWatch Logs Insights 範例查詢

排查特定 requestId 跨 BFF + 後端的所有 log：

```
fields @timestamp, level, type, msg
| filter requestId = '550e8400-e29b-41d4-a716-446655440000'
| sort @timestamp asc
```

過去 1 小時所有 5xx：

```
fields @timestamp, requestId, method, path, status, durationMs
| filter type = 'http.response' and status >= 500
| sort @timestamp desc
| limit 100
```

login 失敗熱點 IP：

```
fields clientIp, count(*) as fails
| filter type = 'auth.login.failure'
| stats count(*) as fails by clientIp
| sort fails desc
| limit 20
```

---

## 3. Metrics

### 3.1 工具選型：CloudWatch Embedded Metric Format(EMF)

EMF 讓你在 log 中以特殊格式宣告 metric,CloudWatch 自動抽出成數值指標,無需呼叫 PutMetricData API。

**優點：**
- 沒有額外 API call,寫到 stdout 即可
- 同一筆 log 同時是 metric 與 trace context（共享 requestId）
- 比起手動呼叫 SDK 少很多失敗模式

**替代方案的問題：**

| 方案 | 問題 |
|------|------|
| CloudWatch SDK `PutMetricData` | 額外網路呼叫,失敗會影響業務;rate limit 30TPS/region |
| Prometheus scraping | 需自己跑 Prometheus,ECS Fargate 整合複雜 |
| Datadog / New Relic | 額外成本,本專案規模不需要 |

### 3.2 EMF 函式

EMF 規範要求 `Dimensions` 是「dimension set 的陣列」，每個 dimension set 必須是**非空**字串陣列；空陣列會被 CloudWatch 靜默丟棄整筆 metric。實作上需特判 `dimensions` 為空的情境：

```ts
// lib/logger/metrics.ts
import { logger } from './logger'

type MetricUnit = 'Count' | 'Milliseconds' | 'Bytes' | 'Percent' | 'None'

export function metric(
  name: string,
  value: number,
  unit: MetricUnit = 'Count',
  dimensions: Record<string, string> = {},
) {
  const dimensionKeys = Object.keys(dimensions)
  // EMF 規範：Dimensions 是陣列的陣列，每個內層陣列必須非空。
  // 無 dimension 時整個 Dimensions 給 [] 而非 [[]]，CloudWatch 才會記為「無維度的全域 metric」
  const dimensionSets = dimensionKeys.length > 0 ? [dimensionKeys] : []

  logger.info({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'PlayerLedger/Frontend',
        Dimensions: dimensionSets,
        Metrics: [{ Name: name, Unit: unit }],
      }],
    },
    [name]: value,
    ...dimensions,
  }, 'metric')
}
```

**為何要特判：** 原本 `[Object.keys(dimensions)]` 在 `dimensions = {}` 時會產出 `Dimensions: [[]]`（含一個空陣列的陣列），CloudWatch 視為 schema 錯誤丟棄整筆。`metric('event.loop.lag', 12)` 這種無維度的全域指標必須能正常 emit。對應測試見 §6。

### 3.3 必發布的 metrics

| Metric | Unit | Dimensions | 用途 |
|--------|------|-----------|------|
| `http.request.count` | Count | `path`, `method`, `status_class`(2xx/4xx/5xx) | QPS、錯誤率 |
| `http.request.duration` | Milliseconds | `path`, `method` | 延遲 P50 / P95 / P99 |
| `auth.login.attempts` | Count | `result`(success/failure), `client_id` | 登入成功率、爆破偵測 |
| `auth.token.refresh.count` | Count | `outcome`(rotated/waited/expired/absolute_expired/replay_detected/network_error), `role`(holder/waiter) | refresh 健康度、mutex 競爭程度 |
| `auth.token.refresh.duration` | Milliseconds | `role` | refresh 延遲分布 |
| `auth.token.refresh.replay_detected` | Count | `client_id` | **高優先告警**：family 連帶廢棄事件，疑似攻擊或多分頁/裝置搶 rotation |
| `auth.session.idle_logout` | Count | — | CMS 15 分鐘閒置自動登出次數 |
| `ratelimit.hit` | Count | `route`, `reason`(ip/session) | 限流觸發頻率 |
| `ratelimit.fail_closed` | Count | `route` | **高優先**：Redis 故障時 login 被拒絕，service degraded（ADR 011） |
| `ratelimit.fail_open` | Count | `route` | Redis 故障時非 login 端點放行,需追蹤累積影響 |
| `auth.proxy.csrf_blocked` | Count | `method`, `path` | CSRF Origin check 擋下的請求，異常飆高可能代表攻擊（ADR 013） |
| `health.shallow.failure` | Count | — | `/api/health` 失敗（Redis 真的掛了，ECS 將替換 task）|
| `health.deep.failure` | Count | — | `/api/health/deep` 失敗（多半是上游 API 異常，**不替換 task**，搭配 `api_server.call.error` 追蹤）|
| `redis.operation.duration` | Milliseconds | `operation`(get/set/del/incr) | Redis 延遲監控 |
| `redis.operation.error` | Count | `operation` | Redis 錯誤率 |
| `redis.command.high_latency` | Count | `operation` | **ADR 009 失效模式對應**：單次 Redis 指令 > 100ms 計次，協助識別「Redis 沒掛但變慢」（fail-open 區間） |
| `ratelimit.retry_after_seconds` | Milliseconds | `route`, `layer`(edge/bff) | 429 回應 `Retry-After` 分布，識別 edge 層（API Gateway）vs bff 層的限流佔比 |
| `api_server.call.duration` | Milliseconds | `endpoint` | 上游 API 延遲 |
| `api_server.call.error` | Count | `endpoint`, `status_class` | 上游 API 錯誤率 |

**USE（Utilization / Saturation / Errors）資源指標** —— Node BFF 常見的 saturation 訊號，由 `instrumentation.ts` 內每 30 秒採樣一次發出：

| Metric | Unit | 來源 | 用途 |
|--------|------|------|------|
| `nodejs.eventloop.lag.p95` | Milliseconds | [`monitorEventLoopDelay`](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions) | event loop 阻塞時長；> 100ms 表示 CPU 飽和或 sync IO 阻塞 |
| `nodejs.memory.heap_used` | Bytes | `process.memoryUsage().heapUsed` | heap 使用量；接近 `NODE_OPTIONS --max-old-space-size` 表示記憶體壓力 |
| `nodejs.memory.rss` | Bytes | `process.memoryUsage().rss` | RSS；接近 ECS task memory limit 會被 OOMKilled |
| `nodejs.gc.duration` | Milliseconds | `perf_hooks` GC observer | GC pause 時長；P99 > 100ms 影響延遲 |
| `nodejs.fetch.socket.in_use` | Count | undici agent stats | keep-alive socket 池使用量；持續接近 pool size 表示 HTTP 池飽和 |
| `redis.pool.connections.active` | Count | ioredis `client.status === 'ready'` 計數 | Redis 連線池活躍數；連線池飽和會排隊 |

### 3.4 必設的 CloudWatch Alarms

```hcl
# Production
http.request.count where status_class = "5xx" > 10 in 5 minutes → 紅色警報
http.request.duration P99 > 3000ms for 5 minutes → 黃色警報
auth.login.attempts where result = "failure" > 100 in 1 minute → 紅色警報(疑似爆破)
auth.token.refresh.replay_detected > 0 in 5 minutes → 紅色警報（同 userId 多次更要立刻看，可能是攻擊或多裝置/分頁未正確協調）
auth.token.refresh.count where outcome = "absolute_expired" / total ratio > 5% in 15 minutes → 黃色警報（abs_exp 政策是否過短）
auth.proxy.csrf_blocked > 50 in 5 minutes → 黃色警報（CSRF 嘗試異常飆高，可能正在被掃描）
ratelimit.fail_closed > 0 in 1 minute → 紅色警報（login 端點完全不可用，ADR 011）
ratelimit.fail_open > 10 in 5 minutes → 黃色警報（Redis 異常但仍放行，service degraded）
health.shallow.failure > 0 in 1 minute → 紅色警報（Redis 不可達，task 將被替換，需確認是否大量同時發生）
redis.operation.error rate > 1% in 5 minutes → 紅色警報
api_server.call.error where status_class = "5xx" > 5% in 5 minutes → 紅色警報

# Staging：閾值放寬,警報降級為通知
```

> **注意**：`health.deep.failure` **不設 alarm**——它反映的就是上游 API 狀態，由 `api_server.call.error` 與後端自己的 alarm 處理；deep failure 只用於 dashboard 查看與 CD smoke test gate。

警報路由：SNS topic → PagerDuty / Slack / Email

---

## 4. Distributed Tracing

### 4.1 工具選型

採用 **OpenTelemetry + AWS X-Ray exporter**：

| 比較 | OpenTelemetry | AWS X-Ray SDK 原生 |
|------|--------------|-------------------|
| 可攜性 | 跨 vendor(將來換 Datadog 不用改 code) | 鎖死 AWS |
| 自動 instrumentation | 豐富(express、fetch、ioredis、pg 等) | 較少 |
| Next.js 整合 | 官方 `@vercel/otel` package | 需自寫 wrapper |
| 學習曲線 | 中等 | 低 |

OpenTelemetry 是業界趨勢(CNCF graduated 2023),為將來保留可攜性。

### 4.2 設定

```ts
// instrumentation.ts(Next.js 15+ 約定檔名)
import { registerOTel } from '@vercel/otel'

export function register() {
  registerOTel({
    serviceName: 'playerledger-frontend',
    instrumentations: [
      // 自動 trace fetch（呼叫 API Server）
      // 自動 trace ioredis（Redis 操作）
      // 自動 trace HTTP server（incoming requests）
    ],
    traceExporter: {
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,  // ADOT collector 在 ECS sidecar
    },
  })
}
```

### 4.3 ADOT Collector Sidecar

ECS Task Definition 額外加一個 AWS Distro for OpenTelemetry collector 容器,把 OTEL 資料轉發到 X-Ray：

```json
{
  "name": "adot-collector",
  "image": "public.ecr.aws/aws-observability/aws-otel-collector:latest",
  "essential": true,
  "command": ["--config=/etc/ecs/ecs-default-config.yaml"],
  "logConfiguration": { "logDriver": "awslogs", ... }
}
```

BFF container 用 `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` 送到 sidecar。

### 4.4 自訂 span 範例

對重要業務操作加自訂 span：

```ts
import { trace } from '@opentelemetry/api'

const tracer = trace.getTracer('playerledger-frontend')

async function getValidAccessToken(): Promise<string | null> {
  return tracer.startActiveSpan('session.getValidAccessToken', async (span) => {
    try {
      span.setAttribute('cache.role', 'holder')   // 或 'waiter'
      const result = await /* ... */
      span.setAttribute('result', result ? 'token' : 'null')
      return result
    } catch (err) {
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  })
}
```

### 4.5 X-Ray 與 log / metric 串聯

X-Ray trace 都帶 `traceId` 與 `spanId`。將這兩個欄位加進 pino logger 的 mixin:

```ts
import { trace } from '@opentelemetry/api'

export const logger = pino({
  // ...
  mixin() {
    const span = trace.getActiveSpan()
    if (!span) return {}
    const ctx = span.spanContext()
    return { traceId: ctx.traceId, spanId: ctx.spanId }
  },
})
```

每筆 log 自動帶 `traceId`,在 X-Ray console 點開任何 trace 就能跳到 CloudWatch Logs Insights 看完整 log。

### 4.6 W3C Trace Context 跨服務傳遞

OpenTelemetry 採 [W3C Trace Context](https://www.w3.org/TR/trace-context/) 規範，以 `traceparent`（必要）與 `tracestate`（選用）兩個 header 表達分散式 trace 上下文。**BFF→Go 後端的 fetch 必須帶這兩個 header，否則 X-Ray service map 會在 BFF 邊界斷掉、後端 segment 變成孤立節點**。

`@vercel/otel` 對「在 fetch 中自動注入 traceparent」的支援取決於底層 instrumentation 是否被啟用（Next.js runtime 內部走的是 `undici`）。本專案的處理：

1. **接收端**：BFF 收到上游請求時，OTel HTTP server instrumentation 會自動從 `traceparent` 還原 trace context；若無則建立新 root span。
2. **轉發給後端**：在 `lib/api-client/client.ts` 的 fetch wrapper 內，**主動**用 `@opentelemetry/api` 的 `propagation.inject()` 把目前 context 注入 outbound fetch headers，**不依賴自動 instrumentation**：

```ts
// lib/api-client/client.ts（節錄）
import { context, propagation } from '@opentelemetry/api'

async function callApi(url: string, init: RequestInit) {
  const headers = new Headers(init.headers)
  // W3C trace context：把 traceparent / tracestate 注入 headers
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  })
  return fetch(url, { ...init, headers })
}
```

3. **白名單對齊**：ADR 005 的 outbound request header 白名單必須加入 `traceparent` 與 `tracestate`（兩者是「BFF 自行加入」類，不是從 Browser 透傳）。
4. **X-Request-ID 與 traceparent 並存**：兩者目的不同——`X-Request-ID` 是 HTTP 邊界的 correlation ID（人類可讀、跨服務 log），`traceparent` 是 OTel 的 trace context（機器解析、X-Ray 拓樸）。**兩個都送，不互相替代**（反模式見 §7）。

> **為何不依賴 `@vercel/otel` 自動注入**：Next.js 16 對 fetch 的 instrumentation hook 在 edge / node runtime 行為差異仍在迭代，明示注入是最保險、行為最可預期的做法，也讓 unit test 可以直接斷言 outbound fetch headers。

---

## 5. 環境變數

| 變數名稱 | 必填 | 預設 | 說明 |
|---------|------|------|------|
| `LOG_LEVEL` | ❌ | `info` | pino log 級別 |
| `APP_VERSION` | ❌ | `unknown` | build 時注入的 image tag |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ❌ | `http://localhost:4318` | ADOT collector sidecar |
| `OTEL_SDK_DISABLED` | ❌ | `false` | 本地開發可設 `true` 關 trace |

---

## 6. 測試規格

```ts
// lib/logger/logger.test.ts —— Redaction（每個 token 形態各一條）
it('should redact accessToken from log output')
it('should redact refreshToken from log output')
it('should redact access_token (snake_case) from log output')
it('should redact id_token from log output')
it('should redact generic "token" field from log output')
it('should redact apiKey / api_key from log output')
it('should redact password from log output')
it('should redact sid / sessionId from log output')
it('should redact headers.cookie / headers["set-cookie"]')
it('should redact headers.authorization / headers["proxy-authorization"]')
it('should redact headers["x-csrf-token"]')
it('should redact headers.Cookie (capitalised variant)')
it('should redact body.password / body.email')

// lib/logger/logger.test.ts —— Base fields
it('should include requestId in every log entry when X-Request-ID is set')
it('should include service.name / service.version / service.namespace in every log')
it('should include deployment.environment from NODE_ENV')
it('should include cloud.region / availability_zone / aws.ecs.task.arn when ECS metadata available')
it('should not fail logger initialization when ECS metadata fetch errors (local dev)')

// lib/logger/logger.test.ts —— mixin（trace context）
it('should inject traceId / spanId from active span via mixin')
it('should omit traceId / spanId when no active span')

// lib/logger/logger.test.ts —— level / 非結構化
it('should serialize level as string label (not numeric)')
it('should include stack trace for error level logs')
it('should NOT include stack trace for warn level logs')

// lib/logger/redact-query.test.ts —— query string token redaction（path-based 抓不到）
it('should redact ?access_token=… from http.request log query field')
it('should redact ?code=… (OAuth callback) from http.request log query field')
it('should preserve non-sensitive query params unchanged')

// lib/logger/metrics.test.ts
it('should emit EMF-formatted JSON for metric()')
it('should set Dimensions to [Object.keys(dimensions)] when dimensions non-empty')
it('should set Dimensions to [] (NOT [[]]) when dimensions are empty')   // regression: §3.2 bug
it('should output the metric value at the expected JSON key')
it('should include Namespace=PlayerLedger/Frontend on every emission')
it('should not emit a metric when value is NaN')   // 防呆，避免污染 dashboard

// lib/api-client/client.test.ts —— W3C trace context propagation
it('should inject traceparent header into outbound fetch when a span is active')
it('should inject tracestate header when present in context')
it('should preserve X-Request-ID alongside traceparent (both forwarded)')
it('should not inject traceparent when OTEL_SDK_DISABLED=true')

// proxy.ts / app/api/[...path]/route.ts —— ratelimit 與安全事件 log shape
it('should log auth.proxy.csrf_blocked with method/path/origin when Origin check fails')
it('should log ratelimit.hit with outcome="fail_open" when Redis fails on non-login route')
it('should log ratelimit.hit with outcome="fail_closed" when Redis fails on /api/login')
it('should log auth.token.refresh with outcome="replay_detected" when backend returns replay error')

// app/api/[...path]/route.test.ts (integration)
it('should log http.request and http.response for each call')
it('should emit http.request.duration metric')
it('should propagate requestId from request header to log fields')
it('should include traceId in http.request log when span is active')
```

---

## 7. 反模式（不要這樣做）

- ❌ 用 `console.log` 而非 pino → 缺結構、無法 redact、CloudWatch Logs Insights 無法查詢
- ❌ 在程式碼裡寫 `logger.info('user x logged in')`(字串拼接) → 無法後續分析,應該寫 `logger.info({ userId: 'x' }, 'user logged in')`
- ❌ log token / sid / password,並認為「只是 debug log,production 會關掉」→ pino redact 是強制機制,不依賴 level
- ❌ 用 CloudWatch SDK `PutMetricData` 而非 EMF → 增加失敗點與成本
- ❌ 把 `X-Request-ID` 當 trace ID → 兩者不同;X-Request-ID 是 HTTP 邊界用的,trace ID 是 OpenTelemetry 內部用的,兩者皆 log 進去
- ❌ 在 `instrumentation.ts` 之外初始化 OpenTelemetry → 必須在 Node.js process 啟動最早期初始化,否則自動 instrumentation 抓不到後續引入的模組
- ❌ 把 `X-Request-ID` 寫進 `traceparent`、或反之 → 兩者語意完全不同；`X-Request-ID` 是 HTTP 邊界的對話 ID（人類查 log 用），`traceparent` 是 OTel binary trace 結構，混用會破壞兩邊的工具
- ❌ 預期 `@vercel/otel` 會自動注入 `traceparent` 到 outbound fetch → 不保證；明示用 `propagation.inject()` 才能在 unit test 斷言、行為可預期（§4.6）
- ❌ 用 `redact-paths` 過濾 query string 的 token → pino redact 是 path-based，吃不到 string 內的 substring；query 必須在記 log 前用 `URL.searchParams` 換掉
- ❌ EMF 的 `Dimensions` 傳 `[[]]`（空陣列的陣列）→ CloudWatch 視為 schema 錯誤丟棄整筆 metric；無維度時應給 `[]`（§3.2）

---

## 8. 關聯文件

- [BFF 架構規格](./01-bff-architecture.md)
- [認證與 Session 規格](./02-auth-session.md)
- [ADR 005 - BFF Proxy Header 轉發規則](../adr/005-proxy-header-forwarding.md)（X-Request-ID 是 BFF↔Server 串聯的橋）
- [ADR 010 - 對齊後端 ADR 007 JWT 變更](../adr/010-align-with-backend-adr007-jwt.md)（解釋 `auth.token.refresh.replay_detected` 等新事件來源）
- [後端 ADR 007 - Refresh Token Rotation 與重放偵測](../../PlayerLedgerBackend/docs/adr/007-refresh-token-rotation-and-replay-detection.md)
- [AWS Embedded Metric Format 文件](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
- [AWS Distro for OpenTelemetry](https://aws-otel.github.io/)
