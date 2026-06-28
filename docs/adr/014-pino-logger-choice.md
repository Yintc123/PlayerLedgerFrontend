# ADR 014 - Pino 為唯一結構化 logger

## 狀態

已採用（為 [03-observability.md §2.1 / §2.6](../specs/03-observability.md#2-結構化日誌) 隱含的工具選擇補上正式 ADR；無前置決策被覆蓋）

## 背景

spec 03 §2.1 直接寫出「採 Pino」，但未走 ADR 流程比對替代方案。Logger 是跨整個應用的橫切依賴（每個 Route Handler、Server Component、middleware 都引用），更換成本高；事故時 log 查詢介面、CloudWatch Logs Insights query 都鎖死在欄位 shape，一旦選錯日後再換要重寫所有 query 與告警。屬於「決策值得寫下、未來有人會質疑」的範疇。

## 評估

### 候選方案

| 方案 | 結構化 | 效能（benchmarks） | Next.js 整合 | 生態 |
|------|--------|------------------|-------------|------|
| **Pino** | ✅ 原生 JSON | 30k+ ops/sec，最快 | 直接 import，無 wrapper | 大、redact / transport / mixin 完整 |
| Winston | ✅ 可選 | ~5k ops/sec | 直接 import | 大但 v3 maintenance only |
| Bunyan | ✅ 原生 JSON | ~15k ops/sec | 直接 import | 維護緩慢，新 feature 少 |
| `console.log` + 自寫 JSON | ⚠️ 手動 | 取決於 stringify | 無框架 | 需自己處理 redact / level / transport |
| Next.js `unstable_after` + 自寫 | ⚠️ 手動 | 同上 | 框架原生 | 仍要自己解 redact / async |

### 為何挑 Pino

1. **效能差距是量級的**：Pino 在 benchmark 比 Winston 快 5-10×。BFF 每個 SSR / Route Handler 至少 2-3 筆 log（request / response / error），加上 metric（EMF 也走 logger）、auth event log，單機 100 QPS 即每秒 600+ 筆 log；Winston 同負載會把 event loop lag 推高，反向觸發 §3.3 的 `nodejs.eventloop.lag.p95` 告警。
2. **JSON-first 與 CloudWatch Logs Insights 天然契合**：Pino 預設輸出單行 JSON，不需 transformer；spec 03 §2.8 的所有查詢都假設這個格式。
3. **`redact` 是宣告式、強制性**：path 在 logger 設定時固定，呼叫端忘了脫敏也擋得住，符合 spec 02 §6.4 / spec 03 §2.4 的安全要求。
4. **`mixin` 支援動態欄位**：spec 03 §4.5 的 `traceId / spanId` 從 `trace.getActiveSpan()` 動態抽取，靠這個 hook 才能在不污染呼叫端的前提下塞進每筆 log。
5. **生態系列工具齊**：`pino-pretty`（本地 dev）、`pino-roll`（容器外 log rotation，雖然 ECS 不需要但留作 fallback）、`pino.destination({sync:false})`（spec 03 §2.6 修訂後的 async 寫法）。

### Pino 的代價（已知接受）

- API 對 prototype chain 敏感：傳入 ES class instance log 時 getter 不會被序列化，必須 `JSON.parse(JSON.stringify(...))` 或 toJSON。文件化於 spec 03 §7 反模式。
- Worker thread transport 在 Next.js standalone build 內偶有 path resolution 問題；本專案改用 `pino.destination({sync: false})`（單 thread async fd write）規避（spec 03 §2.6 採用此方案）。

## 決策

採 **Pino**，所有結構化 log 必須透過 `lib/logger/logger.ts` 匯出的 instance；禁止 `console.log` 直接寫入 stdout（spec 03 §7 反模式已禁止）。

### 強制要求

1. 設定集中於 `lib/logger/logger.ts`（與 `lib/logger/redact-paths.ts` 拆檔），不允許散落各模組各自 `pino()`。
2. Async destination：production / staging 用 `pino.destination({ sync: false, minLength: 4096 })`；測試環境用 `sync: true` 才能斷言 log 出現。
3. SIGTERM hook 必須呼叫 `flushSync()`（spec 04 §3.6 graceful shutdown）。
4. `base` 欄位採 OpenTelemetry semconv 命名（`service.name` / `service.version` / `deployment.environment`，spec 03 §2.3 / §2.6 已修訂）。

### 何時重新評估

- BFF 加入 client-side 收 log 需求且 Pino 沒對應方案
- CloudWatch Logs cost / 卷量壓力需要轉用 Vector / Fluent Bit 採樣（屆時 Pino 仍可作來源，但 transport 鏈會擴展）
- Vercel / 其他 Node hosting 平台對 Pino async transport 限制變嚴重

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/03-observability.md` §2.1 | 加 cross-ref 至本 ADR |
| `docs/specs/03-observability.md` §2.6 | 已採用 async destination（依 C1 修補） |
| `lib/logger/logger.ts` | 唯一 logger 進入點 |
| `lib/logger/redact-paths.ts` | redact path 清單 |
| 所有 Route Handler / Server Component / proxy.ts | 一律 import `getRequestLogger` 或全域 `logger` |

## 參考

- [Pino benchmarks](https://github.com/pinojs/pino/blob/main/docs/benchmarks.md)
- [OpenTelemetry semantic conventions — Resource](https://opentelemetry.io/docs/specs/semconv/resource/)
- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
- [03-observability.md §2.6 Pino 設定](../specs/03-observability.md#26-pino-設定)
