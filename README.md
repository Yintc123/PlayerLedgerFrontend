# PlayerLedger Frontend

玩家儲值紀錄查詢工具的前端介面，使用 Next.js 建置。

## 技術棧

- [Next.js](https://nextjs.org/)
- [AWS ECS Fargate](https://aws.amazon.com/fargate/) — 容器執行環境
- [AWS API Gateway](https://aws.amazon.com/api-gateway/) — 負載均衡（按量計費）
- [AWS CloudFront](https://aws.amazon.com/cloudfront/) — CDN 與靜態資源快取

## 快速開始

### 安裝相依套件

```bash
npm install
```

### 啟動開發伺服器

```bash
npm run dev
```

開啟 [http://localhost:3000](http://localhost:3000) 檢視結果。

### 建置正式版本

```bash
npm run build
npm start
```

### 建置 Docker Image

```bash
docker build -t playerledger-frontend .
docker run -p 3000:3000 playerledger-frontend
```

部署至 ECS 時將 image 推送至 ECR：

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_URI>
docker tag playerledger-frontend:latest <ECR_URI>:latest
docker push <ECR_URI>:latest
```

## 部署架構

```
用戶
 └─▶ CloudFront          # CDN，快取靜態資源（_next/static/）
       └─▶ API Gateway   # 按量計費，低流量下成本優於 ALB
             └─▶ ECS Fargate (Next.js container)
```

| 層 | 服務 | 用途 |
|----|------|------|
| CDN | CloudFront | 靜態資源快取、HTTPS 終止 |
| 入口 | API Gateway | 路由、按量計費 |
| 應用程式 | ECS Fargate | 執行 Next.js（SSR、ISR） |

> **注意**：此為 Demo 專案，基於成本考量全環境統一使用 API Gateway + ECS。正式 Production 專案建議改用 ALB，可避免 29 秒逾時限制並支援 Streaming / WebSocket。詳見 [ADR 001](docs/adr/001-deployment-architecture.md)。

## 專案結構

```
PlayerLedgerFrontend/
├── app/          # App Router 頁面與佈局
├── components/   # 共用元件
├── lib/          # 工具函式與 API 呼叫
└── public/       # 靜態資源
```
