# PlayerLedger Frontend — 規格書合規狀態

**更新日期**: 2026-06-30
**測試狀態**: 815 unit/component tests passing · 3 skipped · 88 test files · type-check ✅ · lint ✅
**整體合規**: ✅ **01–14 全部實作完成,資料層串接真實後端 `/cms/*` 端點**

> 本文件為跨全部 14 份 spec 的**單一真實狀態來源**。
> 2026-06-29 版本標記 05/06/08–11 為「待後端」;**後端已在 `openapi.yaml` 補上 `/cms/players*`
> 與 `/cms/deposit-records*`**,前端已依 SDD/TDD 完成串接,故本版全面改為實作完成(見下「阻塞解除」)。

---

## 總覽

| Spec | 主題                | 狀態    | 說明                                                                                                                                            |
| ---- | ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | BFF 架構            | ✅ 完成 | proxy / health(含 route 測試)/ 安全標頭 / XFF append / rate limit                                                                               |
| 02   | 認證 Session        | ✅ 完成 | login / logout / refresh(mutex + CAS)/ cookie / client session                                                                                  |
| 03   | 可觀測性            | ✅ 完成 | pino logger + redact / EMF metrics / OTel / 前端 telemetry 端點                                                                                 |
| 04   | Dockerfile & Build  | ✅ 完成 | 多階段建置 / standalone / 非 root / HEALTHCHECK                                                                                                 |
| 05   | 玩家查詢領域        | ✅ 完成 | `src/lib/players/*`(search / get / transform);串接 `/cms/players`、`/cms/players/{id}`                                                          |
| 06   | 儲值紀錄領域        | ✅ 完成 | `src/lib/topups/*`(list / get / create / summary / export-csv / query-params);串接 `/cms/deposit-records*`、`/cms/players/{id}/deposit-summary` |
| 07   | Admin RBAC & Audit  | ✅ 完成 | role decode + ClientSession.role + layout 注入;角色感知 UI(ExportButton / CreateDepositButton)已隨 06/10/14 上線                                |
| 08   | 畫面:玩家搜尋       | ✅ 完成 | `(cms)/players/`;`searchPlayers`(keyset cursor);search-form / result-list / load-more                                                           |
| 09   | 畫面:玩家詳情       | ✅ 完成 | `(cms)/players/[playerId]/`;`getPlayer` + `getPlayerTopupSummary` + `listDeposits`(近期紀錄)                                                    |
| 10   | 畫面:儲值列表       | ✅ 完成 | `(cms)/players/[playerId]/topups/`(含 `new/` 建立子路由);`listDeposits` + `createDeposit`                                                       |
| 11   | 畫面:儲值詳情       | ✅ 完成 | `(cms)/players/[playerId]/topups/[recordId]/`;`getDeposit`;狀態時間軸 / related links                                                           |
| 12   | 註冊領域            | ✅ 完成 | 路由 / CSRF / rate limit / 錯誤碼對應 / 驗證分工                                                                                                |
| 13   | 畫面:註冊           | ✅ 完成 | 表單 / 行為 / login 頁強化 / a11y(含 `aria-busy`)                                                                                               |
| 14   | 畫面:全玩家儲值紀錄 | ✅ 完成 | `(cms)/deposit-records/`;`listDeposits`(不帶 `player_id` → 全玩家)+ client 端 CSV 匯出(含玩家 ID)                                               |

---

## ✅ 阻塞解除:玩家領域(05 / 06 / 08–11)

先前 spec 05/06/08–11 圍繞 `/cms/players*` 與 `/cms/deposit-records*` 契約設計,但 2026-06-29 時
後端 `PlayerLedgerBackend/schema/openapi.yaml` 尚未提供 `Player` 實體與相關端點,故此領域維持未實作。

**現況(2026-06-30)**:後端 `openapi.yaml` 已定義所需端點,前端資料層全數串接**真實後端**(無 mock):

- `/cms/players`、`/cms/players/{id}`、`/cms/players/{id}/deposit-summary`
- `/cms/deposit-records`、`/cms/deposit-records/{id}`(GET / POST)、`/me/deposit-records`

所有資料模組經 `src/lib/api-client/cms.ts` 的 `cmsRequest`(帶 session access token + trace)發出 HTTP 請求,
envelope 解開 + snake_case → camelCase transform。依 CLAUDE.md 的 SDD/TDD,已先對齊 schema 再 TDD 實作。

> **遺留清理**:`src/lib/mock/dataset.ts`(早期 mock 資料層)目前**零引用**(連測試都未 import),可移除。

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

### Spec 05 — 玩家查詢領域

- `src/lib/players/`:`search.ts`(`searchPlayers` → `/cms/players`,keyset cursor 分頁)、`get.ts`(`getPlayer` → `/cms/players/{id}`)、`transform.ts`、`types.ts`
- 測試:`search.test.ts` / `get.test.ts` / `transform.test.ts`

### Spec 06 — 儲值紀錄領域

- `src/lib/topups/`:`list.ts`(`/cms/deposit-records`,offset 分頁、多值重複 key)、`get.ts`(`/cms/deposit-records/{id}`)、`create.ts`(POST)、`summary.ts`(`/cms/players/{id}/deposit-summary`)、`transform.ts`、`types.ts`、`labels.ts`、`query-params.ts`
- `export-csv.ts`:client 端 CSV 純函式(`toDepositCsv`,UTF-8 BOM、RFC 4180、`includePlayerId` 選項);後端**無** export 端點,匯出在前端
- 測試:list / transform / summary / labels / query-params / export-csv

### Spec 07 — Admin RBAC

- `src/lib/auth/decode-token.ts`:`decodeAccessToken` + `Role` / `UserType` / `TokenClaims`(decode-only 不驗簽,§3.2)
- `src/lib/session/client-session.tsx`:`ClientSession` 新增 `role`(§3.3,單一字串非陣列)
- `src/app/(cms)/layout.tsx`:SSR decode role 注入,並擋 `utype !== 'cms'`(防 session 污染)
- 角色感知 UI 已上線:`@/components/topups/export-button.tsx`(ExportButton,admin/user 可見)、`CreateDepositButton`;PII 遮罩由後端依角色回傳

### Spec 08 — 畫面:玩家搜尋

- `src/app/(cms)/players/page.tsx`(+ `loading.tsx`、`_lib/query-params.ts`、`_lib/types.ts`)
- `_components/`:search-form / result-row / result-list / load-more / empty-state / error-state
- 經 `searchPlayers` 串接 `/cms/players`;URL 為查詢狀態唯一來源

### Spec 09 — 畫面:玩家詳情

- `src/app/(cms)/players/[playerId]/page.tsx`(+ `error.tsx` / `loading.tsx` / `not-found.tsx`、`_lib/thresholds.ts`)
- `_components/`:profile-card / status-tag / recent-topups / topup-summary-card / copy-button / forbidden-state / error-block
- `getPlayer` + `getPlayerTopupSummary` + `listDeposits`(近期紀錄)

### Spec 10 — 畫面:儲值列表(單一玩家)

- `src/app/(cms)/players/[playerId]/topups/page.tsx`(+ `error.tsx` / `loading.tsx`、`_lib/types.ts`)
- `_components/`:result-table / result-row / filter-bar / empty-state / error-state / create-deposit-button;`new/` 建立子路由(POST create)
- `listDeposits({ playerId, ...query })` + `createDeposit`;`ExportButton` / `Pagination` 已提升為共用元件

### Spec 11 — 畫面:儲值詳情

- `src/app/(cms)/players/[playerId]/topups/[recordId]/page.tsx`(+ `error.tsx` / `loading.tsx` / `not-found.tsx`)
- `_components/`:transaction-card / status-timeline / status-badge / related-links / copy-button / forbidden-state
- `getDeposit` 串接 `/cms/deposit-records/{id}`

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
npm run test         # 815 passing · 3 skipped · 88 files
npm run type-check   # tsc --noEmit
npm run lint         # eslint --max-warnings 0
npm run test:e2e     # Playwright(各 spec §e2e 清單;未計入上方單元/元件數)
```

---

**簽核**: Claude Code · **規格範圍**: 01–14 · **狀態**: 全部實作完成,資料層串接真實後端
