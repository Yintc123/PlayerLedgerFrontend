# ADR 012 - 健康檢查端點：分離 liveness 與 dependency check

## 狀態

部分被取代。shallow / deep 的拆分仍有效，但 **shallow probe 含 Redis 並交給 ECS Target Group 的決策已由 [ADR 022](./022-health-liveness-readiness-split.md) 取代**：`/api/health` 改為純 liveness（不含 Redis），Redis 檢查移至新的 `/api/health/ready`。原因見 ADR 022——Redis 抖動會讓整批 BFF task 同時被 ECS 替換、卻無法修好 Redis。本文「方案 C：純 process-alive」當時被否決的理由已被實際營運推翻，下方保留原文供歷史脈絡。

> 原始狀態：已採用（修訂 [01-bff-architecture.md §9](../specs/01-bff-architecture.md#9-健康檢查端點) 將 `/api/health` 拆為 shallow + deep 兩個端點）

## 背景

spec 01 §9 原設計 `/api/health` 同時檢查 Redis 與上游 API Server，並由 ECS Target Group 直接使用。這違反「liveness probe 只應反映被檢者自身狀態」的 SRE 通則，會在以下情境造成連鎖故障：

1. API Server 短暫慢（多個 Lambda cold start 撞在一起，常見 3-5s）
2. `/api/health` 內聯的 `apiServer` 檢查超時
3. ECS 把 BFF task 判定為 unhealthy → 觸發替換
4. **多個 BFF task 同時觸發** → 服務容量歸零
5. 正好在 API Server 已經壓力大時把 BFF 容量收回去 → 雪崩

連鎖反應的根本問題：BFF 的「自身是否健康」不該綁定 API Server 的「是否健康」——API Server 抖動由 metric + alarm 處理，不該透過 health probe 觸發 task replace。

## 評估

### 方案 A：保持單一 endpoint 內聯所有檢查（現狀）

風險如上。優點是端點數量少，理解成本低。

### 方案 B：拆 shallow / deep 兩個 endpoint（採用）

| Endpoint | 檢查項目 | 使用者 | 失敗時行為 |
|---|---|---|---|
| `GET /api/health` | process alive + Redis ping | ECS Target Group、Docker HEALTHCHECK | task 替換 |
| `GET /api/health/deep` | shallow + API Server `/health` | 人工 dashboard、外部 uptime monitor、CD smoke test | 告警，**不替換 task** |

優點：
- ECS 只看 BFF 自身狀態，API Server 抖動不會擴散
- 上游異常透過 `api_server.call.error` metric + alarm 處理（更精準）
- CD smoke test 改打 deep 端點以驗證整鏈路

### 方案 C：純 process-alive

完全不檢查 Redis。問題：Redis 連不上時 BFF 整段沒救（所有 session 操作壞掉），但 task 仍被視為健康，永遠不會被替換。Redis 是 BFF 的內部依賴（同 VPC、無第二來源），必須含在 shallow 檢查內。

## 決策

採方案 B。

### `/api/health`（shallow）

```http
GET /api/health
→ 200 { status: "ok", checks: { redis: { status: "ok", latencyMs: 1 } } }
→ 503 若 Redis ping 失敗
```

檢查項目：
| 項目 | 操作 | timeout | 失敗判定 |
|------|------|---------|---------|
| `redis` | `redis.ping()` | 2s | 例外或非 `"PONG"` |

**ECS Target Group 與 Docker HEALTHCHECK 一律使用此端點。**

### `/api/health/deep`

```http
GET /api/health/deep
→ 200 { status: "ok", checks: { redis: {...}, apiServer: {...} } }
→ 503 若任一檢查失敗
```

檢查項目：shallow 全部項目 + `apiServer`（`GET ${API_BASE_URL}/health`, timeout 3s）。

**禁止放進 Target Group 設定。** 用途：
- CD smoke test（驗證部署後整鏈路可達）
- 外部 uptime monitor（pingdom / statuscake / cron 等）
- 人為 dashboard 查看

### 路徑歸類

`PUBLIC_PATHS` Set 需加入兩個健康檢查端點，兩者都不需 session：

```ts
const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/api/login',
  '/api/logout',
  '/api/health',
  '/api/health/deep',
])
```

### Metric 與 Alarm

| Metric | 用途 |
|---|---|
| `health.shallow.failure` | Redis 真的掛了，task 會被替換 |
| `health.deep.failure` | 上游 API 異常，不替換 task 但要告警 |

上游異常的主要監控訊號仍是既有的 `api_server.call.error rate > 5%`（spec 03 §3.4），更精準且不依賴 health probe。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/01-bff-architecture.md` §9 | 拆為 §9.1 shallow / §9.2 deep；§11.3 smoke test 改打 deep；§11.5 ECS Target Group 仍 `/api/health` 但檢查項目變淺 |
| `docs/specs/04-dockerfile-build.md` §3 | HEALTHCHECK 維持 `/api/health`（語意現在是 shallow） |
| `docs/specs/02-auth-session.md` §4 | `PUBLIC_PATHS` 加入 `/api/health` 與 `/api/health/deep` |
| `docs/specs/03-observability.md` §3.3 | 新增 `health.shallow.failure` 與 `health.deep.failure` metric |

## 參考

- [Google SRE Workbook - Implementing SLOs §「Don't probe through dependencies」](https://sre.google/workbook/implementing-slos/)
- [Kubernetes Pod Lifecycle - Probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#types-of-probe)：liveness probe 不應依賴外部服務
- [AWS - ELB Health Checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
