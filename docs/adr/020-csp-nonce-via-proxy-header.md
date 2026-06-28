# ADR 020 - CSP nonce 透過 proxy.ts 注入 request header

## 狀態

已採用（為 [01-bff-architecture.md §10.3.1](../specs/01-bff-architecture.md#1031-nonce-端到端注入流程) 隱含的設計補上正式 ADR）

## 背景

Next.js 16 採 strict CSP 時需 per-request nonce，方能容許 framework inline script（hydration）。`script-src` 的 nonce 必須**同一筆值**同時出現在：

1. Response `Content-Security-Policy` header
2. HTML `<script nonce="...">` 屬性（由 React server component 內 `<Script nonce={nonce}>` 寫入）

nonce 該在哪生成、如何在 Next.js 16 架構內傳遞到 layout，有多種寫法。spec 01 §10.3.1 直接定案「`proxy.ts` 產生 → 寫入 response header + request header `x-nonce` → layout 用 `headers()` 讀回」，但未走 ADR；這條路徑有 trade-off，值得寫下，避免日後有人因不理解動機而換寫法導致 hydration 失敗。

## 評估

### 候選方案

| 方案 | nonce 生成處 | nonce 傳遞 layout | 缺點 |
|------|-------------|------------------|------|
| **A. `proxy.ts` 生成 → request header `x-nonce`**（採用） | `proxy.ts` | `headers().get('x-nonce')` | 多一個 request header；proxy.ts 必跑（已經是必跑） |
| B. Layout 用 `cookies()` / `cache()` 自行生成 | Server Component | layout 自呼叫 | 同一 request 內多次 render 同 component 拿到不同 nonce → CSP 不符；Next.js cache invalidation 邊界難掌握 |
| C. Middleware（pre-Next.js 16 命名）+ response header | `middleware.ts` | 由 middleware 同時設 CSP 與寫 request header | Next.js 16 已將 `middleware.ts` 重新命名為 `proxy.ts` 並縮限職責（spec 02 §4 註）；走 middleware 等於走舊命名 |
| D. CloudFront Functions / Lambda@Edge 生成 | edge | edge 加 header | 應用部署與 edge config 分離，nonce 設定漂移時極難 debug；spec 01 §10.1 已決定「headers 在應用程式設定不在 CloudFront」 |
| E. 寫入 cookie 由 layout 讀 | proxy.ts | layout 讀 cookie | nonce 是 per-request 值，cookie 是 cross-request 持久化，語義錯誤；多 request 並發會互相覆蓋 |

### 為何挑 A

1. **`proxy.ts` 是 request-scoped 唯一節點**：所有 request 都會經過它（除靜態資源 matcher 排除），生成 nonce 在這裡保證「一次 request = 一個 nonce」。
2. **Request header `x-nonce` 是 Next.js 唯一可靠的 layout 傳遞通道**：Server Component 透過 `headers()` 讀取的就是 `proxy.ts` 寫的 headers（spec 02 §4 `requestHeaders.set('x-nonce', nonce)` + `NextResponse.next({ request: { headers } })`）；這是 Next.js 16 文件推薦的 pattern。
3. **生成與寫入 CSP header 在同一處**：proxy.ts 一次 race-free 完成「nonce 生成 + response 設 CSP + request header 暴露給 layout」三件事；沒有「兩個 nonce 不一致」的可能（瀏覽器收到 CSP 帶 nonce-X，html script 帶 nonce-Y → hydration 全部被擋）。
4. **可測試性高**：unit test 直接斷言 `proxy.ts` 對同一 request 兩處（response header / request header）寫入相同字串。Layout 端 `headers().get('x-nonce')` 也可在 vitest 內 mock。
5. **與 spec 01 §10.1「headers 不在 CloudFront 設」原則一致**：CSP / nonce 屬於應用層安全姿勢，跟著程式碼版本走，CloudFront / edge 不參與。

### 為何不採 B（Layout 自生成）

React Server Component 在同一 request 內可能被多次 render（streaming / suspense boundary），每次 render 取得的 `cookies()` / `cache()` value 在某些邊界情境下不保證單值；CSP 一旦不符 hydration 整頁掛掉。把 nonce 推到 request 邊界唯一節點（proxy.ts）是最穩固的方式。

### 為何不採 C（middleware）

Next.js 16 把 `middleware.ts` 重新命名為 `proxy.ts` 並縮限其職責（route protection / header injection），對齊「在 App 前面的網路邊界」語意。本架構直接用新命名，不留歷史包袱。

### 為何不採 D（edge）

- spec 01 §10.1 明文：headers 應與應用程式版本一起部署，避免 CloudFront 設定漂移。
- nonce 是 per-request runtime 值，edge function 仍需設定 → ECS BFF → ECS BFF 又要設一次 → 容易兩處不同步。
- 違反「一個 nonce 兩處寫」的原子性原則。

## 決策

採方案 A：

### 流程（spec 01 §10.3.1 已記錄，本 ADR 補背景）

```
┌── proxy.ts ──────────────────────────────────────┐
│  1. 產生 per-request nonce                       │
│     const nonce = base64(crypto.randomUUID())    │
│  2. 設定 Content-Security-Policy response header │
│     response.headers.set('Content-Security-Policy', buildCsp(nonce))
│  3. 將 nonce 寫入 request header `x-nonce`,      │
│     供下游 Server Component 透過 headers() 讀取  │
│     requestHeaders.set('x-nonce', nonce)         │
└──────────┬───────────────────────────────────────┘
           ▼
┌── app/layout.tsx ────────────────────────────────┐
│  const nonce = (await headers()).get('x-nonce')  │
│  <Script src="..." nonce={nonce} />              │
└──────────────────────────────────────────────────┘
```

### 強制要求

1. nonce 生成 / CSP header 設定 / request header 寫入**必須在 proxy.ts 同一函式內**，不可拆分到其他 middleware。
2. **`x-nonce` request header 在 proxy.ts 內必須以 `requestHeaders.set` 寫入 `NextResponse.next({ request: { headers: requestHeaders }})`**，不能用 response header；layout 是 server-side 讀，看的是 request 視角的 headers。
3. CSP `script-src` 必含 `'nonce-${nonce}'` 與 `'strict-dynamic'`（spec 01 §10.3 範例）；少 `'strict-dynamic'` 的話子 script（Next.js dynamic import 載的 chunk）會被擋。
4. nonce 長度 22 字元（base64 編碼後的 UUID）——CSP 規範要求 nonce 至少 128 bits entropy，UUID v4 122 bits 略低於 128，但 spec 01 §10.3 已採用此做法、與 Next.js 官方 example 一致；若要 strict 升級可改 `crypto.randomBytes(16)`（128 bits）。

### 何時重新評估

- Next.js 升級對 `headers()` API 行為有變
- 出現「edge 端統一設 nonce」的官方支援（Next.js Edge runtime 提供穩定 hook）
- CSP 規範對 nonce 來源 / format 有新規定

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/01-bff-architecture.md` §10.3 / §10.3.1 | cross-ref 本 ADR |
| `proxy.ts` | nonce 生成 + 雙寫（spec 02 §4 sample code 已對齊） |
| `app/layout.tsx` | `headers().get('x-nonce')` + `<Script nonce={...}>` |
| `next.config.ts` `headers()` | 不在這裡設 CSP（CSP 必須帶 nonce，static config 無法），確認 §10.4 範例對齊 |

## 參考

- [CSP `nonce-` source MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [Next.js docs — Content Security Policy](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
- [strict-dynamic CSP guide](https://web.dev/articles/strict-csp)
- [01-bff-architecture.md §10.3.1 Nonce 端到端注入流程](../specs/01-bff-architecture.md#1031-nonce-端到端注入流程)
- [ADR 011 - 邊緣安全強化](./011-edge-security-hardening.md)（headers / CSP 在應用層設定的延伸）
