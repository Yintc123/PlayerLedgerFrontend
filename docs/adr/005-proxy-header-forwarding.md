# ADR 005 - BFF Proxy Header 轉發規則

## 狀態

已採用

## 背景

BFF 的 `/api/[...path]/route.ts` 負責將瀏覽器的請求轉發給 Go API Server。
轉發時需要決定哪些 request headers 要帶過去、哪些要攔截。

錯誤的 header 轉發策略有兩種風險：
- **轉發了不該轉發的**：洩漏憑證、讓 API Server 誤判請求來源
- **沒轉發該轉發的**：API Server 無法正確解析 body，或遺失對它有意義的 metadata

## 決策

採用**白名單（Allow-list）**策略：只明確轉發需要的 headers，其餘一律捨棄。
與黑名單相比，白名單更安全——未來新增的 header 預設不轉發，而非預設轉發。

---

## Request Headers

### 不轉發的 Headers 及原因

**`Cookie`**

`Cookie` 內含 `sid`，這是 Browser ↔ BFF 層的 session 憑證，屬於 BFF 的內部機制。
API Server 不認識 `sid`，也不應該看到它。
API Server 透過 `Authorization: Bearer <accessToken>` 驗證身份，`Cookie` 對它而言是無意義且敏感的雜訊。

**`Host`**

Browser 送來的 `Host` 是 BFF 的 hostname（如 `playerledger.com`）。
若原樣轉發給 API Server，API Server 的虛擬主機設定或安全檢查可能因 hostname 不符而拒絕請求。
BFF 在呼叫 `fetch(API_BASE_URL, ...)` 時，Node.js 會自動帶入正確的 API Server hostname，無需手動處理。

**`X-Forwarded-For`**

記錄請求的來源 IP 鏈（如 `203.0.113.1, 10.0.0.1`）。
Browser 可以在發出請求時任意偽造此 header，若 BFF 盲目轉發，API Server 可能被欺騙誤認請求的真實來源 IP。
如需讓 API Server 取得可信的 client IP，應由 BFF 自行從 CloudFront 或 API Gateway 注入的可信 header 中讀取，再產生新的 `X-Forwarded-For`，而非轉發 Browser 提供的版本。

**`X-Forwarded-Host`**

記錄原始請求的 hostname。轉發此 header 可能向 API Server 洩漏 BFF 的基礎設施細節（hostname、部署環境），違反「瀏覽器不知道 API Server 存在」的封裝原則。

**`X-Forwarded-Proto`**

記錄原始請求使用的協定（`http` 或 `https`）。BFF 與 API Server 之間走 VPC 內部網路並以 HTTPS 通訊，此資訊對 API Server 不具意義。

**`Authorization`（若 Browser 帶了）**

BFF 架構下瀏覽器不應持有 JWT，也不應在請求中帶 `Authorization` header。
若 Browser 帶了此 header（開發者誤用或惡意嘗試注入 token），BFF 一律以自己持有的 `Authorization: Bearer <accessToken>` 覆蓋，Browser 的版本直接捨棄。

### 白名單：轉發給 API Server 的 Headers

| Header | 原因 |
|--------|------|
| `Content-Type` | API Server 需要知道 body 格式（`application/json` 等），POST / PUT / PATCH 請求必須帶 |
| `Accept` | 告知 API Server 瀏覽器可接受的回應格式 |
| `Accept-Language` | 若 API Server 支援多語系回應，需要此 header |
| `Accept-Encoding` | 允許 API Server 回傳壓縮內容，減少傳輸量 |

BFF 自行加入（不來自 Browser）：

| Header | 值 | 來源 |
|--------|-----|------|
| `Authorization` | `Bearer <accessToken>`（從 Redis session 取出的 JWT） | `getValidAccessToken()` |
| `X-Request-ID` | `proxy.ts` 沿用或產生的 requestId（大小寫須與後端 `pkg/logger/requestid.go` 的 `RequestIDHeader` 完全一致：D 大寫） | `proxy.ts` |
| `traceparent` | W3C Trace Context 規範格式（`00-<trace-id>-<span-id>-<flags>`） | `lib/api-client/client.ts` 透過 `@opentelemetry/api` 的 `propagation.inject()` 注入；對應 spec 03 §4.6 |
| `tracestate` | W3C Trace Context vendor 擴充欄位（X-Ray 等 exporter 可能附加） | 同上；context 若無則不送 |

> **`traceparent` 為何不依賴自動 instrumentation：** Next.js 16 對 fetch 的 OTel hook 行為仍在迭代，明示注入是 unit test 可斷言、行為可預期的做法。詳見 [spec 03 §4.6](../specs/03-observability.md#46-w3c-trace-context-跨服務傳遞)。

---

## Response Headers

API Server 的回應 headers 同樣需要篩選，不應全部直接給瀏覽器。

### 不轉發給 Browser 的 Headers

回應端採白名單策略（見下節），預設只放行明列的 header。本節額外列出**必須主動過濾**的 hop-by-hop headers（RFC 7230 §6.1 完整集）——即使白名單未來放寬，這些仍永遠不應跨 proxy 邊界：

| Header | 類別 | 原因 |
|--------|------|------|
| `Connection` | Hop-by-hop | 描述當下 TCP 連線屬性，跨 proxy 無意義；其值還會列出更多需過濾的 header 名稱（須遞迴解析並一併丟棄） |
| `Keep-Alive` | Hop-by-hop | 同上，連線層 metadata |
| `Proxy-Authenticate` | Hop-by-hop | 代理伺服器之間的驗證質詢，BFF 不是上游 proxy，向 browser 透出會誤導 |
| `Proxy-Authorization` | Hop-by-hop | 同上，且可能含憑證 |
| `TE` | Hop-by-hop | Transfer encoding 協商，逐節點協商 |
| `Trailer` | Hop-by-hop | 宣告 trailer 欄位的清單，與 chunked 編碼緊耦合 |
| `Transfer-Encoding` | Hop-by-hop | 描述當下節點的傳輸編碼（chunked / gzip-transfer 等），絕不可跨 proxy 傳遞 |
| `Upgrade` | Hop-by-hop | 協定升級（WebSocket 等）需逐節點重新協商，BFF 不代理升級 |
| `Set-Cookie` | 安全 | API Server 的 cookie 屬於 BFF↔Server 內部層，禁止洩漏到 browser（browser 端的會話狀態由 BFF 自己的 `sid` cookie 統一管理） |
| `Server` / `X-Powered-By` | 資訊洩漏 | 暴露上游技術棧；BFF 已於 `next.config.ts` 移除自身 `X-Powered-By` |

實作上採用「白名單先行 + 黑名單兜底」雙保險：白名單只允許下表 headers，hop-by-hop / 敏感 header 即使未來被誤加進白名單，也應在序列化前再過濾一次。

### 白名單：轉發給 Browser 的 Response Headers

| Header | 原因 |
|--------|------|
| `Content-Type` | 瀏覽器需要知道回應的資料格式 |
| `Cache-Control` | 控制瀏覽器快取行為 |
| `X-Request-ID` | 若存在，方便前端開發者對應後端日誌除錯 |

---

## 白名單策略的副作用

白名單的安全性優勢有一個對應的維護成本：**API Server 若新增需要特定 request header 的功能，BFF 白名單必須同步更新，否則該功能從瀏覽器觸發時會靜默失效，不會報錯。**

典型情境：

| 情境 | 需要的 Header | 若未加入白名單的結果 |
|------|-------------|-------------------|
| 儲值防重複提交 | `Idempotency-Key` | BFF 捨棄，API Server 收不到，防重複機制失效 |
| 樂觀鎖 / 條件更新 | `If-Match`、`If-None-Match` | BFF 捨棄，API Server 當作無條件更新處理 |
| 前端 trace ID 串接後端日誌 | `X-Request-ID` | BFF 捨棄，無法從前端請求追蹤到後端日誌 |

**工程規範：** 前後端協作新增需要自訂 header 的 API 時，BFF 的 request header 白名單是必須同步更新的清單之一。建議在 API 設計階段即確認，避免功能在整合測試才發現失效。

---

## Request Body 轉發

採用 **Read-and-Resend**（讀取後重送）：

```
body = await request.text()
fetch(apiUrl, { method, headers, body })
```

本專案的 API 皆為 JSON 資料交換，無檔案上傳需求，body 體積可控，無記憶體壓力疑慮。
Stream pipe 雖然對大型 body 更有效率，但在 Next.js Route Handler 的環境中相容性較複雜，不適用於此場景。
