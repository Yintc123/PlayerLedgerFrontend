# ADR 001 - 前端部署架構選擇

## 狀態

已採用

## 背景

需要為 Next.js 前端選擇部署架構。初始方案是沿用後端的 API Gateway + Lambda，但評估後發現不適合。

## 評估：API Gateway + Lambda

### 問題一：冷啟動

Next.js 加上 `node_modules` 打包後體積超過 100–300 MB，Lambda 冷啟動需要下載解壓、初始化 Node.js runtime、載入 Next.js server，延遲可達 2–5 秒，直接影響 SSR 頁面的首次載入。

### 問題二：ISR 無法運作

ISR（Incremental Static Regeneration）需要寫入檔案系統並跨請求共享快取狀態。Lambda 的 `/tmp` 各 instance 互相隔離，ISR 的快取機制無法協調。

### 問題三：Streaming 支援有限

React 18 + Next.js 的 Streaming SSR 依賴 HTTP chunked transfer。API Gateway 預設等待 Lambda 完成後才回傳整個 response，與 Streaming 模型衝突。

### 問題四：回應大小上限

API Gateway 回應上限為 6 MB（REST）/ 10 MB（HTTP），Next.js 頁面若包含大量 inline data 容易超限。

### 問題五：Middleware 執行環境不匹配

Next.js Middleware 設計跑在 Edge Runtime（V8 Isolate），Lambda 是完整 Node.js 環境，兩者 API 不完全相容。

### 問題六：靜態資源成本

靜態資源（`_next/static/`）透過 Lambda 提供服務，每次請求都計費一次 invocation，遠不如 S3 + CloudFront 直接快取。

### 問題七：29 秒逾時限制

API Gateway 整合的逾時上限為 29 秒，SSR 頁面在高負載下若需彙整多支 API 資料容易逾時。

## 評估：CloudFront + ALB + ECS Fargate

ECS Fargate 跑持續運行的 Node.js container，解決了 Lambda 的所有核心問題。

**優點：**

- ISR、Streaming SSR、Image Optimization 全部正常運作
- 無 29 秒逾時限制
- WebSocket 原生支援
- ALB 功能完整（路由、健康檢查、流量分配）

**缺點：**

- ALB 有固定基本費 ~$5.76/月，即使零流量也持續計費
- 低流量情境下成本高於 API Gateway

## 評估：API Gateway + ECS Fargate

ECS 解決了 Lambda 的核心問題（冷啟動、ISR、Streaming），但 API Gateway 與 ECS 搭配時，相較於 ALB 有以下取捨：

**API Gateway 的優勢：無固定基本費**

ALB 光是開著就需支付 ~$5.76/月，API Gateway 採純按量計費：

| 方案 | 低流量（50 萬請求/月） | 高流量（2,000 萬請求/月） |
|------|----------------------|------------------------|
| ALB | ~$16/月（固定） | ~$20/月 |
| API Gateway HTTP API | ~$0.50/月 | ~$20/月 |

低流量情境下 API Gateway + ECS 在成本上有明顯優勢。

**API Gateway + ECS 仍有的限制：**

- **29 秒逾時**：SSR 頁面若需彙整多支 API 資料，高負載下有逾時風險
- **Streaming 受限**：API Gateway 對 HTTP chunked transfer 支援有限，影響 Streaming SSR
- **WebSocket**：需額外設定，ALB 原生支援

## 決策：依流量選擇負載均衡層

ECS Fargate 作為執行環境已確定，負載均衡層依流量與功能需求選擇：

| 情境 | 建議方案 |
|------|---------|
| 低流量、內部工具、無 Streaming 需求 | CloudFront + **API Gateway** + ECS Fargate |
| 高流量、公開服務 | CloudFront + **ALB** + ECS Fargate |
| 有 Streaming SSR 或 WebSocket 需求 | CloudFront + **ALB** + ECS Fargate |

此為 Demo 專案，基於成本考量全環境統一採用 **CloudFront + API Gateway + ECS Fargate**：

```
用戶
 └─▶ CloudFront          # CDN，快取靜態資源（_next/static/）
       └─▶ API Gateway   # 按量計費，低流量下成本低於 ALB
             └─▶ ECS Fargate (Next.js container)
```

正式 Production 專案應改用 **CloudFront + ALB + ECS Fargate**，可避免 29 秒逾時限制並支援 Streaming / WebSocket。

| 環境 | 入口 | 理由 |
|------|------|------|
| Demo / Dev / Staging | API Gateway | 低流量，省 ALB 固定基本費（~$16/月） |
| Production（建議） | ALB | 穩定性優先，無逾時與 Streaming 限制 |

## 後端對比

後端（Go API Server）維持 **API Gateway + Lambda**，Go 編譯成二進位執行效率高、冷啟動快（< 100ms），是 Lambda 真正適合的場景。
