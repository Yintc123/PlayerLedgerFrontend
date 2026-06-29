# ADR 022 - 健康檢查改三層：liveness / readiness / deep（liveness 與 Redis 解耦）

## 狀態

已採用。**取代 [ADR 012](./012-health-probe-scope.md) 對 shallow probe 的決策**——ADR 012 將 Redis ping 內聯進 `/api/health` 並交給 ECS Target Group 使用，本 ADR 把該依賴檢查移出 liveness。deep probe 設計不變。

## 背景

ADR 012 把健康檢查拆成 shallow（process + Redis，給 ECS Target Group）與 deep（+ 上游 API Server）。其中 shallow **刻意保留 Redis ping**，當時否決了「純 process-alive」（ADR 012 方案 C），理由是：

> Redis 連不上時 BFF 整段沒救（所有 session 操作壞掉），task 必須被替換才能讓 ECS 在新 AZ / 新節點重啟。

實際運行後此前提被推翻，前端 ECS 持續 health check 失敗：

1. Redis（ElastiCache）發生短暫不可達——failover、Security Group 調整、跨 AZ 抖動、maintenance window——都會讓 `redis.ping()` 逾時。
2. `/api/health` 因此回 **503**，即使 BFF 的 Node.js process 完全正常、能正常 render 頁面、proxy 其他 API。
3. ECS Target Group 連續 3 次失敗 → 判 unhealthy → **替換 task**。
4. **所有 BFF task 同時打同一個 Redis**，故會「同時」變 unhealthy → 服務容量瞬間歸零。

關鍵盲點：**替換 BFF task 並不會修好 Redis**。Redis 是 container 外的託管 ElastiCache，重啟 BFF task 對它毫無幫助，只會讓一批新 task 對著仍不可達的 Redis 重新連線（thundering herd），把情況變得更糟。換言之，把 liveness 綁定 Redis 帶來的是「無法自癒的連鎖傷害」，而非 ADR 012 設想的「換個節點就好」。

ADR 012 方案 C 真正的缺點——「Redis 掛了但 task 仍被視為健康、不會被替換」——其實**正是我們要的行為**：BFF 本身還能服務（顯示登入頁、回報錯誤、proxy 不需 session 的端點），不該因為下游依賴而被殺。Redis 異常應由 metric + alarm 通報人/告警系統處理，而不是由 probe 觸發 task 替換。

## 決策

採 Kubernetes 慣例的三層探針，liveness 與所有依賴解耦：

| Endpoint | 檢查項目 | 使用者 | 失敗時行為 |
|---|---|---|---|
| `GET /api/health` | **僅** process alive（能回應 HTTP） | ECS Target Group、Docker HEALTHCHECK | task 替換 |
| `GET /api/health/ready` | Redis ping | dashboard、內部監控、（可選）uptime monitor | **告警，不替換 task** |
| `GET /api/health/deep` | readiness + 上游 API Server `/health/ready` | CD smoke test、外部 uptime monitor、人為 dashboard | **告警，不替換 task** |

### `/api/health`（liveness）

```http
GET /api/health
→ 200 { status: "ok", version: "...", timestamp: "..." }   // 永遠 200
```

不查任何依賴，恆回 200。process 真的死掉（event loop 卡死、OOM）時根本無法回應 TCP，ECS 的 health check 自然逾時判定 unhealthy——這才是 liveness 該偵測的故障。回應**不含 `checks` 欄位**，明確表示「未做任何依賴檢查」。

### `/api/health/ready`（readiness，新增）

```http
GET /api/health/ready
→ 200 { status: "ok",        checks: { redis: { status: "ok", latencyMs: 1 } } }
→ 503 { status: "unhealthy", checks: { redis: { status: "error", error: "ECONNREFUSED", latencyMs: 2000 } } }
```

檢查 BFF 的內部依賴 Redis（ioredis `commandTimeout` 2s，沿用 ADR 012 §9.1 的逾時實作，避免殭屍 socket）。**禁止放進 ECS Target Group**——它的用途是讓監控/人辨識「BFF 還活著但 session 功能已降級」，由 alarm 處理，不觸發 task 替換。

### `/api/health/deep`（不變）

readiness 全部項目 + `apiServer`（`GET ${API_BASE_URL}/health/ready`，timeout 3s）。用途與 ADR 012 相同：CD smoke test、外部 uptime monitor、人為 dashboard。**禁止放進 Target Group**。

### Metric 與 Alarm

| Metric | 觸發來源 | 用途 |
|---|---|---|
| `health.readiness.failure` | `/api/health/ready` Redis 檢查失敗 | Redis 不可達告警（**不**自動替換 task） |
| `health.deep.failure` | `/api/health/deep` 任一檢查失敗 | 上游 API 異常，搭配 `api_server.call.error` 追蹤 |

liveness 沒有對應的 application-level failure metric——它「失敗」等於 process 無法回應，由 ECS / Target Group 的 `UnHealthyHostCount` 在基礎設施層觀測。

## 取捨

- **得**：Redis / ElastiCache 抖動不再連鎖替換整批 BFF task；ECS 只在 BFF 自身真的壞掉時才替換，符合 liveness probe 的 SRE 通則（[Google SRE：Don't probe through dependencies](https://sre.google/workbook/implementing-slos/)）。
- **失**：Redis 長時間不可達時，ECS **不會**自動換 task。這是刻意的——換 task 對 Redis 故障無濟於事。改以 `health.readiness.failure` alarm 通知人工/自動化介入（修 Security Group、等 ElastiCache failover、切備援），比盲目重啟精準。
- **相容性**：Docker HEALTHCHECK 仍打 `/api/health` 並 grep `"status":"ok"`，liveness 回應仍含該欄位，無需改 Dockerfile 指令本身。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `src/lib/health/checks.ts` | `getShallowHealth`（含 Redis）拆成 `getLiveness`（無依賴）+ `getReadiness`（Redis）；`HealthResponse.checks` 改 optional |
| `src/app/api/health/route.ts` | 改用 `getLiveness`，恆回 200 |
| `src/app/api/health/ready/route.ts` | 新增，使用 `getReadiness` |
| `src/proxy.ts` `PUBLIC_PATHS` | 加入 `/api/health/ready` |
| `docs/specs/01-bff-architecture.md` §9 | §9.1 改為 liveness、新增 §9.2 readiness、deep 順移為 §9.3；§9.4 ECS 表、§9.5 測試清單同步 |
| `docs/specs/02-auth-session.md` §4 | `PUBLIC_PATHS` 加入 `/api/health/ready` |
| `docs/specs/03-observability.md` §3.3 | `health.shallow.failure` → `health.readiness.failure`；alarm 語意調整 |
| `docs/specs/04-dockerfile-build.md` §3 | HEALTHCHECK 對應端點語意由 shallow 改為 liveness（path 不變） |

## 參考

- [ADR 012 - 健康檢查端點：分離 liveness 與 dependency check](./012-health-probe-scope.md)（本 ADR 取代其 shallow 設計）
- [Google SRE Workbook - Implementing SLOs §「Don't probe through dependencies」](https://sre.google/workbook/implementing-slos/)
- [Kubernetes Pod Lifecycle - Probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#types-of-probe)：liveness 不應依賴外部服務；readiness 才反映依賴
- [AWS - ELB Health Checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
