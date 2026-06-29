# 玩家查詢業務邏輯規格書

> **✅ 後端已提供玩家搜尋 / 詳情端點，本規格已對齊真實 OpenAPI（2026-06-29 realignment）**
>
> 後端 `schema/openapi.yaml` 現已定案 `GET /api/cms/players`（搜尋）與 `GET /api/cms/players/{id}`（詳情），
> 對應 schema `PlayerDTO` / `PlayerSearchResult`。前端 [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md)
> 的玩家搜尋與「基本資料卡」可由 mock **抽換為真實串接**，沿用 [`06 §4.4`](./06-topup-records-domain.md) deposit-records
> 的 `cmsRequest` + 手寫 `Raw*` transform 範本。
>
> **仍無後端者**：玩家「儲值彙總（summary）」端點尚未提供，[`09`](./09-screen-player-detail.md) 的彙總卡**維持 mock**
> （見 [`06 §7`](./06-topup-records-domain.md)）。
>
> 端點掛在 `/api/cms`（非 `/api/players`），且後端 v1.12 起已移除 `/api/v1`。本規格 §10 記錄了原臆測契約與真實後端的差異收斂結果。

## 1. 概覽

本文件定義 CMS 後台「玩家查詢」功能的**業務邏輯層**——即與 UI 無關、純資料與契約面的規格。畫面層規格見 [`08-screen-player-search.md`](./08-screen-player-search.md) 與 [`09-screen-player-detail.md`](./09-screen-player-detail.md)。

範圍：

- 玩家在後台的唯一識別策略
- 後台管理員可用的搜尋欄位、比對策略、輸入正規化邊界
- 對應後端 OpenAPI 端點（`GET /cms/players`、`GET /cms/players/{id}`）與 envelope 解開規則
- cursor 分頁、空結果語意
- 與 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) 對接的欄位可見性／遮罩規則
- 錯誤處理（4xx 透傳、5xx 介面化）
- TDD 測試清單

**不在本文件範圍**：

- 儲值紀錄查詢——見 [`06-topup-records-domain.md`](./06-topup-records-domain.md)
- 玩家儲值彙總（summary）——後端尚無端點，仍為 mock，見 [`06 §7`](./06-topup-records-domain.md)
- RBAC 角色定義與稽核事件 schema——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)
- 任何 React Component 或 UI 互動

### 核心原則

- **後端是 source of truth**：所有搜尋比對、輸入正規化（lowercase email、NFC 暱稱、E.164 手機）在後端執行；BFF 不做欄位篩選、不做語意正規化，只負責「trim 後丟空欄位」與 envelope 解開
- **OpenAPI 契約優先**（SDD）：BFF 不對 API 做猜測性呼叫；request/response 形狀對齊後端 `schema/openapi.yaml` 的 `PlayerDTO` / `PlayerSearchResult`
- **欄位命名轉換邊界明確**：後端 `snake_case`，BFF 對外（含 Browser）一律 `camelCase`，轉換集中於 `lib/players/transform.ts`
- **遮罩在後端**：`email` / `phone` 由後端依角色決定回完整值或遮罩字串（viewer 遮罩），BFF 不二次遮罩、不嘗試還原——避免雙重信任問題
- **查詢即稽核事件**：成功的搜尋／詳情讀取由後端寫稽核 log；BFF 透傳足以識別操作者的 context（`Authorization: Bearer <jwt>` + trace header），不負責稽核儲存

---

## 2. 玩家識別

### 2.1 欄位（對齊後端 `PlayerDTO`）

後端 `PlayerDTO` **所有欄位皆顯式輸出**（在 OpenAPI `required` 內、不用 `omitempty`），故「必填」欄一律為「永遠出現」；可空與否看型別的 `| null`。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `playerId` | `string`（UUID，`= members.id`） | 玩家主鍵。所有跨頁、跨 API 引用都用這個，**不使用** Email / 手機等個資作 key |
| `externalId` | `string \| null` | 外部遊戲系統識別碼，後端決定是否暴露 |
| `displayName` | `string` | 顯示用名稱 |
| `email` | `string \| null` | 註冊 Email；viewer 角色遮罩為 `a***@example.com`；無權時為 `null` |
| `phone` | `string \| null` | E.164 格式；viewer 角色遮罩為 `+886***5678`；無權時為 `null` |
| `status` | `'active' \| 'frozen' \| 'closed'` | 帳號狀態。**本期一律 `active`**（後端無變更端點，frozen/closed 為未來範圍），UI 仍應能視覺標示三態 |
| `registeredAt` | `string`（RFC3339 UTC，`= members.created_at`） | 註冊時間 |
| `lastActiveAt` | `string \| null`（RFC3339 UTC） | **本期恆為 `null`**（後端無寫入來源）；UI 須對 null 顯示「—」，不可假設恆有值 |

後端**不暴露** `username` / `password_hash`。

**`playerId` 為唯一安全引用**：URL path、API path、log、稽核事件全部用 `playerId`（UUID）。Email / 手機只在搜尋輸入與顯示用,**禁止**作為任何 path / query 識別子。

### 2.2 與後端欄位的對應

後端 schema（`PlayerLedgerBackend/schema/openapi.yaml`，節錄）：

```yaml
PlayerStatus:
  type: string
  enum: [active, frozen, closed]

PlayerDTO:
  type: object
  required: [player_id, external_id, display_name, email, phone, status, registered_at, last_active_at]
  additionalProperties: false
  properties:
    player_id:      { type: string, format: uuid }
    external_id:    { type: [string, 'null'] }
    display_name:   { type: string }
    email:          { type: [string, 'null'] }   # viewer 遮罩 a***@example.com
    phone:          { type: [string, 'null'] }   # viewer 遮罩 +886***5678
    status:         { $ref: '#/components/schemas/PlayerStatus' }
    registered_at:  { type: string, format: date-time }
    last_active_at: { type: [string, 'null'], format: date-time }

PlayerSearchResult:
  type: object
  required: [players, next_cursor]
  additionalProperties: false
  properties:
    players:     { type: array, items: { $ref: '#/components/schemas/PlayerDTO' } }
    next_cursor: { type: [string, 'null'] }   # opaque keyset cursor；最後一頁為 null
```

轉換層採**手寫 `Raw*` 型別 + camelCase 對應**（與 [`06`](./06-topup-records-domain.md) deposit `transform.ts` 同一範本，**不**使用 openapi-typescript 產生型別——本專案資料層慣例為手寫 raw shape）：

```ts
// src/lib/players/transform.ts
import type { Player, PlayerStatus } from './types'

/** 後端回傳的單筆 raw 形狀（snake_case，對齊 OpenAPI PlayerDTO）。 */
export type RawPlayerDTO = {
  player_id: string
  external_id: string | null
  display_name: string
  email: string | null
  phone: string | null
  status: PlayerStatus
  registered_at: string
  last_active_at: string | null
}

export type RawPlayerSearchResult = {
  players: RawPlayerDTO[]
  next_cursor: string | null
}

export function toPlayer(raw: RawPlayerDTO): Player {
  return {
    playerId:     raw.player_id,
    externalId:   raw.external_id ?? null,
    displayName:  raw.display_name,
    email:        raw.email ?? null,
    phone:        raw.phone ?? null,
    status:       raw.status,
    registeredAt: raw.registered_at,
    lastActiveAt: raw.last_active_at ?? null,
  }
}
```

**不在轉換層做**：日期格式化（交 UI 的 `lib/format/*`）、欄位篩選（後端已依角色控制）、語意正規化（trust 後端）、額外驗證。

---

## 3. 搜尋規格

### 3.1 可用搜尋欄位（對齊後端 `GET /cms/players` query 參數）

| 欄位 | 後端比對策略 | 後端 query param | 約束 |
|------|-------------|-----------------|------|
| 玩家 ID | **精確** | `player_id` | `format: uuid` |
| 外部 ID | **精確** | `external_id` | `maxLength: 64` |
| 暱稱 | **前綴**（大小寫不敏感、NFC 正規化，由後端執行） | `display_name` | `maxLength: 64` |
| Email | **前綴比對**（lowercase，由後端執行） | `email` | `maxLength: 255` |
| 手機 | **正規化後精確比對**（canonical E.164，由後端執行） | `phone` | `maxLength: 32` |

> **語意正規化全在後端**：lowercase email、NFC 暱稱、E.164 手機正規化都是後端責任。BFF **不再**自行 lowercase / strip dashes / NFC——這是相對先前臆測規格（§10）的刻意收斂，避免「前後端各正規化一次、語意不一致」。BFF 對搜尋字串的唯一處理是 **trim + 丟棄空欄位**（見 §3.2）。

### 3.2 組合規則

| 情境 | 行為 |
|------|------|
| 同時帶多個欄位（如 `phone` + `display_name`） | **AND** 組合，後端全部滿足才回 |
| 任何單一欄位 trim 後為空 | 視為「未提供」，不送該欄位給後端 |
| 全部欄位 trim 後都空 | BFF 回 **400 `invalid_input`** `{ error, message: '至少提供一個搜尋欄位' }`——**不打上游**（後端全空亦回 400 `invalid input`，此為省往返的前置檢查） |

`invalid_input` 經 [`normalizeErrorCode`](./02-auth-session.md#後端-error-code-字串格式不一致) 與後端空白形式 `"invalid input"` 視為同一 code。

### 3.3 不支援的搜尋

下列**不在本期範圍**（後端未提供對應 query）：

- 註冊時間區間搜尋（玩家列表不開時間範圍；儲值紀錄列表才有，見 [`06`](./06-topup-records-domain.md)）
- 「狀態為 frozen 的所有玩家」清單瀏覽
- 暱稱 contains（後端只做 prefix）
- 跨欄位 OR 組合
- 排序參數（後端無 `sort`；玩家搜尋預設順序由後端 keyset `(created_at, id)` 決定）

如未來要新增，先更新本規格與後端 OpenAPI 後再實作。

---

## 4. API 契約

### 4.1 端點

```
GET /api/cms/players?<query>          # 搜尋
GET /api/cms/players/{id}             # 詳情（id 為 UUID）
```

- 權限：全 CMS staff（admin / user / viewer）；viewer 的 `email` / `phone` 被遮罩
- BFF 經 `cmsRequest`（`src/lib/api-client/cms.ts`，帶 session access token、注入 trace context、解 envelope）呼叫上游，路徑接在 `baseUrl + cmsBasePath`（`/api`）之後

### 4.2 Query 參數（搜尋）

| 參數 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `player_id` | string(uuid) | 條件必填 | 下列至少一個非空 |
| `external_id` | string | 條件必填 | 同上 |
| `display_name` | string | 條件必填 | 同上 |
| `email` | string | 條件必填 | 同上 |
| `phone` | string | 條件必填 | 同上 |
| `cursor` | string | ❌ | 不透明 keyset cursor，**BFF 原樣透傳、不解析、不驗證字元**（綁定當次搜尋條件；改條件須重置） |
| `limit` | int | ❌ | 1 ≤ limit ≤ 50，預設 `20`；BFF 預設帶 20，超限交後端回 400 |

採 **keyset cursor pagination**（後端底層為 `(created_at, id)`）：

- `cursor` 由後端編碼，BFF / Browser 不解析也不快取
- **無總筆數**：搜尋結果 envelope **不含 `meta`**，無 `total`；前端不顯示「共 N 筆」
- 與 [`06`](./06-topup-records-domain.md) deposit 的 **offset 分頁（page/page_size/meta.total）不同**——玩家搜尋是 cursor，**勿套錯範本**

### 4.3 Response Envelope

搜尋成功（200）——`data` 為含 `next_cursor` 的物件，**無 `meta`**：

```json
{
  "success": true,
  "request_id": "550e8400-...",
  "data": {
    "players": [
      {
        "player_id": "01HABCD-uuid",
        "external_id": null,
        "display_name": "玩家小王",
        "email": "wang@example.com",
        "phone": "+886912345678",
        "status": "active",
        "registered_at": "2025-03-04T10:23:11Z",
        "last_active_at": null
      }
    ],
    "next_cursor": "eyJpZCI6Li4ufQ=="
  }
}
```

- `cmsRequest` 解開 envelope 後回 `{ data }`（搜尋無 `meta`）；`searchPlayers` 取 `data.players.map(toPlayer)`、`data.next_cursor ?? null`
- `next_cursor` 為 `null` 代表沒有下一頁——前端用 `nextCursor != null` 判斷可續頁
- `players` 為空陣列代表查無結果——**不是錯誤**，前端顯示空態（見 [`08`](./08-screen-player-search.md)）

詳情成功（200）——`data` 直接是 `PlayerDTO`：

```json
{ "success": true, "request_id": "...", "data": { /* PlayerDTO 完整欄位 */ } }
```

### 4.4 BFF 端實作分工

```
src/lib/players/
├── search.ts            # searchPlayers(query): Promise<PlayerSearchResult>
├── search.test.ts
├── get.ts               # getPlayer(playerId): Promise<Player>
├── get.test.ts
├── transform.ts         # RawPlayerDTO / RawPlayerSearchResult / toPlayer()
├── transform.test.ts
└── types.ts             # Player / PlayerSearchResult / PlayerSearchQuery（簽章不變）
```

呼叫鏈與 deposit 一致：

```ts
// search.ts —— 防禦性解構（與 06 list.ts 的 `(data ?? [])` 同精神），避免後端
// 異常回 data:null / 缺 players 時 .map 拋 TypeError 蓋掉真正的錯誤
const { data } = await cmsRequest<RawPlayerSearchResult>('/cms/players', { searchParams })
return {
  players: (data?.players ?? []).map(toPlayer),
  nextCursor: data?.next_cursor ?? null,
}

// get.ts
const { data } = await cmsRequest<RawPlayerDTO>(`/cms/players/${encodeURIComponent(playerId)}`)
return toPlayer(data)
```

- `searchPlayers` / `getPlayer` 由 **async Server Component（頁面）直接呼叫**（[`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md) 的 page 是 RSC，已 SSR 拿到 camelCase 結果）
- **不另寫 Route Handler、不走 client 端 transform**：本端點除 envelope 解開 / camelCase 外無額外邏輯，由 `cmsRequest` 在 server 完成；先前臆測規格的「client component 走 BFF proxy 後在前端 transform」路徑**不採用**（§10）
- `cmsRequest` 負責：帶 `Authorization: Bearer <token>`、注入 trace、解 envelope、非 2xx 拋 `ApiError`（code 經 `normalizeErrorCode`，429 帶 `Retry-After`）

---

## 5. 分頁與排序

### 5.1 分頁

- **keyset cursor**：BFF / Browser 不解析 `cursor`；`searchPlayers` 把 `query.cursor` 原樣放進 `searchParams`
- **無總筆數**：搜尋 envelope 無 `meta`，不顯示「共 N 筆」
- **單頁上限 50**：BFF 預設 `limit=20`；> 50 由後端回 400（BFF 不自行 clamp，避免靜默改動使用者意圖）

### 5.2 排序

本期**不開排序參數**（後端無 `sort`）。玩家搜尋順序由後端 keyset `(created_at, id)` 決定；待業務有需求再加並同步更新本規格與後端 OpenAPI。

---

## 6. 欄位可見性與遮罩

**遮罩由後端依操作者角色決定**（viewer 遮罩、admin/user 完整），BFF 只透傳：

| 後端回的值 | BFF 處理 |
|-----------|---------|
| `email: "a***@example.com"`（viewer 遮罩） | 原樣透傳，不還原 |
| `email: null`（無權看） | 透傳 `null`；UI 顯示「—」 |
| `phone: "+886***5678"`（viewer 遮罩） | 原樣透傳 |

**禁止**：

- BFF 自行依 `session` 套遮罩規則——授權邏輯只能有一份，放後端
- 在 log 印出 `email` / `phone`（即使後端回原值）——pino 須 redact,詳見 [`03-observability.md`](./03-observability.md)

完整角色定義、可見欄位矩陣、稽核事件 schema 見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)。

---

## 7. 錯誤處理

### 7.1 BFF 自行處理（不打上游）

| 條件 | HTTP | error code |
|------|------|-----------|
| 全部搜尋欄位 trim 後為空 | 400 | `invalid_input` |

> 相對先前臆測規格**移除**了「limit 超限 / cursor 非 base64url」的 BFF 前置驗證：`limit` 上限與 `cursor` 合法性由後端權威判定（BFF 不解析 opaque cursor），避免重複且可能與後端不一致的驗證。`message` 為人類可讀繁中字串，安全可暴露。

### 7.2 上游錯誤透傳

`cmsRequest` 將非 2xx 轉為 `ApiError(status, normalizeErrorCode(error), message, retryAfter?)`：

- 上游 4xx：`error` code 經 `normalizeErrorCode` 正規化後拋出，前端據此比對
- 上游 401 `unauthorized` / `token_expired`：由 session / `cmsRequest` 層處理（refresh 或拋 401，詳見 [`02 §3.4`](./02-auth-session.md)）
- 上游 5xx：拋對應 `ApiError`，不洩漏 upstream 細節

### 7.3 常見上游錯誤代碼

| HTTP | error（後端空白形式 → normalize 後） | 觸發 |
|------|-------------------------------------|------|
| 400 | `invalid input` → `invalid_input` | schema 驗證失敗（如全空、phone 格式錯） |
| 401 | `unauthorized` | 無有效 session |
| 403 | `forbidden` | 角色無此查詢權限 |
| 404 | `resource not found` → `resource_not_found` | 詳情端點：玩家不存在 |
| 429 | `too many requests` → `too_many_requests` | 後端限流；依 `Retry-After` 退避 |

---

## 8. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | `/cms/players*` 經 `cmsRequest` 走 BFF server-side，不另開 Route Handler |
| [`02-auth-session.md`](./02-auth-session.md) | 所有呼叫需有效 session；refresh / replay 行為由 session 層處理；`normalizeErrorCode` 規則 |
| [`03-observability.md`](./03-observability.md) | **trace**：`apiFetch` 把 W3C traceparent 注入上游 `GET /api/cms/players*` 呼叫，於 X-Ray 形成子 span，以 `X-Request-ID` 串聯（[`03 §4.6`](./03-observability.md)）。**metric**：`http.request.*` 的 `route` 維度須為 **route template** 且在 **BFF inbound 層**發出（[`03 §3.3`](./03-observability.md)）；玩家資料由 RSC 在 server 端經 `cmsRequest` 取得，瀏覽器只請求 **page 路由**（`/players`、`/players/[id]`），故 inbound `route` 維度是 page route，**不是**上游 `/api/cms/players`（後者只現於 trace span，不是 metric 維度）。**redact**：`email`/`phone` 由 `lib/logger/redact-paths.ts`（`*.email`/`*.phone`）自動遮罩 |
| [`06-topup-records-domain.md`](./06-topup-records-domain.md) | 玩家詳情頁「儲值紀錄」入口跳到 06 列表（`?player_id=<id>`），共享 `playerId`；分頁模型不同（cursor vs offset） |
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 角色定義、可見欄位、viewer 遮罩、稽核事件 schema |
| [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md) | 搜尋 / 詳情 UI；09 的「儲值彙總卡」仍 mock（後端無 summary 端點） |

---

## 9. 測試清單（TDD）

依 [`CLAUDE.md`](../../CLAUDE.md) TDD 流程：先依本節建立失敗測試，再抽換 `lib/players/*.ts` 內部（mock → `cmsRequest`）；**簽章與回傳型別不變**，呼叫端（RSC 頁面）不需改。測試**只 mock 外部依賴 `@/lib/api-client/cms`**（seam），不 mock 內部模組——與 [`06`](./06-topup-records-domain.md) `list.test.ts` 同範本。

### 9.1 `src/lib/players/transform.test.ts`

```ts
// PlayerDTO snake_case → camelCase
it('should map player_id, display_name, registered_at to camelCase')
it('should map external_id null to externalId null')
it('should preserve viewer-masked email value verbatim (a***@example.com)')
it('should preserve viewer-masked phone value verbatim (+886***5678)')
it('should map status enum value through without transformation')
it('should map last_active_at null to lastActiveAt null')
```

### 9.2 `src/lib/players/search.test.ts`

```ts
// 必填組合 + trim（BFF 唯一的輸入處理）
it('should throw invalid_input WITHOUT calling cmsRequest when all fields are empty after trim')
it('should trim whitespace from string fields and omit fields that become empty')
it('should NOT lowercase email / NFC display_name / strip phone (backend normalizes)')

// API 呼叫
it('should call cmsRequest with GET /cms/players and only non-empty params')
it('should pass cursor through verbatim without parsing or validating it')
it('should default limit to 20 when not provided and send it as a query param')
it('should forward limit > 50 to the backend (no client-side clamp)')

// 回傳轉換 / cursor
it('should return camelCase Player objects from data.players')
it('should return an empty players array (not throw) when backend returns empty result')
it('should return nextCursor from data.next_cursor')
it('should return nextCursor null when backend returns null next_cursor')

// 錯誤透傳（由 cmsMock reject 模擬）
it('should propagate ApiError(400 invalid_input) thrown by cmsRequest')
it('should propagate ApiError(429) with retryAfter thrown by cmsRequest')
```

### 9.3 `src/lib/players/get.test.ts`

```ts
it('should call cmsRequest with GET /cms/players/{id}')
it('should percent-encode playerId in the path')
it('should return a camelCase Player object from data')
it('should propagate ApiError(404 resource_not_found) from cmsRequest')
it('should propagate ApiError(403 forbidden) from cmsRequest')
```

### 9.4 不在本規格的測試

- `cmsRequest` 本身的 envelope 解開 / token / 429 行為 → 已在 `src/lib/api-client/cms.test.ts`
- UI 狀態（loading、empty、multi-match、ErrorState variant）→ [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md)
- 角色可見性端到端、稽核事件落地 → [`07`](./07-admin-rbac-audit.md) / 後端責任

---

## 10. 臆測契約 → 真實後端：差異收斂（2026-06-29）

> 先前本規格為「前端對後端的需求建議」，後端定案後以下事項已收斂。記錄於此以利追溯，**程式碼以本（已對齊）規格為準**。

| 項目 | 先前臆測 | 真實後端 | 處置 |
|------|---------|---------|------|
| 端點路徑 | `GET /api/players/search`、`/api/players/{id}` | `GET /api/cms/players`、`/api/cms/players/{id}` | 改用 `cmsRequest('/cms/players')` |
| `playerId` 格式 | ULID / UUID / snowflake？ | **UUID**（`= members.id`） | 確定為 UUID |
| 暱稱比對 | 前綴（待確認） | 前綴、大小寫不敏感、NFC（後端） | 後端執行，BFF 不正規化 |
| Email 比對 | 精確 or 前綴 | **前綴、lowercase**（後端） | 後端執行 |
| 手機比對 | 精確、BFF strip dashes、不補 +886 | 正規化後精確（canonical E.164，後端） | BFF **不再** strip / normalize |
| `external_id` 可搜 | 待確認（疑 PII） | **可搜**，精確，maxLength 64 | 開放 |
| `last_active_at` | 真實時間戳 | **本期恆 null**（無寫入來源） | UI 須處理 null |
| `status` | active/frozen/closed | 同；**本期一律 active** | enum 不變 |
| 兩端點 vs 合併 | 待確認 | **兩個獨立端點** | 確定 |
| 分頁 | cursor（無 total） | **keyset cursor**（`(created_at,id)`，無 meta） | 契約相符，無需改 |
| 遮罩 | 依角色 | **僅 viewer 遮罩**；admin/user 完整 | 後端決定 |
| 型別來源 | openapi-typescript generated | 手寫 `Raw*`（專案慣例） | 用手寫 transform |
| 轉換位置 | client 端 transform（部分） | server 端 `cmsRequest`，RSC 直接拿 camelCase | 不走 client transform |
| BFF 前置驗證 | limit/cursor 字元檢查 | 後端權威判定 | 移除，只留「至少一欄」檢查 |

### 仍待後端 / 開放問題

- [ ] 玩家**儲值彙總（summary）** 端點——後端尚無，[`09`](./09-screen-player-detail.md) 彙總卡維持 mock
- [ ] `forbidden` 是否需區分「角色無權」vs「資料分區管控」——目前後端用同一 code，前端無法區分（見 [`07`](./07-admin-rbac-audit.md)）
- [ ] viewer 遮罩格式（`a***@example.com` / `+886***5678`）是否穩定——影響是否需要前端對遮罩字串做任何顯示處理（目前：原樣顯示）
- [ ] **手機本地格式**：使用者輸入無國碼的本地號（如 `0912345678`）時，後端 E.164 canonicalize 是否會補上 `+886`？若否，客服以本地格式搜尋將查無結果——需後端確認，必要時於 [`08`](./08-screen-player-search.md) 表單提示「請含國碼」或前端補碼（但補碼屬語意正規化，原則上仍歸後端）
