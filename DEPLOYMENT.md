# PlayerLedger Frontend — Deployment Guide

## 環境要求

- AWS ECS Fargate
- Redis 7.x
- Node.js 20.x runtime
- CloudWatch Logs & Metrics
- AWS Secrets Manager
- Container Registry (ECR or GHCR)

## 本地開發

### Docker Compose

```bash
# 啟動完整環境（Redis + Frontend + Mock API）
docker-compose up -d

# 檢查健康狀態
curl http://localhost:3000/api/health

# 查看日誌
docker-compose logs -f frontend
```

### 環境變數

參考 `.env.example`，建立 `.env.local`：

```bash
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
API_BASE_URL=http://api:8080
SESSION_TIMEOUT_MINUTES=30
```

## Staging/Production 部署

### 先置要求

1. AWS 帳戶 + ECS Cluster 已建立
2. Secrets Manager 中配置的密鑰：
   - `playerledger/redis-url`
   - `playerledger/api-base-url`
   - `playerledger/next-public-api-base-url`
3. GitHub Actions secrets：
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `STAGING_URL`
   - `PRODUCTION_URL`

### ECS Cluster 初始化

```bash
# 建立 staging cluster
aws ecs create-cluster --cluster-name playerledger-staging

# 建立 production cluster
aws ecs create-cluster --cluster-name playerledger-production

# 為每個 cluster 建立 service
aws ecs create-service \
  --cluster playerledger-staging \
  --service-name frontend \
  --task-definition playerledger-frontend \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[subnet-xxx],
    securityGroups=[sg-xxx],
    assignPublicIp=ENABLED
  }" \
  --load-balancers targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=frontend,containerPort=3000 \
  --deployment-configuration "maximumPercent=200,minimumHealthyPercent=100"
```

### Secrets 配置

```bash
# 建立 Redis URL secret
aws secretsmanager create-secret \
  --name playerledger/redis-url \
  --secret-string "redis://redis-cluster-endpoint:6379"

# 建立 API Base URL
aws secretsmanager create-secret \
  --name playerledger/api-base-url \
  --secret-string "https://api.example.com"

# 建立 Public API Base URL
aws secretsmanager create-secret \
  --name playerledger/next-public-api-base-url \
  --secret-string "https://example.com"
```

### 自動部署流程

1. **CI Pipeline** (`ci.yml`)
   - Lint + Type check
   - Unit tests (含 Redis)
   - E2E tests (含 Playwright)
   - Docker build 驗證
   - Security audit

2. **CD Pipeline** (`cd.yml`)
   - 構建 & Push 容器鏡像
   - 部署到 staging
   - 執行 staging 健康檢查
   - 自動部署到 production
   - 驗證 production 健康狀態
   - 失敗時自動回滾

推送到 `main` branch 時自動觸發完整部署。

### 手動部署

```bash
# 構建鏡像
docker build -t playerledger/frontend:v1.0 .

# Push 到 registry
docker push playerledger/frontend:v1.0

# 更新 ECS task definition
aws ecs register-task-definition \
  --cli-input-json file://.aws/ecs-task-definition.json

# 更新 ECS service
aws ecs update-service \
  --cluster playerledger-production \
  --service frontend \
  --task-definition playerledger-frontend:N \
  --force-new-deployment
```

## 監控 & 觀測

### CloudWatch Logs

所有應用日誌會自動發送到 CloudWatch：

- Log Group: `/ecs/playerledger-frontend`
- Log Stream: `ecs/frontend/{task-id}`

查詢錯誤：

```bash
aws logs filter-log-events \
  --log-group-name /ecs/playerledger-frontend \
  --filter-pattern "type:\"error\"" \
  --start-time $(date -d '1 hour ago' +%s)000
```

### CloudWatch Metrics

應用發佈的指標：

- `PlayerLedger/Frontend/http.request.count`
- `PlayerLedger/Frontend/http.request.duration`
- `PlayerLedger/Frontend/auth.login.attempts`
- `PlayerLedger/Frontend/ratelimit.hit`
- `PlayerLedger/Frontend/http.client.web_vitals`

建立告警：

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name playerledger-frontend-errors \
  --alarm-description "Alert on 5xx errors" \
  --metric-name http.request.count \
  --namespace PlayerLedger/Frontend \
  --statistic Sum \
  --period 300 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1
```

### 健康檢查

- **存活檢查 / liveness** (ECS Target Group, Docker HEALTHCHECK): `GET /api/health`
  - 只證明 process 還能服務，**不檢查任何依賴**，恆回 200（ADR 022）
  - Redis 抖動不會觸發 ECS 替換 task

- **就緒檢查 / readiness** (內部監控 / dashboard): `GET /api/health/ready`
  - 檢查 Redis 連線，快速失敗（2s 超時）
  - **禁止**設為 ECS Target Group health check

- **深層檢查** (監控 / CD smoke test): `GET /api/health/deep`
  - 檢查 Redis + 上游 API Server
  - 用於詳細診斷；**禁止**放進 Target Group

## 故障排除

### 容器無法啟動

1. 檢查 environment secrets：

```bash
aws ecs describe-task-definition \
  --task-definition playerledger-frontend:N \
  --query 'taskDefinition.containerDefinitions[0].secrets'
```

2. 查看容器日誌：

```bash
aws logs tail /ecs/playerledger-frontend --follow
```

### Redis 連線失敗

檢查 Secrets Manager：

```bash
aws secretsmanager get-secret-value --secret-id playerledger/redis-url
```

確認 ECS Task 安全群組可訪問 Redis。

### 部署後 502 錯誤

1. 檢查上游 API Server 可用性
2. 驗證 API_BASE_URL 配置
3. 查看 CSP 報告：`GET /api/csp-report`

## 回滾

### 自動回滾（失敗時）

CD pipeline 失敗時自動回滾至前一個 task definition。

### 手動回滾

```bash
# 取得前一個 task definition
PREV_TASK=$(aws ecs describe-services \
  --cluster playerledger-production \
  --services frontend \
  --query 'services[0].deployments[1].taskDefinition' \
  --output text)

# 回滾
aws ecs update-service \
  --cluster playerledger-production \
  --service frontend \
  --task-definition $PREV_TASK \
  --force-new-deployment
```

## 擴展 & 優化

### 自動擴展

```bash
# 註冊 Auto Scaling target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/playerledger-production/frontend \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10

# CPU 基礎策略
aws application-autoscaling put-scaling-policy \
  --policy-name cpu-scaling \
  --service-namespace ecs \
  --resource-id service/playerledger-production/frontend \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration "TargetValue=70.0,PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageCPUUtilization},ScaleOutCooldown=60,ScaleInCooldown=300"
```

## 安全審計

- 非 root 用戶運行容器（UID 1001）
- 只讀根文件系統（可配置）
- CPU & 記憶體限制（256 CPU units, 512 MB memory）
- 定期依賴漸進式掃描（GitHub Actions audit）
- 所有敏感值通過 Secrets Manager
