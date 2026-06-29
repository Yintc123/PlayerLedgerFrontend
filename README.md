# PlayerLedger Frontend

PlayerLedger CMS 後台前端：供管理人員查詢玩家、儲值（topup）紀錄與管理 CMS 使用者。以 **Next.js App Router** 建置，並作為 **BFF（Backend for Frontend）**——瀏覽器不直接持有 JWT，所有對後端的呼叫都經由本服務轉發。

## 開發方法

本專案採用 **SDD + TDD**：

- **SDD（Schema-Driven Development）**：以 `src/schema/openapi.yaml`（由後端同步、單一可信來源）為 API 契約，前後端依此並行開發；不對 API 做猜測性呼叫。
- **TDD（Test-Driven Development）**：先寫測試再實作（Red → Green → Refactor）。測試清單以對應 spec 為準（`docs/specs/`）。

詳見 [`CLAUDE.md`](CLAUDE.md)。

## 技術棧

| 範疇         | 採用                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| 框架         | [Next.js 16](https://nextjs.org/)（App Router、RSC、Node Runtime）、React 19、TypeScript |
| UI           | Tailwind CSS v4 + shadcn/ui（[ADR 021](docs/adr/021-tailwind-v4-shadcn-ui.md)）          |
| Session 儲存 | Redis（`ioredis`）— 存放 server-side token，cookie 僅帶不透明 session id                 |
| 可觀測性     | `pino` 結構化日誌、OpenTelemetry（W3C Trace Context）、CloudWatch EMF metrics            |
| 測試         | Vitest（unit / component, RTL）、Playwright（E2E）                                       |
| 部署         | AWS ECS Fargate + API Gateway + CloudFront                                               |

## 架構概覽（BFF）

```
瀏覽器
 │  只持有不透明 session id（__Host- cookie）；絕不接觸 JWT
 ▼
Next.js（本服務 / BFF）
 ├─ RSC server-side：cmsRequest() 帶 Bearer token 呼叫後端 /api/cms/*
 ├─ /api/[...path]   ：瀏覽器發起的 state-changing 請求 catch-all proxy（CSRF/auth/trace 把關）
 ├─ /api/login|logout|register：session 生命週期端點
 └─ Redis：存 access/refresh token，silent refresh + mutex
 ▼
後端 API（Go，另一 repo PlayerLedgerBackend）
```

核心設計：

- **Session 與 Token**：登入後 token 存於 Redis，瀏覽器只拿 64-hex 不透明 session id（`__Host-` host-only cookie）。Access token 15 分鐘、refresh token 滑動 1 小時 + 絕對上限（cms-web 8h）；近到期時於 server 端 **靜默 refresh**（Redis mutex 防併發，[ADR 004](docs/adr/004-token-refresh-mutex.md)）。
- **閒置自動登出**：CMS 閒置 15 分鐘 → 前端 30 秒警告 modal → 主動 `POST /api/logout` 並導回登入；多分頁經 `BroadcastChannel` 同步活動與登出（spec 02 §5.5/§5.6）。
- **可觀測性**：每筆請求帶 `X-Request-ID`、W3C `traceparent` 注入上游（X-Ray 子 span）；metrics 以 CloudWatch EMF 發出；瀏覽器端 vitals / 錯誤經 `/api/vitals`、`/api/client-errors` 回收（spec 03）。
- **安全**：CSRF 採 `SameSite=Lax` + Origin 檢查（[ADR 013](docs/adr/013-csrf-defense-strategy.md)）、CSP nonce 由 proxy header 注入（[ADR 020](docs/adr/020-csp-nonce-via-proxy-header.md)）、速率限制（[ADR 009](docs/adr/009-rate-limiting-strategy.md)）、edge hardening（[ADR 011](docs/adr/011-edge-security-hardening.md)）。

## 快速開始

### 1. 安裝相依套件

```bash
npm install
```

### 2. 設定環境變數

複製 `.env.example` 為 `.env` 並填入：

| 變數                                                        | 說明                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `API_BASE_URL`                                              | 後端 API 位址（例：`http://localhost:8080`）     |
| `CLIENT_ID`                                                 | OpenAPI ClientID（`cms-web` / `public-web` / …） |
| `PUBLIC_ORIGIN`                                             | 對外 origin（用於 CSRF 允許清單 / cookie）       |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` | Session 儲存                                     |

其餘為選填（含預設值）：`SESSION_TTL_SECONDS`、`CMS_API_BASE_PATH`、`API_TIMEOUT_MS`、`SECURE_TRANSPORT`、`ALLOWED_ORIGINS_EXTRA`、`COOKIE_DOMAIN` 等，詳見 `.env.example` 註解。

> 需要可連線的 Redis 與後端 API 才能完整登入。本機可用 `docker-compose.yml`（含 redis）。

### 3. 啟動開發伺服器

```bash
npm run dev
```

開啟 [http://localhost:3000](http://localhost:3000)。

### 4. 建置 / Docker

```bash
npm run build && npm start          # 正式建置（output: standalone）

docker build -t playerledger-frontend .
docker run -p 3000:3000 playerledger-frontend
```

推送至 ECR 部署 ECS：

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_URI>
docker tag playerledger-frontend:latest <ECR_URI>:latest
docker push <ECR_URI>:latest
```

## 測試

```bash
npm run test          # Vitest 單次（unit + component）
npm run test:watch    # 監聽模式
npm run test:e2e      # Playwright E2E（需 dev server + 後端 + redis）
npm run lint          # eslint --max-warnings 0
npm run type-check    # tsc --noEmit
npm run format:check  # prettier --check
```

| 層級      | 工具                           | 範圍                                             |
| --------- | ------------------------------ | ------------------------------------------------ |
| Unit      | Vitest                         | 工具函式、純邏輯（如 `lib/idle`、`lib/session`） |
| Component | Vitest + React Testing Library | UI 元件互動行為                                  |
| E2E       | Playwright                     | 登入、受保護路由、閒置登出、跨分頁同步等關鍵流程 |

## 專案結構

```
PlayerLedgerFrontend/
├── src/
│   ├── app/
│   │   ├── (auth)/              # 公開區：login / register
│   │   ├── (cms)/              # 受保護區（layout 驗證 session + 掛載 IdleTimerProvider）
│   │   │   ├── dashboard/
│   │   │   ├── players/        # 玩家搜尋 / 詳情 / 儲值紀錄（含巢狀 topups）
│   │   │   └── deposit-records/ # 全域儲值紀錄
│   │   └── api/                # BFF 端點
│   │       ├── [...path]/      # catch-all proxy → 後端
│   │       ├── login|logout|register/
│   │       ├── health（/ready /deep）/
│   │       └── vitals | client-errors | csp-report/
│   ├── components/             # 共用元件（含 idle-timer-provider、idle-warning-modal、ui/）
│   ├── lib/
│   │   ├── api-client/         # cmsRequest / apiFetch（trace 注入）
│   │   ├── session/            # Redis session、cookie、silent refresh
│   │   ├── auth/               # login / logout / refresh / token decode
│   │   ├── idle/               # 閒置 timer / BroadcastChannel / 政策（純邏輯）
│   │   ├── observability/      # metrics 發送
│   │   ├── logger/             # pino + redact
│   │   ├── players/ topups/    # 資料層（手寫 Raw* + transform）
│   │   ├── rate-limit/ health/ format/ config…
│   ├── proxy.ts               # 路由保護（Next.js 16，Node Runtime）
│   └── schema/openapi.yaml    # OpenAPI 契約（由後端同步，見 src/schema/README.md）
├── e2e/                       # Playwright 測試
├── docs/specs/               # 功能規格（SDD 契約來源）01–14
├── docs/adr/                 # 架構決策紀錄 001–022
└── public/                   # 靜態資源
```

## 部署架構

```
用戶
 └─▶ CloudFront          # CDN，快取靜態資源（_next/static/）、HTTPS 終止
       └─▶ API Gateway   # 按量計費，低流量下成本優於 ALB
             └─▶ ECS Fargate（Next.js standalone container）
```

> **注意**：此為 Demo 專案，基於成本考量全環境統一使用 API Gateway + ECS。正式 Production 建議改用 ALB，避免 29 秒逾時限制並支援 Streaming / WebSocket。詳見 [ADR 001](docs/adr/001-deployment-architecture.md)。

## 文件

- **規格（specs）**：[`docs/specs/`](docs/specs/) — BFF 架構、Auth/Session、可觀測性、各網域與畫面規格（01–14）。
- **架構決策（ADR）**：[`docs/adr/`](docs/adr/) — 部署、BFF 路由、Token refresh mutex、CSRF、CSP、可觀測性等 22 篇。
- **開發守則**：[`CLAUDE.md`](CLAUDE.md) — SDD + TDD 紀律。
