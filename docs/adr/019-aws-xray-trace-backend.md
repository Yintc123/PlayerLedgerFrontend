# ADR 019 - AWS X-Ray 為 distributed trace 的 backend

## 狀態

已採用（與 [ADR 015 - OpenTelemetry + ADOT](./015-opentelemetry-adot-collector.md) 互補：ADR 015 決定 emission 機制，本 ADR 決定 storage / UI）

## 背景

OTel 把 trace data 抽象成 OTLP，**實際儲存與 UI 仍需後端**。spec 03 §4.1 直接寫「採 X-Ray exporter」，但未走 ADR 流程比對 Jaeger / Tempo / Honeycomb / Datadog。trace backend 選錯會造成事故時找不到 trace，鎖死後遷移成本高，值得寫下。

## 評估

### 候選方案

| 方案 | 託管 | 整合 ADOT | 與其他 AWS 服務串接 | 成本（v1 規模） |
|------|------|----------|--------------------|---------------|
| **A. AWS X-Ray**（採用） | AWS 全託管 | ADOT 預設 exporter | CloudWatch Logs Insights、Service Map、ALB 整合 | 前 100k traces/月免費；後 $5/百萬 |
| B. Grafana Tempo（自託管 / Grafana Cloud） | 需 OTel collector 寫到 S3 + Grafana | OTLP exporter | Grafana dashboard | 自託管：EC2 + S3；Cloud：依量計費 |
| C. Honeycomb | SaaS | OTLP exporter | 無 AWS service map | $0 起步 / 月費門檻成長快 |
| D. Datadog APM | SaaS | DD exporter | 無 AWS 原生 | 月費門檻高 |
| E. Jaeger（自託管） | 自跑 Elasticsearch / Cassandra | OTLP exporter | 無 | 維護成本高 |

### 為何挑 X-Ray

1. **Service Map 自動串聯**：X-Ray 從 trace 自動建立服務拓樸圖（BFF → 後端 → DB），事故時一眼看到延遲熱點；其他方案需自畫 dashboard。
2. **與 CloudWatch 同 console**：spec 03 §4.5 的 `traceId` 同時出現在 X-Ray trace 與 CloudWatch Logs，點 trace 就跳到對應 log；換到 Honeycomb / Datadog 等需要設定 link template 或在 console 間跳轉。
3. **ADOT collector 預設 exporter**：ADR 015 採 ADOT，X-Ray exporter 是 ADOT 出廠配置；換成其他 backend 需自寫 collector config + 處理 auth（增量 IAM / secret 管理）。
4. **v1 規模幾乎免費**：前 100k traces/月免費；以 BFF 100 QPS × 1% sampling（spec 03 §4 待補 sampling 策略）每月遠低於上限。
5. **無資料外送（compliance）**：trace data 留在 AWS account 內，不離開 region；若日後加入 PII trace attribute（後端 user_id 經 hash 後）較少跨 vendor 合規評估。

### X-Ray 的代價（已知接受）

- **不能完全脫離 AWS**：本架構已選擇 ECS Fargate + CloudWatch + Secrets Manager；trace backend 也走 AWS 是延續一致決策，不會額外增加 lock-in。
- **UI 比 Honeycomb / Grafana Tempo 弱**：X-Ray console 的查詢 / aggregation 功能有限，做深度分析仍需 export 到 Athena 或 CloudWatch Logs Insights。v1 規模下，能在 console 直接點 trace 看完整 span tree 已足夠；複雜分析等需求出現再評估。
- **採樣率較難調**：X-Ray sampling rule 在 AWS console / IaC 定義，與 ADOT 端 sampler 互動需小心（建議於 ADOT collector 端做 head sampling，X-Ray 端不重複採樣）。

### 為何不採 Honeycomb / Tempo / Datadog

- **Honeycomb**：UI 強，但「再導入一個 SaaS / dashboard 工具」對 v1 規模不成比例；team capacity 有限，多 UI 等於多分心。
- **Grafana Tempo**：Grafana stack（Loki + Tempo + Prometheus）值得在後端 / 多服務環境採用，v1 BFF 規模架設 + 維護成本不划算。
- **Datadog**：APM 月費門檻 vs v1 流量規模不對等。
- **Jaeger 自託管**：維護 Elasticsearch / Cassandra cluster 不在 v1 capacity 內。

## 決策

採 **AWS X-Ray**：

1. ADOT sidecar `awsxray` exporter 設為唯一 trace destination（spec 03 §4.3）。
2. **Sampling 策略**（補入 spec 03 §4 待補項）：v1 採 head sampling 5%（ADOT collector 端設定 `OTEL_TRACES_SAMPLER=parentbased_traceidratio`、`OTEL_TRACES_SAMPLER_ARG=0.05`）；error span 強制採樣（後續以 tail sampling 處理需 OTel collector 配置）。
3. ECS Task IAM role 加入 `xray:PutTraceSegments` / `xray:PutTelemetryRecords`。
4. **X-Ray group 命名**：`playerledger-frontend-<env>`，所有 alarm / dashboard 統一 prefix。
5. trace retention：X-Ray 預設 30 天，v1 沿用不調整。

### 何時重新評估

- 流量量級到 100k+ traces/月（成本可能超過 SaaS 月費門檻，重新算帳）
- 需要進階分析（複雜 attribute query、aggregation by 多維度），X-Ray console 不夠用
- 切離 AWS 平台

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/03-observability.md` §4 全節 | cross-ref 本 ADR |
| `docs/specs/03-observability.md` §4 | 補 sampling 策略段落 |
| ADOT collector config | `awsxray` exporter + sampling rule |
| ECS Task IAM role | 加入 `xray:Put*` |
| `.env.example` | `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` |

## 參考

- [AWS X-Ray pricing](https://aws.amazon.com/xray/pricing/)
- [ADOT awsxray exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/awsxrayexporter)
- [OpenTelemetry sampling guidance](https://opentelemetry.io/docs/concepts/sampling/)
- [ADR 015 - OpenTelemetry + ADOT collector](./015-opentelemetry-adot-collector.md)
