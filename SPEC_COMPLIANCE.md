# PlayerLedger Frontend — 規格書合規狀態

**更新日期**: 2026-06-29
**測試狀態**: 371 unit tests passing · type-check ✅ · lint ✅
**整體合規**: 🟡 **基礎建設層完成;玩家領域待後端 `/players/*` 端點**

> 本文件為跨全部 14 份 spec 的**單一真實狀態來源**。先前版本只涵蓋 01–04 並聲稱「100% 完成」,
> 未提及 05–13——已修正為下方的逐 spec 狀態。

---

## 總覽

| Spec | 主題                | 狀態        | 說明                                                                                                          |
| ---- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| 01   | BFF 架構            | ✅ 完成     | proxy / health(含 route 測試)/ 安全標頭 / XFF append / rate limit                                             |
| 02   | 認證 Session        | ✅ 完成     | login / logout / refresh(mutex + CAS)/ cookie / client session                                                |
| 03   | 可觀測性            | ✅ 完成     | pino logger + redact / EMF metrics / OTel / 前端 telemetry 端點                                               |
| 04   | Dockerfile & Build  | ✅ 完成     | 多階段建置 / standalone / 非 root / HEALTHCHECK                                                               |
| 05   | 玩家查詢領域        | ⛔ 待後端   | 依賴 `/players/search`、`/players/{id}`——**後端 OpenAPI 未提供**                                              |
| 06   | 儲值紀錄領域        | ⛔ 待後端   | 依賴 `/players/{id}/topups/*`、export——**後端 OpenAPI 未提供**                                                |
| 07   | Admin RBAC & Audit  | 🟡 核心完成 | role decode + ClientSession.role + layout 注入完成;UI 閘門(ExportButton 等)待 05/06 畫面                      |
| 08   | 畫面:玩家搜尋       | ⛔ 待後端   | 依賴 spec 05                                                                                                  |
| 09   | 畫面:玩家詳情       | ⛔ 待後端   | 依賴 spec 05                                                                                                  |
| 10   | 畫面:儲值列表       | ⛔ 待後端   | 依賴 spec 06                                                                                                  |
| 11   | 畫面:儲值詳情       | ⛔ 待後端   | 依賴 spec 06                                                                                                  |
| 12   | 註冊領域            | ✅ 完成     | 路由 / CSRF / rate limit / 錯誤碼對應 / 驗證分工                                                              |
| 13   | 畫面:註冊           | ✅ 完成     | 表單 / 行為 / login 頁強化 / a11y(含 `aria-busy`)                                                             |
| 14   | 畫面:全玩家儲值紀錄 | ✅ 完成     | 跨玩家總覽;篩選 / 排序 / 分頁 / 玩家聚焦 + client 端 CSV 匯出(含玩家 ID);重用 `/cms/deposit-records` 扁平資源 |

---

## ⛔ 阻塞說明:玩家領域(05 / 06 / 08–11)

前端 spec 05/06/08–11 圍繞 `/players/*` 契約設計,但**後端 `PlayerLedgerBackend/schema/openapi.yaml`
實際只提供** `/auth/*`、`/cms/deposit-records`、`/cms/deposit-records/{id}`、`/me/deposit-records`,
**沒有 `Player` 實體,也沒有 `/players/*` 端點**。spec 自己亦標註這些端點「後端尚未實作 / 規劃中」。

依 CLAUDE.md 的 **SDD**(OpenAPI Schema 為唯一契約、不得對不存在端點猜測性實作),此領域維持未實作。

**決議(2026-06-29)**:等後端在 `openapi.yaml` 補上 `/players/*` 與 `Player` schema 後,再依 SDD 先產型別、
再 TDD 實作 05 → 06 → 08 → 09 → 10 → 11,以及 07 的角色感知 UI(§10.3 ExportButton / paymentChannel、§10.4 e2e)。

---

## 已實作 spec 細節

### Spec 01 — BFF 架構

- `src/lib/config.ts` fail-fast 設定驗證
- `src/app/api/health/route.ts`(shallow)、`src/app/api/health/deep/route.ts`(deep);
  route handler 測試 `route.test.ts` / `deep/route.test.ts`(§9.5 狀態碼映射、no-store、version、不洩漏 stack)
- `src/proxy.ts` CSRF Origin 檢查、CSP nonce、PUBLIC_PATHS、rate limit
- `src/app/api/[...path]/route.ts` 通用 proxy(header whitelist、1MB 限制、timeout、**X-Forwarded-For append** §4.2/ADR 011)
- `next.config.ts` 安全標頭(HSTS / CSP / X-Frame-Options 等)

### Spec 02 — 認證 Session

- `src/lib/session/session.ts`:sessionId 格式、verify/store/delete、`getValidAccessToken`(Redis mutex + Lua CAS + bounded polling)
- `src/lib/auth/login.ts` / `logout.ts` / `refresh.ts`
- `src/lib/session/cookie.ts`(`__Host-` prefix / HttpOnly / Secure / SameSite=Strict)
- `src/lib/session/client-session.tsx`(不含 token)

### Spec 03 — 可觀測性

- `src/lib/logger/logger.ts` + `redact-paths.ts`(PII 自動遮蔽)
- `src/lib/observability/metrics.ts`(CloudWatch EMF)
- `instrumentation.ts` / `instrumentation-node.ts`(OTel + graceful shutdown)
- 前端端點:`/api/client-errors`、`/api/vitals`、`/api/csp-report`

### Spec 04 — Dockerfile & Build

- 多階段 `Dockerfile`、`output: 'standalone'`、非 root(UID 1001)、tini、HEALTHCHECK、`.dockerignore`

### Spec 07 — Admin RBAC(核心)

- `src/lib/auth/decode-token.ts`:`decodeAccessToken` + `Role` / `UserType` / `TokenClaims`(decode-only 不驗簽,§3.2)
- `src/lib/session/client-session.tsx`:`ClientSession` 新增 `role`(§3.3,單一字串非陣列)
- `src/app/(cms)/layout.tsx`:SSR decode role 注入,並擋 `utype !== 'cms'`(防 session 污染)
- **待做**:角色感知 UI(ExportButton / paymentChannel)與 e2e forbidden 流程——綁定 05/06 畫面

### Spec 12 / 13 — CMS 註冊

- `src/app/api/register/route.ts`(注入 client_id、狀態/錯誤透傳)
- `src/app/(auth)/register/page.tsx`(欄位 / 驗證分工 / 錯誤碼對應 / `aria-busy`)
- login 頁 `?registered=true` banner 與註冊連結

### Spec 14 — 畫面:全玩家儲值紀錄

- `src/app/(cms)/deposit-records/page.tsx` 跨玩家列表(Server Component);`listDeposits` 重用 `/cms/deposit-records` 扁平資源(不帶 `player_id` → 全玩家)
- `_components/`:`filter-bar` / `active-player-chip`(玩家聚焦,server-first)/ `result-table` / `result-row`(列內玩家聚焦連結)/ empty / error state
- 共用元件提升:`@/components/topups/` 的 `pagination`(`basePath` 參數化)、`export-button`(`includePlayerId` prop)、`@/lib/topups/query-params`(擴可選 `playerId`)
- client 端 CSV 匯出(§A4.1):`toDepositCsv(records, { includePlayerId })` 於「玩家」欄後加「玩家 ID」欄;僅當前頁、admin/user 可見

---

## 測試

```bash
npm run test         # 371 unit tests
npm run type-check   # tsc --noEmit
npm run lint         # eslint --max-warnings 0
npm run test:e2e     # Playwright
```

---

**簽核**: Claude Code · **規格範圍**: 01–14 · **狀態**: 基礎建設完成,玩家領域待後端契約
