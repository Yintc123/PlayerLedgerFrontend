# ADR 007 - 路由保護：公開路徑白名單放在 Handler 內

## 狀態

已採用（修訂 ADR 002 §補充 與 spec 02 §4 的 matcher 寫法；ADR 002 的核心路由結構決策仍然成立）

## 背景

原 `proxy.ts` 採用 Next.js matcher 的負向 lookahead 排除不需要 session 的路徑：

```ts
export const config = {
  matcher: [
    '/((?!login|api/login|api/logout|_next/static|_next/image|favicon.ico).*)',
  ],
}
```

Next.js 文件中常見的寫法,看起來簡潔,實際上有一個容易忽略的安全陷阱：

**負向 lookahead `(?!login)` 只比對字串起始位置不限定邊界。** 它的語意是「當前位置之後不可以是 `login` 這 5 個字元」,但不要求 `login` 後面接 `/` 或字串結尾。

實際行為：

| 路徑 | matcher 行為 | 應該如何 |
|------|------------|---------|
| `/login` | ✅ 排除（對） | 排除 |
| `/login-history` | ❌ **被排除（錯）** | 應該保護 |
| `/loginxxx` | ❌ **被排除（錯）** | 應該保護 |
| `/api/login` | ✅ 排除（對） | 排除 |
| `/api/loginx` | ❌ **被排除（錯）** | 應該保護 |
| `/api/logout-all` | ❌ **被排除（錯）** | 應該保護 |

**目前可利用性低**——這些前綴洩漏路徑都不存在於應用中。**但這是 silent failure**：日後新增 `/login-history` 頁面會自動繞過 auth，沒有任何錯誤訊息,code review 時極難發現。

## 評估

### 方案 A：regex 加邊界錨定

```ts
matcher: [
  '/((?!login(?:/|$)|api/login(?:/|$)|api/logout(?:/|$)|_next/|favicon\\.ico).*)',
]
```

`(?:/|$)` 限定 `login` 後面必須是 `/` 或字串結尾。

**優點：**
- 完全在 matcher 層攔截,public 路徑不進入 proxy 函式（省微秒級開銷）

**缺點：**
- regex 複雜度進一步上升,可讀性下降
- 每加一個 public 路徑都要再寫一次 `(?:/|$)`,寫錯一次又回到前綴洩漏
- 維護負擔長期累積

### 方案 B：matcher 只擋靜態資源,public 路徑改用 handler 內 Set

```ts
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout'])

export async function proxy(request: NextRequest) {
  if (!PUBLIC_PATHS.has(request.nextUrl.pathname)) {
    // session 檢查
  }
  // ...
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
```

**優點：**
- `Set.has()` 是 exact string match,**完全沒有前綴誤判可能**
- 名單即文件,加 / 刪 public 路徑只改一行陣列
- 新增受保護路徑時什麼都不用做——預設受保護（**secure-by-default**）
- 容易單元測試（直接 assert `PUBLIC_PATHS` 內容）

**缺點：**
- public 路徑仍會執行 proxy 函式,但只多一次 `Set.has()` 比對(微秒級,不在熱路徑上)

### 方案 C：維持原 regex

如背景所述，有 silent failure 風險。不採用。

## 決策

採用**方案 B**。

理由：
1. **安全 > 微秒級性能**。auth gate 寫錯的代價遠高於每請求多執行一次 `Set.has()` 的開銷
2. **設計符合 secure-by-default**。新路徑自動受保護,不需要記得「要不要排除」
3. **可讀性與可測性**。`PUBLIC_PATHS` 是一段可讀、可 grep、可單元測試的程式碼,regex 不是

matcher 仍以 regex 排除真正的靜態資源（`_next/static`、`_next/image`、`favicon.ico`）。這層 regex 寫錯不會造成安全問題——靜態資源本來就不涉及 auth 決策。**規範：matcher 只能用於排除「跟 auth 無關」的路徑,任何與 session 相關的判斷一律放 handler。**

## 維護規範

### 新增需要繞過 session 的端點（如 `/api/health`、`/api/metrics`）

1. 在 `PUBLIC_PATHS` Set 加入精確路徑字串
2. 對應 handler 自行處理 sid 缺失的情況（例如 health 端點本來就不該需要 session）
3. 對應 unit test 加一個案例驗證該路徑放行

### 新增受保護頁面或 API 端點

**什麼都不用做。** 預設就會被 `proxy.ts` 保護,呼叫 `getValidAccessToken()` 或 `verifySession()` 取 session 即可。

### 新增需要 matcher 排除的特殊路徑

只有真正與 auth 無關的路徑（如新類型的靜態資源前綴）才能改 matcher。任何「不想做 session 檢查的端點」都應該放 `PUBLIC_PATHS`,不應放 matcher。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` | §4 proxy.ts 程式碼範例完整改寫；matcher 排除說明改為「路徑分類」三欄表 + 「公開路徑說明」表 |
| `docs/adr/002-bff-route-structure.md` | §補充 移除 matcher 程式碼範例,改為指向本 ADR 與 spec 02 §4 |

## 參考

- [Next.js Middleware matcher 文件](https://nextjs.org/docs/app/api-reference/file-conventions/middleware#matcher)：官方範例普遍採用 regex,但未強調前綴洩漏問題
- 同類專案（NextAuth、Clerk 中介軟體）多採方案 B：matcher 只排靜態資源,auth 判斷在 handler
