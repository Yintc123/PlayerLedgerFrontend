# 儲值紀錄業務邏輯規格書

## 1. 概覽

本文件定義 CMS 後台「儲值紀錄（Deposit Records）」功能的**業務邏輯層**。畫面層規格見 [`10-screen-topup-list.md`](./10-screen-topup-list.md) 與 [`11-screen-topup-detail.md`](./11-screen-topup-detail.md)。

> **後端契約已定案（2026-06）**：本文件先前的端點設計為前端推測，已依後端 `schema/openapi.yaml`、
> `deposit-records-api.md`、`deposit-records-model.md` 重整。重點變動：
> - 端點**無版本前綴**（`/api/...`，不再有 `/api/v1`）。
> - 儲值紀錄為**扁平資源** `/api/cms/deposit-records`（+ `/{id}`），**不**巢狀於 `/players/{id}/...`。
> - 分頁改為 **OFFSET**（`page` / `page_size` + `meta.total`），不再是 cursor。
> - 狀態 enum 用 `completed`（不是 `success`）。
> - 後端**目前無**玩家儲值彙總（summary）與匯出（CSV/export）端點——見 §7、§8。

範圍：

- 儲值紀錄資料模型（`DepositRecord`）與狀態機
- CMS 列表查詢（`player_id` / 日期區間 / 狀態 / 支付方式篩選、OFFSET 分頁）
- 建立（POST）與更新狀態／備註（PATCH）
- 排序與分頁
- 單筆明細
- 玩家層級彙總統計（§7，**後端尚無端點**）
- 匯出 CSV（§8，**後端尚無端點**）
- TDD 測試清單

**不在本文件範圍**：

- 玩家識別與搜尋——見 [`05-player-query-domain.md`](./05-player-query-domain.md)
- 角色權限與稽核事件結構——見 [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md)
- 退款／補單／重發等複雜寫入流程（v1 僅 PATCH 狀態轉換）

### 核心原則

- **扁平資源 + `player_id` 篩選**：CMS 列表為跨玩家的扁平資源 `/api/cms/deposit-records`，以 `player_id` query 參數聚焦特定玩家（非 path 巢狀）。玩家自助端點 `/api/me/deposit-records` 則由 token `claims.sub` 自動繫結，caller 不可指定
- **金額單位明確**：所有金額欄位以**整數最小貨幣單位**傳輸（見 §2.1 各幣別規則：TWD→元、USD→cent、JPY→円）。**禁止**用 float 表示金額
- **時間統一 UTC**：所有時間欄位以 RFC 3339 / ISO 8601 UTC 字串傳遞；時區轉換在 UI 層完成
- **狀態唯一來源是後端**：BFF 不嘗試本地推斷「pending 太久 = failed」之類，全部依後端 `status` 欄位；狀態轉換合法性由後端 PATCH 強制（非法轉換回 `422 invalid_transition`）
- **server 自動填入不可偽造**：`player_name`（後端從 members 查）、`operator_id`（token）、`operator_ip`（ClientIP）由後端填入，caller 不得指定

---

## 2. 資料模型

### 2.1 `DepositRecord` 欄位（CMS 端，camelCase 後）

對應後端 `DepositRecord`（CMS 端完整欄位）。前端轉換為 camelCase 後對應如下：

| 欄位 | 後端欄位 | 型別 | 必填 | 說明 |
|------|---------|------|------|------|
| `id` | `id` | `string`（UUID） | ✅ | PlayerLedger 內部主鍵；URL/log/稽核唯一引用 |
| `playerId` | `player_id` | `string`（UUID） | ✅ | 對應 [`05`](./05-player-query-domain.md) `Player.playerId`；引用 members |
| `playerName` | `player_name` | `string` | ✅ | 建立當下從 members 取得的快照（server 自動填入）|
| `amount` | `amount` | `integer`（int64） | ✅ | **幣別最小單位**整數（見下方幣別規則）；以整數表示，避免浮點誤差 |
| `currency` | `currency` | `string` | ✅ | ISO 4217 三字母代碼；後端目前 DB CHECK 僅允許 `TWD`（預設） |
| `status` | `status` | `'pending' \| 'completed' \| 'failed' \| 'cancelled' \| 'refunded'` | ✅ | 見 §2.2 狀態機 |
| `paymentMethod` | `payment_method` | `'bank_transfer' \| 'credit_card' \| 'manual' \| 'convenience_store' \| 'e_wallet'` | ✅ | 後端 enum 白名單；前端不寫死，從 OpenAPI 取 |
| `operatorId` | `operator_id` | `string \| null`（UUID） | ❌ | 建立此筆的 CMS staff（server 填入）；預留 null 給未來自動入帳 |
| `operatorIp` | `operator_ip` | `string \| null` | ❌ | 建立時的操作者 IP（server 從 ClientIP 擷取） |
| `internalNote` | `internal_note` | `string \| null` | ❌ | staff 內部備註，**不對玩家顯示**；上限 2000 字元 |
| `displayNote` | `display_note` | `string \| null` | ❌ | 可對玩家顯示的說明；上限 500 字元 |
| `referenceNo` | `reference_no` | `string \| null` | ❌ | 金流商外部交易號；若提供則唯一；上限 128 字元 |
| `createdAt` | `created_at` | `string`（RFC 3339 UTC） | ✅ | 建立時間 |
| `updatedAt` | `updated_at` | `string`（RFC 3339 UTC） | ✅ | 最後異動時間 |

> **後端模型不含**：`order_id`、`payment_channel`、`failure_reason`、`paid_at`、`refunded_at`。
> 先前版本的這些欄位皆為前端推測，已移除。時間軸只能由 `createdAt` + `updatedAt` + `status` 推導（見 [`11 §4.4`](./11-screen-topup-detail.md)）。

> **幣別最小單位規則**：`amount` 以該幣別最小單位的整數表示，**但小數位數依幣別而非 ISO 4217 預設**：
> - `TWD` → **元**（0 位小數，1000 元 = `1000`）— 注意 TWD 非 ISO 的 2 位
> - `USD` → **cent**（2 位小數，$10.50 = `1050`）
> - `JPY` → **円**（0 位小數，500 円 = `500`）
>
> `currency` 欄位決定如何解讀 `amount`；UI 顯示時依此規則用 `Intl.NumberFormat` 還原。JavaScript `number` 對
> `0.1 + 0.2` 會誤差，金額用 float 在後台對帳是**直接事故**——整數最小單位與後端 / 資料庫對齊。

### 2.2 狀態機

```
              建立
               │
            pending
          /    |    \
   completed   |   failed
        │   cancelled
     refunded
```

| 從 \ 到 | pending | completed | failed | cancelled | refunded |
|---|---|---|---|---|---|
| pending | — | ✅ | ✅ | ✅ | ❌ |
| completed | ❌ | — | ❌ | ❌ | ✅ |
| failed | ❌ | ❌ | — | ❌ | ❌ |
| cancelled | ❌ | ❌ | ❌ | — | ❌ |
| refunded | ❌ | ❌ | ❌ | ❌ | — |

| 來源 | 可轉至 | BFF 顯示 |
|------|------|---------|
| pending | completed / failed / cancelled | completed：綠 tag；failed：紅 tag；cancelled：灰 tag |
| completed | refunded | 紅 tag「已退款」 |
| failed / cancelled / refunded | （終態） | 不可再轉換；BFF 不顯示「重試」之類動作 |

- `failed`、`cancelled`、`refunded` 為**終態**。
- `cancelled` 用於更正建立錯誤（如金額或玩家填錯）。
- 合法性由後端 PATCH 強制；非法轉換回 `422 invalid_transition`（見 §4.4）。

**BFF 不做的事**：

- 不過濾 `pending`（即使 pending 超過 24h）——僅顯示 + 由 UI 提示「狀態未完成」
- 不在前端推斷或攔截狀態轉換——交由後端 PATCH 驗證

### 2.3 後端對應與轉換

```yaml
# OpenAPI（後端維護於 schema/openapi.yaml）
components:
  schemas:
    DepositRecord:
      type: object
      required: [id, player_id, player_name, amount, currency, status, payment_method, created_at, updated_at]
      properties:
        id:             { type: string, format: uuid }
        player_id:      { type: string, format: uuid }
        player_name:    { type: string }
        amount:         { type: integer, format: int64 }
        currency:       { type: string }
        status:         { type: string, enum: [pending, completed, failed, cancelled, refunded] }
        payment_method: { type: string, enum: [bank_transfer, credit_card, manual, convenience_store, e_wallet] }
        operator_id:    { type: string, format: uuid }
        operator_ip:    { type: string }
        internal_note:  { type: string }
        display_note:   { type: string }
        reference_no:   { type: string }
        created_at:     { type: string, format: date-time }
        updated_at:     { type: string, format: date-time }
```

玩家自助端點（`/api/me/deposit-records`）回傳 `DepositRecordPublic`，**不暴露** `operator_*`、`internal_note`、
`reference_no`、`player_id`、`player_name`，欄位為 `id` / `amount` / `currency` / `status` / `payment_method` /
`display_note` / `created_at`。

轉換層放 `src/lib/topups/transform.ts`，規則同 [`05 §2.2`](./05-player-query-domain.md)：snake_case → camelCase、`null` 透傳、不在 transform 層做格式化。

---

## 3. 列表查詢

> **實作現況（2026-06，已串接真後端）**：`lib/topups/{list,get,create}.ts` 已改為**呼叫真後端** `/api/cms/deposit-records*`（經 `@/lib/api-client/cms` 的 `cmsRequest`：從 session 取 access token → `apiFetch` → 解 envelope `{data,meta}` → `transform.ts` snake→camel → 非 2xx 映射 `ApiError`，429 帶 Retry-After）。需後端在線 + 有效登入 session。`updateDeposit` 尚未實作（無呼叫端）。
>
> **仍為 mock（後端無對應端點）**：`searchPlayers`（[`08`](./08-screen-player-search.md)）、`getPlayer`（[`09`](./09-screen-player-detail.md)）、`getPlayerTopupSummary` —— 後端 OpenAPI 無玩家搜尋/詳情/彙總端點（僅有 `members` 表供 deposit-records join），故維持 `src/lib/mock/dataset.ts`，待後端補端點後再串。錯誤觸發字串（`forbidden`/`notfound`/...）僅這些 mock 函式仍適用。

### 3.1 端點

```
GET /api/cms/deposit-records?<query>          # CMS 列表（全 CMS staff）
```

**為何用扁平資源 + `player_id` 篩選**（後端定案）而非 `/players/{id}/topups` 巢狀：

- 後端將儲值紀錄設計為獨立資源 `deposit_records`，CMS 後台需跨玩家檢視（如「列出所有 pending」）
- 聚焦特定玩家以 `?player_id=<uuid>` query 參數達成，非 path 巢狀
- 行級授權由 token `claims.utype == cms` + role 控制，不依賴 path 變數

> 玩家自助端點為 `GET /api/me/deposit-records`，`player_id` 由 token `claims.sub` 自動決定，caller 不可指定——非本 CMS 規格範圍，畫面屬玩家端 app。

### 3.2 Query 參數（CMS 列表）

| 參數 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `page` | integer | `1` | 1-based |
| `page_size` | integer | `20` | 上限 100；> 100 → 400 |
| `player_id` | string（UUID） | — | 篩特定玩家 |
| `status` | string（可重複） | — | 可重複出現做 **OR** 篩選（`?status=pending&status=failed`）；每值須在 enum 白名單 |
| `payment_method` | string（可重複） | — | 同上，可重複做 OR 篩選 |
| `start_date` | date（`YYYY-MM-DD`） | — | `created_at >= start_date 00:00:00 UTC` |
| `end_date` | date（`YYYY-MM-DD`） | — | `created_at <= end_date 23:59:59 UTC`；不可早於 `start_date` |
| `sort` | `'created_at' \| '-created_at' \| 'amount' \| '-amount'` | `-created_at` | 見 §4 |

**多值參數編碼**：**重複 key**（`?status=pending&status=failed`）而非逗號分隔——對齊後端 OpenAPI（`type: array`，重複出現做 OR）。前端序列化多值篩選時須以重複 key 輸出。

**日期區間驗證**：

- `end_date < start_date` → 後端回 400 `invalid input`；前端亦可先行 client 驗證避免無謂往返
- 後端以 `start_date` 視為當日 00:00:00 UTC、`end_date` 視為當日 23:59:59 UTC 解讀（含端點）
- 後端允許僅給單邊（僅 `start_date` 或僅 `end_date`）；前端篩選 UI 仍可選擇成對輸入以簡化操作

### 3.3 Response

成功（200）：

```json
{
  "success": true,
  "request_id": "...",
  "data": [
    {
      "id": "0193b3f4-1234-7abc-9def-000000000001",
      "player_id": "0193b3f4-1234-7abc-9def-000000000002",
      "player_name": "玩家小王",
      "amount": 1000,
      "currency": "TWD",
      "status": "completed",
      "payment_method": "bank_transfer",
      "operator_id": "0193b3f4-1234-7abc-9def-000000000003",
      "operator_ip": "192.0.2.1",
      "internal_note": "客服補單",
      "display_note": "銀行轉帳儲值",
      "reference_no": "TXN-20260629-001",
      "created_at": "2026-06-20T03:11:22Z",
      "updated_at": "2026-06-20T03:12:00Z"
    }
  ],
  "meta": { "page": 1, "page_size": 20, "total": 137 }
}
```

- `data` 為 `DepositRecord` 陣列（直接掛在 envelope `data`，非 `data.records`）。
- `meta` 含 `page` / `page_size` / `total`（OFFSET 分頁總筆數）。
- BFF 對 Browser：解開 envelope + camelCase（同 [`05 §4.3`](./05-player-query-domain.md)），`meta` 一併轉為 camelCase。

### 3.4 BFF 端實作分工

```
src/lib/topups/
├── list.ts              # listDeposits(query): Promise<DepositListResult>   // 含 meta {page,pageSize,total}
├── list.test.ts
├── get.ts               # getDeposit(id): Promise<DepositRecord>
├── get.test.ts
├── create.ts            # createDeposit(input): Promise<DepositRecord>      // POST，admin/user
├── create.test.ts
├── update.ts            # updateDeposit(id, input): Promise<DepositRecord>  // PATCH，admin
├── update.test.ts
├── transform.ts
├── transform.test.ts
└── types.ts
```

> **實作現況**：`list`/`get`/`create` 已串接真後端（`cmsRequest` + `transform`，見 §3 開頭）；`update` 尚未實作（無呼叫端）。

---

## 4. 排序

| sort 值 | 後端行為 |
|---------|---------|
| `-created_at`（預設） | 新到舊 |
| `created_at` | 舊到新 |
| `-amount` | 大額在前 |
| `amount` | 小額在前 |

- sort 白名單由後端驗證；非白名單值回 400 `invalid input`。
- **金額排序未指定幣別**：後端目前 DB CHECK 僅允許 `TWD`，跨幣別排序問題暫不存在；未來開放多幣別時再評估。

---

## 5. 分頁（OFFSET）

後端採 **OFFSET 分頁**：`page`（1-based）+ `page_size`（上限 100，預設 20），回應 `meta { page, page_size, total }`。

- 有總筆數 `total`：UI 可顯示「共 N 筆」與頁碼／「載入更多」（`page * page_size < total` 時仍有下一頁）。
- 前端 `DepositListResult` 應保留 `meta`，供 [`10 §6`](./10-screen-topup-list.md) 分頁判斷。
- 玩家自助端點 `/api/me/deposit-records` 同為 OFFSET，但 `page_size` 上限 50（降低大量拉取風險）。

---

## 6. 單筆明細

```
GET /api/cms/deposit-records/{id}
```

- 回 `DepositRecord` 完整欄位（同 §2.1）；path 僅需 `id`（UUID），**不**需 `player_id`。
- 404 `resource not found`：紀錄不存在。
- 403 `forbidden`：非 CMS staff（見 [`07`](./07-admin-rbac-audit.md)）。

---

## 6A. 建立（POST）

```
POST /api/cms/deposit-records          # 權限：admin / user（viewer 不可）
```

**Request Body**：

```json
{
  "player_id":      "0193b3f4-1234-7abc-9def-000000000002",
  "amount":         1000,
  "currency":       "TWD",
  "payment_method": "bank_transfer",
  "internal_note":  "客服補單，玩家提供匯款收據",
  "display_note":   "銀行轉帳儲值",
  "reference_no":   "TXN-20260629-001"
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `player_id` | ✅ | 必須存在於 members 表 |
| `amount` | ✅ | 正整數；幣別最小單位（§2.1 規則，TWD=元）|
| `currency` | ❌ | 預設 `TWD`；3 字元 ISO 4217 |
| `payment_method` | ✅ | enum 白名單 |
| `internal_note` | ❌ | 上限 2000；不對玩家顯示 |
| `display_note` | ❌ | 上限 500 |
| `reference_no` | ❌ | 上限 128；若提供則檢查唯一性 |

- `status` 固定初始為 `pending`；`player_name` / `operator_id` / `operator_ip` 由 server 填入，caller 不得指定。
- 回 `201 Created` + `DepositRecord`。
- 錯誤：`400 invalid input`、`403 forbidden`（viewer）、`404 resource not found`（player_id 不存在）、`409 resource already exists`（reference_no 重複）、`429`。

> 對應前端 `createDeposit(input)`，由螢幕 10「建立儲值」表單呼叫（[`10`](./10-screen-topup-list.md)）。**實作現況：已串真後端**（POST snake_case body）。

---

## 6B. 更新狀態 / 備註（PATCH）

```
PATCH /api/cms/deposit-records/{id}    # 權限：admin only
```

**Request Body**（至少提供一欄）：

```json
{
  "status":        "completed",
  "internal_note": "金流商已確認入帳，單號 ABC-123",
  "display_note":  "儲值已完成"
}
```

| 欄位 | 說明 |
|------|------|
| `status` | 目標狀態；合法轉換見 §2.2 |
| `internal_note` | **三態語意**：傳值=設定、`null`=清空、缺席=不修改；上限 2000 |
| `display_note` | 同上三態語意；上限 500 |

- `amount` / `currency` / `player_id` / `payment_method` 建立後不可修改，PATCH 不接受。
- 非法狀態轉換回 `422 invalid_transition`。
- 並發更新採 last-write-wins。
- 回 `200 OK` + 更新後 `DepositRecord`。
- 錯誤：`400 invalid input`（空 body）、`403 forbidden`（非 admin）、`404`、`422 invalid_transition`、`429`。

> 對應前端 `updateDeposit(id, input)`。狀態轉換 UI 與權限細節屬後續螢幕規格。**實作現況：mock**。

---

## 7. 玩家儲值彙總

> **後端目前無此端點**：OpenAPI 未提供玩家儲值彙總（summary）端點。先前的 `GET /players/{id}/topups/summary`
> 與 `TopupSummary` 形狀為前端推測，後端尚未實作。
>
> **前端處置**：螢幕 09（[`09`](./09-screen-player-detail.md)）的「儲值彙總卡」**暫以 mock 呈現**；標記為
> **「待後端新增 summary 端點」**。需向後端要求新增 members 儲值彙總端點後，再回頭定案本節契約形狀
> （`totalsByCurrency` / `refundRate` 等由後端決定，前端不在 client 算）。

下方為**待後端確認**的建議形狀（非現行契約）：

```ts
// ⚠️ 待後端提供 summary 端點後定案；目前僅供 mock / UI 佔位參考
type TopupSummary = {
  playerId:            string
  totalsByCurrency: Array<{
    currency:          string
    completedCount:    number        // 完成筆數
    completedAmount:   number        // 完成總額（最小貨幣單位）
    refundedCount:     number
    refundedAmount:    number
    failedCount:       number
    refundRate:        number        // 後端算好，避免前端浮點誤差
  }>
  firstTopupAt:        string | null
  lastTopupAt:         string | null
  lifetimeDays:        number | null
}
```

---

## 8. 匯出 CSV

> **後端目前無匯出端點**：OpenAPI 未提供任何 CSV / export 端點（同步或 async job 皆無）。
> 先前 §8 的同步匯出、async job、`/exports/{job_id}` 等皆為前端推測設計，後端尚未實作。
>
> **前端處置**：**已移除匯出功能**——螢幕 10（[`10`](./10-screen-topup-list.md)）不再渲染匯出按鈕／Modal，
> `lib/topups/export.ts` 不再是契約的一部分。標記為**「待後端提供匯出端點」**；屆時再回頭設計
> 同步 vs async、CSV 欄位、稽核事件（`topups.export`）等。

---

## 9. 錯誤處理

### 9.1 BFF 自行處理

| 條件 | HTTP | error |
|------|------|-------|
| `end_date < start_date` | 400 | `invalid input` |
| `page_size > 100` 或 `< 1` | 400 | `invalid input` |
| `status` / `payment_method` 值不在 enum 白名單 | 400 | `invalid input` |
| `sort` 不在白名單 | 400 | `invalid input` |

> 前端可先行驗證以避免無謂往返；最終仍以後端驗證為準（後端對 query 嚴格驗證）。

### 9.2 上游透傳

依 [`01 §4.2`](./01-bff-architecture.md) 與 [`05 §7.2`](./05-player-query-domain.md)。常見：

- 403 `forbidden`：非 CMS staff，或 viewer 嘗試 POST / 非 admin 嘗試 PATCH
- 404 `resource not found`：record 不存在；POST 時 player_id 不存在於 members
- 409 `resource already exists`：POST 時 reference_no 重複
- 422 `invalid_transition`：PATCH 非法狀態轉換
- 429 `too many requests`：限流；含 `Retry-After`

---

## 10. 與既有規格的對接

| 規格 | 對接點 |
|------|-------|
| [`01-bff-architecture.md`](./01-bff-architecture.md) | 所有 `/api/cms/deposit-records*` 走 BFF Proxy（JSON envelope，無 CSV 透傳例外） |
| [`02-auth-session.md`](./02-auth-session.md) | session 必須有效；refresh / replay 由 session 層處理 |
| [`03-observability.md`](./03-observability.md) | metric tag：`route=/api/cms/deposit-records`、`route=/api/cms/deposit-records/{id}`；redact 規則覆蓋 `amount` 嗎？預設不（金額非個資）|
| [`05-player-query-domain.md`](./05-player-query-domain.md) | 共享 `playerId` 識別；玩家僅以 `player_id` 在 record 內引用（後端補 `player_name`）|
| [`07-admin-rbac-audit.md`](./07-admin-rbac-audit.md) | 角色：create=admin/user、list/get=全 CMS staff、update=admin；稽核事件 |
| [`10-screen-topup-list.md`](./10-screen-topup-list.md) | 列表頁 UI；本規格資料層；URL 篩選參數與本規格 §3.2 對齊 |
| [`11-screen-topup-detail.md`](./11-screen-topup-detail.md) | 明細頁 UI；本規格 §6 是其資料層 |

---

## 11. 測試清單（TDD）

### 11.1 `src/lib/topups/transform.test.ts`

```ts
// snake → camel
it('should map id, player_id, player_name, payment_method to camelCase')
it('should preserve amount as integer without conversion')
it('should preserve currency code verbatim (uppercase)')
it('should map nullable fields (operator_id, operator_ip, internal_note, display_note, reference_no) to null when absent')
it('should map status enum value through without transformation (completed, not success)')
it('should map updated_at to updatedAt')

// list meta
it('should map meta {page, page_size, total} to camelCase {page, pageSize, total}')
```

### 11.2 `src/lib/topups/list.test.ts`

```ts
// query 組合
it('should call GET /cms/deposit-records with no query params when all filters omitted')
it('should serialize multi-value status as repeated keys (?status=pending&status=failed)')
it('should serialize multi-value payment_method as repeated keys')
it('should default sort to -created_at when omitted')
it('should default page to 1 and page_size to 20 when omitted')
it('should pass player_id through when provided')

// 驗證
it('should throw invalid input when end_date < start_date')
it('should throw invalid input when page_size > 100')
it('should throw invalid input when status value is not in enum whitelist')
it('should throw invalid input when sort is not in whitelist')

// envelope / 錯誤
it('should return camelCase DepositRecord array plus meta on 200')
it('should propagate 403 forbidden from upstream')
it('should propagate 429 with Retry-After')
it('should NOT include upstream stack in error response')
```

### 11.3 `src/lib/topups/get.test.ts`

```ts
it('should call GET /cms/deposit-records/{id} with id only (no player_id in path)')
it('should return camelCase DepositRecord')
it('should propagate 404 resource_not_found from upstream')
it('should treat "resource not found" (space-form) as same code via normalizeErrorCode')
```

### 11.4 `src/lib/topups/create.test.ts`

```ts
it('should POST /cms/deposit-records with player_id, amount, payment_method')
it('should default currency to TWD when omitted')
it('should NOT send player_name / operator_id / operator_ip (server-filled)')
it('should return camelCase DepositRecord with status=pending on 201')
it('should propagate 404 when player_id does not exist')
it('should propagate 409 resource_already_exists when reference_no duplicates')
it('should propagate 403 forbidden when caller is viewer')
```

### 11.5 `src/lib/topups/update.test.ts`

```ts
it('should PATCH /cms/deposit-records/{id} with status')
it('should send internal_note=null to clear, omit field to leave unchanged (three-state)')
it('should return updated DepositRecord on 200')
it('should propagate 422 invalid_transition on illegal status change')
it('should propagate 403 forbidden when caller is not admin')
```

### 11.6 不在本規格的測試

- UI 互動（篩選列、列表、建立表單）→ [`10`](./10-screen-topup-list.md)
- 明細頁渲染 → [`11`](./11-screen-topup-detail.md)
- 稽核事件落地 → 後端
- 角色行為矩陣 → [`07`](./07-admin-rbac-audit.md)
- 玩家自助端點（`/api/me/deposit-records`）→ 玩家端 app，非本 CMS 規格

---

## 12. 開放問題

> 實作前須與後端／PM 對齊：

- [ ] **儲值彙總端點**：後端目前無 summary 端點；§7 形狀為待定。需向後端要求新增 members 儲值彙總端點
- [ ] **匯出端點**：後端目前無 CSV / export 端點；§8 已移除前端匯出功能。待後端提供後再設計
- [ ] **玩家搜尋 / 詳情端點**：後端目前無玩家搜尋／詳情端點，玩家僅以 `player_id` 在 record 內引用；影響 [`05`](./05-player-query-domain.md) / [`08`](./08-screen-player-search.md) / [`09`](./09-screen-player-detail.md)
- [ ] **多幣別**：後端 DB CHECK 目前僅允許 `TWD`；開放 USD / JPY 時需同步更新 §2.1 最小單位顯示規則
- [ ] `paymentMethod` enum 顯示名稱對照表（「銀行轉帳」/「信用卡」…）放哪？建議 `lib/topups/labels.ts` 並與 i18n 整合
- [ ] 退款是否區分部分／全額？後端目前僅有 `completed → refunded` 單一轉換，無退款金額欄位
