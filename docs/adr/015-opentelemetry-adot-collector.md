# ADR 015 - 採用 OpenTelemetry + ADOT collector sidecar

## 狀態

已採用（為 [03-observability.md §4](../specs/03-observability.md#4-distributed-tracing) 的工具選擇補上正式 ADR）

## 背景

分散式追蹤是 BFF 架構的必備能力——使用者一次點擊會同時觸發 Browser → CloudFront → API Gateway → BFF → 後端 Go API → DB / Redis，缺了 trace 拿不到端到端延遲拆解，事故時光看 BFF log 不知道是自己慢還是後端慢。spec 03 §4 直接寫「採 OTel + AWS X-Ray exporter，透過 ADOT collector sidecar」，但未走 ADR 流程比對其他方案。trace 架構是長期承諾（exporter / collector / backend 鎖死後改動成本高），值得寫下。

## 評估

### 候選方案

| 維度 | OTel + ADOT sidecar | AWS X-Ray SDK 原生 | Datadog APM | Sentry Performance |
|------|--------------------|-------------------|-------------|-------------------|
| Vendor lock-in | 低（OTLP 標準） | 高（綁 AWS） | 高（綁 DD） | 高（綁 Sentry） |
| Next.js 整合 | `@vercel/otel`（官方） | 需自寫 wrapper | DD agent 套件 | Sentry SDK |
| 自動 instrumentation | 廣（fetch / ioredis / pg / mysql / 多框架） | 較少（AWS SDK / HTTP） | 廣 | 中（聚焦 error） |
| 對外 exporter | X-Ray、Tempo、Jaeger、Honeycomb 任選 | 只能 X-Ray | 只能 DD | 只能 Sentry |
| 成本（v1 規模） | X-Ray 計費，可採樣 | 同 | 月費門檻 / GB | 月費門檻 |
| 學習曲線 | 中（OTel 概念多） | 低 | 低 | 低 |

### 為何挑 OTel + ADOT

1. **可攜性（最大決策因子）**：OTel 是 CNCF graduated（2023）的開放標準，BFF 程式只寫 `@opentelemetry/api`；後端要換成 Datadog / Honeycomb / Grafana Tempo 只需改 collector exporter 設定，不動應用程式。X-Ray SDK 原生則直接把 BFF 鎖死 AWS。
2. **自動 instrumentation 覆蓋面廣**：fetch / undici / ioredis / Next.js HTTP 都有 community-maintained instrumentation；自寫等同重做別人已做好的工作。
3. **`@vercel/otel` 官方支援**：Next.js 16 的 `instrumentation.ts` 註冊 hook 是 Vercel 維護，與框架同步演進（spec 03 §4.2 已採用）。
4. **ADOT sidecar 把 exporter 從 BFF process 拆出**：BFF 只送 OTLP/HTTP 到 `localhost:4318`，不需在 process 內處理 AWS auth、batch、retry；sidecar 掛了不會把 BFF 拖死（前提是 `essential: false`，spec 03 §4.3 已修訂）。
5. **學習曲線是一次性成本**：團隊吃下 OTel 概念後，未來任何後端服務（Go API 也要接入）都用同一套，邊際成本降低。

### OTel 的代價（已知接受）

- API 比 vendor SDK 抽象高，第一次寫 custom span 有概念門檻（`context.with()`、`tracer.startActiveSpan` 等）。
- Next.js 16 對 fetch instrumentation hook 在 edge / node runtime 行為有差異（spec 03 §4.6 已用 `propagation.inject` 規避）。
- AsyncLocalStorage context manager 須自己註冊（spec 03 §4.2 / C5 修補已寫明），否則 trace 跨 await 邊界後 context 遺失。

### 為何挑 ADOT 而非自跑 OTel Collector

ADOT 是 AWS Distro for OpenTelemetry，預設配置已最佳化 X-Ray exporter，且：
- ECR public 提供官方 image
- 與 X-Ray IAM 整合（Task role 即可，不必額外 STS）
- CloudWatch Container Insights 內建 ADOT sidecar metric

自跑 OTel Collector 等同重新搞 X-Ray exporter / IAM / image 維護，沒有額外好處。

## 決策

採 **OpenTelemetry + ADOT sidecar**：

1. BFF 內僅依賴 `@opentelemetry/api` 與 `@vercel/otel`，**不** 直接相依 AWS X-Ray SDK；exporter 路徑為 `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`，由 ADOT sidecar 接收 OTLP 後轉發 X-Ray。
2. ADOT sidecar：`essential: false`、`cpu: 256` / `memory: 256` / `memoryReservation: 128`、image SHA-pin、healthCheck 對 port 13133（spec 03 §4.3 已修訂）。
3. `instrumentation.ts` 必須先註冊 `AsyncLocalStorageContextManager` 才呼叫 `registerOTel`（spec 03 §4.2）。
4. Trace context 跨服務以 W3C `traceparent` / `tracestate` 傳遞，由 `lib/api-client/client.ts` 在 outbound fetch 主動 `propagation.inject`（不依賴自動 instrumentation；spec 03 §4.6）。

### 何時重新評估

- ADOT 維護中斷或 EOL（AWS 通知）
- X-Ray 服務轉變 / 成本變嚴重（屆時改 collector exporter 即可，BFF 不動）
- 團隊規模成長到需專屬 APM SaaS（Datadog / Honeycomb）

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/03-observability.md` §4 全節 | cross-ref 本 ADR |
| `docs/specs/01-bff-architecture.md` §11.4 | task definition 增加 adot-collector container（spec 03 §4.3 已修訂） |
| `instrumentation.ts` | 註冊 AsyncLocalStorageContextManager + registerOTel |
| `lib/api-client/client.ts` | propagation.inject 注入 traceparent |
| ECS Task IAM role | 需含 `xray:PutTraceSegments`、`xray:PutTelemetryRecords` |

## 參考

- [OpenTelemetry CNCF graduation](https://www.cncf.io/announcements/2024/01/16/opentelemetry-graduates/)
- [@vercel/otel package](https://www.npmjs.com/package/@vercel/otel)
- [AWS Distro for OpenTelemetry](https://aws-otel.github.io/)
- [W3C Trace Context spec](https://www.w3.org/TR/trace-context/)
- [ADR 019 - AWS X-Ray 為 trace backend](./019-aws-xray-trace-backend.md)（本 ADR 的下游選擇）
