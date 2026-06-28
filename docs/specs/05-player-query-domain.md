# 玩家查詢業務邏輯規格書

## 1. 概覽

本文件定義 CMS 後台「玩家查詢」功能的**業務邏輯層**——即與 UI 無關、純資料與契約面的規格。畫面層規格見 [`08-screen-player-search.md`](./08-screen-player-search.md) 與 [`09-screen-player-detail.md`](./09-screen-player-detail.md)。

範圍：

- 玩家在後台的唯一識別策略
- 後台管理員可用的搜尋欄位、比對策略、輸入正規化
- 對應後端 OpenAPI 端點與 envelope 解開規則
- 分頁、排序、空結果語意
- 與 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) 對接的欄位可見性／遮罩規則
- 錯誤處理（4xx 透傳、5xx 介面化）
- TDD 測試清單

**不在本文件範圍**：

- 儲值紀錄查詢——見 [`06-topup-records-domain.md`](./06-topup-records-domain.md)
- RBAC 角色定義與稽核事件 schema——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)
- 任何 React Component 或 UI 互動

### 核心原則

- **後端是 source of truth**：所有搜尋比對在後端執行，BFF 不做欄位篩選或本地過濾
- **OpenAPI 契約優先**（SDD）：BFF 不對 API 做猜測性呼叫；所有 request/response 型別來自 `lib/api-client/generated/types.gen.ts`
- **欄位命名轉換邊界明確**：後端 `snake_case`，BFF 對外（含 Browser）一律 `camelCase`，轉換層集中於 `lib/players/*.ts`
- **遮罩在後端**：敏感欄位（手機尾碼、Email 域名外）由後端依角色決定回什麼，BFF 不二次遮罩——避免「BFF 以為自己遮了、後端原文已洩漏」的雙重信任問題
- **查詢即稽核事件**：任何成功的玩家搜尋／詳情讀取由後端寫入稽核 log；BFF 不負責稽核儲存，但須在 request 中透傳足以識別操作者的 context（`X-Request-ID`、session 中的 `userId`，後者已由 `Authorization: Bearer <jwt>` 隱含）

---

## 2. 玩家識別

### 2.1 欄位

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `playerId` | `string`（ULID 或後端定義的唯一鍵） | ✅ | 玩家在 PlayerLedger 系統內的主鍵。所有跨頁、跨 API 引用都用這個，**不使用** Email / 手機等個資作 key |
| `externalId` | `string \| null` | ❌ | 玩家在遊戲端（外部系統）的識別。可能與遊戲帳號綁定，後端決定是否暴露 |
| `displayName` | `string` | ✅ | 顯示用暱稱，可能與玩家可改的「nickname」不同；遮罩後仍可顯示 |
| `email` | `string \| null` | ❌ | 註冊 Email；依角色可能被遮罩成 `a***@example.com` |
| `phone` | `string \| null` | ❌ | E.164 格式（如 `+886912345678`）；依角色可能只回後 4 碼 |
| `status` | `'active' \| 'frozen' \| 'closed'` | ✅ | 玩家帳號狀態；非「active」不影響查詢但 UI 應視覺標示 |
| `registeredAt` | `string`（ISO 8601 UTC） | ✅ | 註冊時間 |
| `lastActiveAt` | `string \| null`（ISO 8601 UTC） | ❌ | 最近一次玩家端活動時間（後端定義） |

**`playerId` 為唯一安全引用**：URL path、API path、log、稽核事件全部用 `playerId`。Email / 手機只在搜尋輸入與顯示用，**禁止**作為任何 query string / path 參數的識別子。

### 2.2 與後端欄位的對應

OpenAPI Schema 預期：

```yaml
# 由後端維護於 PlayerLedgerBackend，BFF 透過 openapi-typescript 產生型別
components:
  schemas:
    Player:
      type: object
      required: [player_id, display_name, status, registered_at]
      properties:
        player_id:      { type: string }
        external_id:    { type: string, nullable: true }
        display_name:   { type: string }
        email:          { type: string, nullable: true }
        phone:          { type: string, nullable: true }
        status:         { type: string, enum: [active, frozen, closed] }
        registered_at:  { type: string, format: date-time }
        last_active_at: { type: string, format: date-time, nullable: true }
```

轉換層：

```ts
// src/lib/players/transform.ts
import type { components } from '@/lib/api-client/generated/types.gen'

type ApiPlayer = components['schemas']['Player']

export type Player = {
  playerId:      string
  externalId:    string | null
  displayName:   string
  email:         string | null
  phone:         string | null
  status:        'active' | 'frozen' | 'closed'
  registeredAt:  string
  lastActiveAt:  string | null
}

export function toPlayer(api: ApiPlayer): Player {
  return {
    playerId:      api.player_id,
    externalId:    api.external_id ?? null,
    displayName:   api.display_name,
    email:         api.email ?? null,
    phone:         api.phone ?? null,
    status:        api.status,
    registeredAt:  api.registered_at,
    lastActiveAt:  api.last_active_at ?? null,
  }
}
```

**不在轉換層做**：日期格式化（交 UI）、欄位篩選（後端已依角色控制）、額外驗證（trust OpenAPI 型別）。

---

## 3. 搜尋規格

### 3.1 可用搜尋欄位

| 欄位 | 比對策略 | 輸入正規化 | 後端 query param |
|------|---------|-----------|-----------------|
| 玩家 ID | **精確** | trim；保留大小寫 | `player_id` |
| 外部 ID | **精確** | trim；保留大小寫 | `external_id` |
| 暱稱 | **前綴模糊**（後端決定，預設 LIKE `prefix%`） | trim；NFC 正規化 | `display_name` |
| Email | **精確**（完整 email）或**前綴**（`@` 前段） | trim；轉小寫 | `email` |
| 手機 | **精確** | trim；去除空白、`-`、`(`、`)`；不自動補 `+886` | `phone` |

**為何精確而非全文模糊**：

- 後台查詢場景以「客服已知某識別資訊」為主，全文模糊（如 contains）會造成 DB 全表掃描，後端拒絕支援
- 模糊比對僅暱稱開放（業務允許「林**」找出所有以「林」開頭的玩家）

**為何 Email 轉小寫但 `playerId` 不轉**：

- Email 規範上 local-part 大小寫敏感但實務上幾乎都當作不敏感；轉小寫避免「`Alice@x.com` 找不到 `alice@x.com`」的常見誤判
- `playerId` 是系統產生的 ULID / UUID，**大小寫敏感**且不可預期玩家會手動輸入

### 3.2 組合規則

| 情境 | 行為 |
|------|------|
| 同時帶多個欄位（如 `phone` + `display_name`） | **AND** 組合，後端必須全部滿足 |
| 任何單一欄位 trim 後為空 | 視為「未提供」，不送該欄位給後端 |
| 全部欄位都空 | BFF 回 **400 `invalid_input`** `{ error: 'invalid_input', message: '至少提供一個搜尋欄位' }`——不打上游 |

`invalid_input` 採後端既有 error code 字串格式（含空白形式 `"invalid input"` 變體；參照 [`02-auth-session.md`](./02-auth-session.md#後端-error-code-字串格式不一致) 的 `normalizeErrorCode` 規則）。

### 3.3 不支援的搜尋

下列**不在 v1 範圍**——若客服要求請走「客服支援工具」或工單系統：

- 註冊時間區間搜尋（玩家列表不開時間範圍篩選；儲值紀錄列表才有）
- 「狀態為 frozen 的所有玩家」清單瀏覽
- 全文模糊（暱稱 contains 而非 prefix）
- 跨欄位 OR 組合

如未來要新增，先更新本規格與後端 OpenAPI Schema 後再實作。

---

## 4. API 契約

### 4.1 端點

```
GET /api/v1/players/search?<query>
```

> **後端尚未實作**：本端點為新功能契約建議；BFF 在後端確認 schema 前不得 mock 上游或假呼叫。實作時應以 backend schema 為準，本節描述為「我們對後端的要求」。

### 4.2 Query 參數

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `player_id` | string | 條件必填 | 與下方任一同時至少有一個 |
| `external_id` | string | 條件必填 | 同上 |
| `display_name` | string | 條件必填 | 同上 |
| `email` | string | 條件必填 | 同上 |
| `phone` | string | 條件必填 | 同上 |
| `cursor` | string | ❌ | 下一頁游標（後端不透明字串，BFF 不解析） |
| `limit` | int | ❌ | 1 ≤ limit ≤ 50，預設 `20`；超過上限後端回 400 |

採 **cursor-based pagination** 而非 offset/limit：

- 後端資料量級可能很大，offset pagination 在深層分頁效能急遽下降
- cursor 由後端編碼（不透明字串），BFF / Browser 不解析也不快取
- 沒有「總筆數」欄位——後台不需顯示「共 12,345 筆」（後端 admin 規模通常無此語義也無此 SQL 成本預算）

### 4.3 Response Envelope

成功（200）：

```json
{
  "success": true,
  "request_id": "550e8400-...",
  "data": {
    "players": [
      {
        "player_id": "01HABCD...",
        "external_id": null,
        "display_name": "玩家小王",
        "email": "wang@example.com",
        "phone": "+886912345678",
        "status": "active",
        "registered_at": "2025-03-04T10:23:11Z",
        "last_active_at": "2026-06-26T08:11:00Z"
      }
    ],
    "next_cursor": "eyJpZCI6Li4ufQ==" 
  }
}
```

BFF 對 Browser 的回應（解開 envelope、camelCase 後）：

```json
{
  "players": [
    {
      "playerId": "01HABCD...",
      "externalId": null,
      "displayName": "玩家小王",
      "email": "wang@example.com",
      "phone": "+886912345678",
      "status": "active",
      "registeredAt": "2025-03-04T10:23:11Z",
      "lastActiveAt": "2026-06-26T08:11:00Z"
    }
  ],
  "nextCursor": "eyJpZCI6Li4ufQ=="
}
```

- `next_cursor` 為 `null`（或缺失）代表沒有下一頁——前端用 `nextCursor != null` 判斷可繼續分頁
- `players` 為空陣列代表查無結果——不是錯誤，前端應顯示「空態」（見 [`08`](./08-screen-player-search.md) §結果列表）
- BFF 解開 envelope 後**不再對 Browser 透傳** `success / request_id`，後者改以 `X-Request-ID` response header 暴露（沿用 [`02 §1`](./02-auth-session.md#1-概覽) 慣例）

### 4.4 BFF 端實作分工

```
src/lib/players/
├── search.ts            # searchPlayers(query): Promise<PlayerSearchResult>
├── search.test.ts
├── get.ts               # getPlayer(playerId): Promise<Player>
├── get.test.ts
├── transform.ts         # toPlayer() / toSearchResult()
├── transform.test.ts
└── types.ts             # Player / PlayerSearchResult / PlayerSearchQuery 型別
```

- `search.ts` 由 Route Handler / Server Component 直接呼叫；不在 client component 呼叫（client component 透過 `/api/players/search` proxy）
- 與 Browser 對接的 `/api/players/search` 由 BFF Proxy（`app/api/[...path]/route.ts`，[`01 §4.2`](./01-bff-architecture.md)）自動接管，**不另外寫 Route Handler**——本端點除了 envelope 解開／camelCase 轉換外無額外邏輯，由 client component 接到 raw response 後在前端轉換較合理

> **轉換層放在 client 或 BFF？** v1 採「**Server Component 用 `lib/players/search.ts` 已轉換**；Client Component 走 BFF proxy 直接拿 snake_case envelope 後在前端 transform」——避免 BFF 為單一端點寫專用 Route Handler，又確保 SSR 路徑型別純淨。Client 端的 transform 共用 `src/lib/players/transform.ts`。

### 4.5 Player 詳情端點

```
GET /api/v1/players/{player_id}
```

Response（200）：

```json
{
  "success": true,
  "request_id": "...",
  "data": { /* Player 完整欄位 */ }
}
```

錯誤：

- `404 resource not found`（含空白形式）：玩家不存在
- `403 forbidden`：操作者無權限查看該玩家（見 [`07`](./07-admin-rbac-audit.md)）

---

## 5. 分頁與排序

### 5.1 分頁

詳見 §4.2 / §4.3。重點：

- **cursor-based**：BFF / Browser 不解析 `cursor` 內容
- **無總筆數**：後端不回 `total`，前端不顯示「共 N 筆」
- **單頁上限 50**：與後端對齊；前端不允許 `limit > 50`，超過 BFF 直接回 400

### 5.2 排序

v1 **不開排序參數**：

- 後端預設依「相關性 + `registered_at desc`」回傳（後端決定）
- 加排序會擴大後端 SQL index 需求；待業務有明確需求再加，並同步更新本規格

---

## 6. 欄位可見性與遮罩

**遮罩由後端依操作者角色決定**，BFF 只透傳。本節只說明 BFF 對遮罩結果的處理：

| 後端回的值 | BFF 處理 |
|-----------|---------|
| `email: "a***@example.com"`（已遮罩） | 原樣透傳，不嘗試還原 |
| `email: null`（角色無權看） | 透傳 `null`；UI 顯示「—」 |
| `phone: "****5678"`（後 4 碼） | 原樣透傳 |

**禁止**：

- BFF 自行根據 `session.userId` 套規則決定遮不遮——授權邏輯只能有一份，放後端
- 在 log 中印出未遮罩欄位（即使後端回的是原值）——pino logger 須對 `email` / `phone` 自動 redact，詳見 [`03-observability.md`](./03-observability.md)

完整角色定義、可見欄位矩陣、稽核事件 schema 見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)。

---

## 7. 錯誤處理

### 7.1 BFF 自行處理（不打上游）

| 條件 | HTTP | error code |
|------|------|-----------|
| 全部搜尋欄位空 | 400 | `invalid_input` |
| `limit` 超過 50 或非整數 | 400 | `invalid_input` |
| `cursor` 含非 base64url 字元 | 400 | `invalid_input` |

`message` 欄位為人類可讀繁中字串，安全可暴露給 Browser。

### 7.2 上游錯誤透傳

依 [`01 §4.2 錯誤回應 shape`](./01-bff-architecture.md)：

- 上游 4xx：body **原樣透傳**——前端用 `normalizeErrorCode` 比對
- 上游 5xx：BFF 回 502 `upstream_failure` 或 504 `upstream_timeout`，不洩漏 upstream 細節
- 上游 401 `unauthenticated` / `token_expired`：由 BFF Proxy 統一處理（觸發 refresh 或踢回 login，詳見 [`02 §3.4`](./02-auth-session.md)）

### 7.3 常見上游錯誤代碼

| HTTP | error | 觸發 |
|------|-------|------|
| 400 | `invalid_input` | 後端 schema 驗證失敗（如 phone 格式錯） |
| 403 | `forbidden` | 操作者角色無此查詢權限 |
| 404 | `resource not found` | 詳情端點：玩家不存在 |
| 429 | `too many requests` | 後端限流；Browser 應依 `Retry-After` 退避 |

前端對 `forbidden` 須區分「無權查任何玩家」（顯示頁面層的 403）與「該玩家被分區管控」（顯示行內錯誤）——後者由 [`07`](./07-admin-rbac-audit.md) 角色設計決定，本規格不深入。

---

## 8. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | 本功能所有 `/api/players/*` 走 BFF Proxy；不另開 Route Handler |
| [`02-auth-session.md`](./02-auth-session.md) | 所有呼叫需有效 session；refresh / replay 行為由 session 層處理 |
| [`03-observability.md`](./03-observability.md) | Search／detail 呼叫的 metric tag：`route=/api/players/search`、`route=/api/players/{id}`；個資欄位 redact 規則 |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 角色定義、可見欄位、稽核事件 schema |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 玩家詳情頁的「儲值紀錄」入口跳到 06 的列表頁；雙方共享 `playerId` |

---

## 9. 測試清單（TDD）

依 [`CLAUDE.md`](../../CLAUDE.md) TDD 流程：先依本節建立失敗測試，再實作 `lib/players/*.ts`。

### 9.1 `src/lib/players/transform.test.ts`

```ts
// Player snake_case → camelCase
it('should map player_id, display_name, registered_at to camelCase')
it('should map external_id null to externalId null')
it('should preserve masked email value verbatim (a***@example.com)')
it('should map status enum value through without transformation')
it('should map last_active_at null to lastActiveAt null')

// Search result envelope
it('should map next_cursor to nextCursor and preserve null')
it('should return empty players array when API returns empty array')
```

### 9.2 `src/lib/players/search.test.ts`

```ts
// 輸入正規化
it('should trim whitespace from all string query fields before calling upstream')
it('should lowercase email before calling upstream')
it('should NOT lowercase player_id (case-sensitive)')
it('should strip whitespace, dashes, and parens from phone before calling upstream')
it('should NFC-normalize display_name before calling upstream')

// 必填組合
it('should throw invalid_input when all search fields are empty after trim')
it('should send only non-empty fields to upstream (omit empty ones from query string)')

// 分頁
it('should default limit to 20 when not provided')
it('should reject limit > 50 with invalid_input before calling upstream')
it('should reject limit < 1 with invalid_input')
it('should reject non-integer limit with invalid_input')
it('should reject cursor containing non base64url characters with invalid_input')

// API 呼叫
it('should call GET /players/search with correct query parameters')
it('should include Authorization: Bearer <token> from session')
it('should return camelCase Player objects')
it('should return nextCursor null when upstream returns null next_cursor')
it('should return nextCursor null when upstream omits next_cursor field')

// 錯誤透傳
it('should pass through upstream 400 invalid_input body unchanged')
it('should pass through upstream 429 with Retry-After header')
it('should NOT include upstream stack trace in error response')
```

### 9.3 `src/lib/players/get.test.ts`

```ts
it('should call GET /players/{playerId} with the given id')
it('should percent-encode playerId in path before calling upstream')
it('should return camelCase Player object')
it('should propagate 404 resource_not_found from upstream')
it('should propagate 403 forbidden from upstream')
it('should treat "resource not found" (space-form) and "resource_not_found" (snake) as the same code via normalizeErrorCode')
```

### 9.4 BFF proxy 行為（已在 `01 §4.3` 覆蓋，本節不重複）

`/api/players/*` 走 `app/api/[...path]/route.ts`，proxy 行為的測試在 [`01 §4.3`](./01-bff-architecture.md)；本規格只負責 transform / search / get 三個 unit 的測試。

### 9.5 不在本規格的測試

- UI 狀態（loading、empty、multi-match）→ 見 [`08`](./08-screen-player-search.md) §測試清單
- 角色可見性的端到端驗證 → 見 [`07`](./07-admin-rbac-audit.md) §測試清單
- 稽核事件落地 → 後端責任，本規格不測

---

## 10. 開放問題（TODO，需與後端確認後更新）

> 以下事項在實作前必須與後端確認，敲定後**更新本規格**而非在程式碼中假設。

- [ ] `player_id` 確切格式（ULID? UUID? snowflake?）——影響輸入驗證 regex
- [ ] 暱稱搜尋是否為前綴或 contains——影響 §3.1 表格與測試
- [ ] `cursor` 是否會跨資料變動失效（如玩家新增）——影響前端是否需要「結果可能變動」提示
- [ ] 後端是否真的提供 `/players/search` 與 `/players/{id}` 兩端點，或合併為單一端點
- [ ] `external_id` 是否真的開放搜尋（部分系統視為 PII）
- [ ] `forbidden` 在 BFF 是否需區分「session 內角色」vs「資料分區」——目前假設後端用同一 code，前端無法區分
