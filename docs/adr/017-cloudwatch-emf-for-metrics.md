# ADR 017 - CloudWatch Embedded Metric Format 為 metric 機制

## 狀態

已採用（為 [03-observability.md §3](../specs/03-observability.md#3-metrics) 隱含的工具選擇補上正式 ADR）

## 背景

spec 03 §3 直接寫「採 CloudWatch EMF」，但 metric 機制是橫切依賴：每個業務 event、HTTP request、rate-limit 觸發都會發 metric；換 metric backend 等同改全應用的 emission code。值得寫下決策，避免日後質疑「為何不用 Prometheus / Datadog」。

## 評估

### 候選方案

| 方案 | Emission 機制 | 額外依賴 | 失敗模式 |
|------|--------------|----------|---------|
| **A. CloudWatch EMF**（採用） | log 到 stdout，CloudWatch agent 自動萃取 | 無（重用 pino logger + awslogs driver） | log driver 壞 = log + metric 同時失敗，已單點 |
| B. CloudWatch SDK `PutMetricData` | 直接呼叫 AWS API | `@aws-sdk/client-cloudwatch` | API call 失敗影響業務；30 TPS / region 限制 |
| C. Prometheus exporter + Pushgateway | 應用內跑 `prom-client`，push 到 Pushgateway | Pushgateway 需自跑、ECS 整合複雜 | 多元件、ECS service discovery 設定繁瑣 |
| D. Datadog StatsD / Sentry metrics | 應用內呼 Datadog agent | 月費 + agent container | 月費門檻 |
| E. OTel metrics → ADOT → CloudWatch | OTel API 發 metric，ADOT 轉成 EMF / PutMetricData | 同 ADR 015 的 sidecar | 行為複雜，OTel metrics SDK Node.js 仍迭代中 |

### 為何挑 EMF

1. **零額外網路呼叫**：EMF 是「在普通 JSON log 內嵌特殊 `_aws` 欄位」的格式，CloudWatch agent 在 ingest log 時自動辨識並建立 metric。emission 與 log 走同一條 stdout pipe，無第二個失敗點。
2. **與 Pino 天然整合**：metric 就是一筆 log（spec 03 §3.2 範例），呼叫端是 `logger.info({ _aws: {...}, [name]: value, ...dimensions }, 'metric')`，redact / mixin / requestId 全部自動套用。
3. **CloudWatch `PutMetricData` 的 30 TPS region-wide 上限是真的會撞到**：BFF 流量 + 多 service 共用 region 配額時必爆；EMF 沒有此限制（受限於 CloudWatch Logs ingest 額度，遠寬鬆）。
4. **本專案已選擇 CloudWatch 作為主 observability 平台**（spec 03 §2.7 + ADR 019），多搬一份 metric 到 Prometheus / Datadog 只是增加無價值的 fan-out。
5. **OTel metrics 尚未穩定足以承擔**：OTel Node.js metrics SDK 雖然 GA，但 instrumentation 廣度、ADOT exporter 對 CloudWatch metric 的支援仍少於 EMF；v1 用最務實穩定的方案，後續若 OTel metrics 成熟可改 collector 端轉換（不動 BFF 程式）。

### EMF 的代價（已知接受）

- **CloudWatch metric 維度上限 5000 / namespace**：spec 03 §3.3 用 `route` template 而非實際 URL（C3 修補）來避免爆量；新加 dimension 必須評估 cardinality。
- **`Dimensions: [[]]` schema bug**：spec 03 §3.2 已記錄此陷阱（無維度時必須給 `[]` 而非 `[[]]`），測試覆蓋於 §6 `regression: §3.2 bug`。
- **無 vendor 中立性**：EMF 是 AWS 特有格式；換到 Datadog 需重寫 emission function。但 emission 集中於 `lib/logger/metrics.ts`（spec 03 §3.2），換 vendor 改一個檔即可，不影響呼叫端。

### 為何不採 OTel metrics（方案 E）

OTel metrics SDK 在 Node.js 雖已 GA（2024），但：
- ADOT collector 對 CloudWatch metric exporter 仍是「轉換到 PutMetricData」路徑，繞回去後撞回 30 TPS 限制；要避免必須轉成 EMF
- 雙工具鏈（OTel metrics + OTel traces）的學習成本，對 v1 規模不成比例
- 未來 OTel + CloudWatch EMF exporter 成熟時可遷移（emission 程式碼動到 `metrics.ts` 一檔）

## 決策

採 **CloudWatch EMF**：

1. emission 統一封裝於 `lib/logger/metrics.ts`（spec 03 §3.2 範例），呼叫端只透過 `metric(name, value, unit, dimensions)`。
2. namespace 統一 `PlayerLedger/Frontend`。
3. **dimension cardinality 規約**：任何 dimension key 一旦加入，必須估算 unique 值 < 1000（CloudWatch 上限 5000 含跨 metric）；違反者 PR review 必擋。dimension 含 ID / 任意 path 一律改用 template（spec 03 §3.3 C3 修補）。
4. **無維度的 global metric**：`dimensions = {}` 時 `Dimensions: []`（非 `[[]]`），保留迴歸測試（spec 03 §6 第一條 regression）。
5. metric emission 不可用於控流（不可在 hot loop 內每筆都 emit）；高頻 event 採 sampling 或 client-side 累計再 emit。

### 何時重新評估

- 切離 AWS 平台
- CloudWatch Logs 卷量爆量需採樣 / 切到 Vector pipeline
- OTel metrics + ADOT + CloudWatch EMF exporter 成熟（屆時 `metrics.ts` 改 OTel API，呼叫端不動）

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/03-observability.md` §3 全節 | cross-ref 本 ADR |
| `lib/logger/metrics.ts` | 唯一 emission entry |
| ECS Task IAM role | 無需 CloudWatch metric write 權限（EMF 透過 log ingest 自動建立），但需 `logs:CreateLogStream` / `logs:PutLogEvents`（本就需要） |
| 所有 metric 呼叫端 | 一律透過 `metric(...)`，禁用 `PutMetricData` SDK |

## 參考

- [CloudWatch Embedded Metric Format spec](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
- [CloudWatch PutMetricData TPS limits](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricData.html#API_PutMetricData_Errors)
- [OpenTelemetry Node.js metrics SDK status](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [03-observability.md §3.2 EMF 函式](../specs/03-observability.md#32-emf-函式)
