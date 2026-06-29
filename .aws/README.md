# `.aws/ecs-task-definition.json` 說明

JSON 不支援註解，且本檔會被 `amazon-ecs-render-task-definition`（`JSON.parse`）與
`aws ecs register-task-definition --cli-input-json`（bootstrap.yml）解析——任何
`//` 註解或多餘的 key 都會讓部署失敗。所以欄位的「為什麼」記錄在這裡。

## 環境變數

### `HOSTNAME=0.0.0.0` ← 必填，別刪

Next.js standalone server（`node server.js`）用 `process.env.HOSTNAME` 決定要 bind
哪個網路介面。**不設這條就會壞**，原因是兩個機制相撞：

1. ECS 用 **awsvpc** 網路模式，每個 task 配一張 ENI；ECS 會把**容器 hostname**
   設成該 ENI 的私有 DNS 名稱（例如 `ip-172-31-27-241.ap-southeast-2.compute.internal`）。
2. container runtime 預設會把 **`HOSTNAME` 環境變數**自動填成容器 hostname。

於是 runtime 注入的 `HOSTNAME` = ENI DNS 名稱，Next 就**只 bind 在那個 ENI IP**，
沒有 listen loopback。結果 task definition 的 container `healthCheck`
（`wget http://127.0.0.1:3000/api/health`）連不到 → grep 失敗 → task 被砍
（exit 143「Task failed container health checks」）→ 不斷替換 → deploy timeout。

修法：明確設 `HOSTNAME=0.0.0.0`。環境變數優先級「task def `environment` > runtime
自動注入 > image `ENV`」，所以放在這裡才壓得過自動注入；
**只在 Dockerfile 寫 `ENV HOSTNAME=0.0.0.0` 沒用**（最低優先級，會被蓋掉）。
`0.0.0.0` = 綁所有介面，loopback（container healthcheck）與 ENI IP（ALB target
group）同時可達。

> 同類雷在 Kubernetes 也有（`HOSTNAME` 被設成 Pod 名稱），標準解一樣是強制
> `HOSTNAME=0.0.0.0`。詳見 `docs/adr/022-health-liveness-readiness-split.md` 與
> commit `68b2807`。

### 其他必填 env（`config.ts` 啟動時 fail-fast 驗證）

`REDIS_HOST` / `API_BASE_URL` / `PUBLIC_ORIGIN` / `CLIENT_ID` 缺任一，server
在 module load 就 throw、起不來。

## Placeholder 替換

`ACCOUNT` / `REGION` / `EC2_PRIVATE_IP` / `REGISTRY...:LATEST` 是佔位字串，由
`.github/workflows/`（ci.yml 的 deploy job、bootstrap.yml）以 `sed` 或
`render-task-definition` 在部署時替換，不要寫死。

## 健康檢查端點（ADR 022）

- container `healthCheck` 打 `/api/health` = **liveness**，不查 Redis，恆 200。
- Redis 檢查在 `/api/health/ready`、整鏈路在 `/api/health/deep`，兩者都**不可**
  放進 ECS Target Group。
