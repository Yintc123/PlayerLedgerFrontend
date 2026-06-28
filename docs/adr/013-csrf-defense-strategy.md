# ADR 013 - CSRF 防護策略：SameSite=Lax + Origin Check

## 狀態

已採用（取代 [02-auth-session.md §6.1](../specs/02-auth-session.md#61-csrf-防護) 原本「視場景額外加 X-Requested-With 或 Double Submit Cookie」的開放式描述）

## 背景

原規格只說明 SameSite=Lax 已涵蓋一般 CSRF，並對「需要更嚴格防護的場景」開放兩種選項（X-Requested-With / Double Submit Cookie），但**沒有指出哪些端點屬於此類**，實作時容易判斷不一致；尤其 `POST /api/login` 缺乏明確的 login-CSRF 防護。

BFF 架構下的 CSRF 攻擊面實際上有限，SameSite=Lax 並非萬靈丹：

| 攻擊類型 | SameSite=Lax 是否擋下 |
|---|---|
| 跨站 form POST 攜帶 sid | ✅ Lax 不送 cookie |
| 跨站 fetch with credentials | ✅ Lax 不送 cookie |
| 同站子網域 XSS 借 cookie | 部分（取決於 Cookie Domain；HttpOnly 擋 JS 讀取） |
| Top-level GET 導覽（攜帶 cookie） | ✅ GET handlers 須保證不修改狀態 |
| **Login CSRF**（受害者被登入到攻擊者帳號，蒐集行為） | ❌ SameSite=Lax 不擋 top-level POST 場景 |

Login CSRF 是少數 SameSite=Lax 不擋的真實攻擊；雖然影響度低，但成本極低即可消除。

## 評估

### 方案 A：Double Submit Cookie / 對稱 CSRF token

傳統做法，BFF 發 token、前端每個 state-changing 請求附帶比對。優點：成熟、廣為人知。

**缺點：**
- BFF 必須額外發 token、前端每個請求附帶；增加 cookie 數量、增加 JS 邏輯
- 本架構（SameSite=Lax + JSON-only POST + BFF 同源）多數場景已不需要
- 投入產出比不成比例

### 方案 B：Origin / Referer header 檢查（採用）

對所有 state-changing 請求（POST/PUT/PATCH/DELETE）在 `proxy.ts` 比對 `Origin` 是否在白名單。原理：

- 跨站發 POST 時 browser **必送** `Origin`，攻擊者站台無法偽造（Origin 是 browser-controlled，攻擊者 JS 改不了）
- 同站請求 `Origin` 為自家 hostname，通過
- 缺少 `Origin` 視為可疑直接拒絕（現代 browser 對 state-changing 必送）

涵蓋：
- 一般跨站 CSRF（與 SameSite=Lax 形成 defense-in-depth）
- **Login CSRF**（SameSite=Lax 不擋的場景）
- 任何攻擊者誘導的 cross-origin state change

**優點：**
- 實作極簡（一行白名單比對）
- 無需發 token、不需前端配合
- 對 BFF 同源架構是最自然的選擇

### 方案 C：X-Requested-With header

簡單擋下 simple form POST。**不採用**：fetch / XHR 都可自塞此 header，攻擊者真正能跨站發 request 時這個 header 防不住，徒增實作雜訊。

## 決策

採方案 B：Origin check + SameSite=Lax 雙層 defense-in-depth。

### 實作

```ts
// proxy.ts
import { config } from '@/lib/config'

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isOriginAllowed(request: NextRequest): boolean {
  if (!STATE_CHANGING.has(request.method)) return true   // GET/HEAD/OPTIONS 不須檢查
  const origin = request.headers.get('origin')
  if (!origin) return false                              // state-changing 必須有 Origin
  return config.app.allowedOrigins.has(origin)
}

export async function proxy(request: NextRequest) {
  if (!isOriginAllowed(request)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // ... 後續：rate limit、session 驗證、X-Request-ID 注入
}
```

### 適用範圍

- **所有 state-changing 端點**（含 `/api/login`、`/api/logout`、`/api/[...path]`）——`PUBLIC_PATHS` 的端點同樣需要檢查（login CSRF 防護的關鍵就是擋 login 端點本身的跨站 POST）
- **不適用**：GET / HEAD / OPTIONS——這些方法應保證冪等且不修改狀態

### 環境變數

| 變數 | 必填 | 說明 |
|------|------|------|
| `PUBLIC_ORIGIN` | ✅ | BFF 對外的完整 origin（含 scheme + hostname + port），例 `https://playerledger.com` |
| `ALLOWED_ORIGINS_EXTRA` | ❌ | 額外允許的 origin（逗號分隔），開發環境用以加入 `http://localhost:3000`；production 應留空 |

於 `config.ts` 集中讀取並組成 `Set`，避免每次請求重新 parse：

```ts
// lib/config.ts
app: {
  publicOrigin:    required('PUBLIC_ORIGIN'),
  allowedOrigins:  new Set([
    required('PUBLIC_ORIGIN'),
    ...(process.env.ALLOWED_ORIGINS_EXTRA?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
  ]),
},
```

### 為何仍保留 SameSite=Lax

雙層防護：browser 沒送 `Origin` 的極端情況（特定隱私模式、極舊版 browser）仍由 SameSite 兜底。兩者協作。

### 為何不需要 Double Submit Cookie

Double Submit 解決的問題是「BFF 無法從 request 判斷它是否來自自家頁面」。Origin check 已直接回答此問題，CSRF token 變成重複勞動。若未來出現需要 cookie 不可達場景（例如某些 webhook 整合），再評估補強。

### 測試規格

```ts
// proxy.test.ts
it('should allow GET regardless of Origin')
it('should allow state-changing request with allowed Origin')
it('should reject state-changing request with disallowed Origin')
it('should reject state-changing request without Origin header')
it('should apply Origin check to /api/login (login CSRF protection)')
it('should apply Origin check to /api/logout')
```

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` §6.1 | 改寫為「SameSite=Lax + Origin check」明確策略 |
| `docs/specs/02-auth-session.md` §4 | `proxy.ts` 範例加入 Origin check（在所有其他檢查之前） |
| `docs/specs/01-bff-architecture.md` §5 | env vars 新增 `PUBLIC_ORIGIN`、`ALLOWED_ORIGINS_EXTRA` |
| `docs/specs/01-bff-architecture.md` §6.2 | config 模組加入 `app.publicOrigin`、`app.allowedOrigins` |
| `.env.example` | 新增 `PUBLIC_ORIGIN` 與 `ALLOWED_ORIGINS_EXTRA` 區塊 |

## 參考

- [OWASP CSRF Prevention Cheat Sheet §「Verifying Origin With Standard Headers」](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#identifying-source-origin-via-originreferer-header)
- [Fetch Standard - Origin header guarantees](https://fetch.spec.whatwg.org/#origin-header)
