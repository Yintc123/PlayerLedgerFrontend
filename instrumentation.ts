/**
 * Next.js instrumentation hook（Next.js 16 約定檔名）
 *
 * 職責（在 Node.js runtime 啟動時跑一次）：
 *  1. 註冊 OpenTelemetry SDK + AsyncLocalStorageContextManager（spec 03 §4.2）
 *     - 沒有 ALS context manager 的話，pino mixin（§4.5）跨 await 抓不到 active span
 *     - propagation.inject()（§4.6）也會傳空 traceparent
 *  2. 註冊 SIGTERM / SIGINT handler，graceful shutdown（spec 04 §3.6）
 *     - Next.js standalone server 自身會 drain in-flight requests
 *     - 這裡只負責關閉 Redis client + pino flush
 *
 * 注意：Next.js 16 同時呼叫 register() 在 nodejs 與 edge runtime，
 * 我們只在 nodejs runtime 跑 OTel + shutdown handler。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // ── 1. OpenTelemetry SDK ────────────────────────────────────────────────
  if (process.env.OTEL_SDK_DISABLED !== 'true') {
    try {
      const { context } = await import('@opentelemetry/api')
      const { AsyncLocalStorageContextManager } = await import(
        '@opentelemetry/context-async-hooks'
      )

      // 必須在 registerOTel 之前註冊 context manager
      // 否則跨 await 後 context.active() 拿不到 span
      const contextManager = new AsyncLocalStorageContextManager()
      contextManager.enable()
      context.setGlobalContextManager(contextManager)

      const { registerOTel } = await import('@vercel/otel')
      registerOTel({
        serviceName: 'playerledger-frontend',
        // instrumentations 由 @vercel/otel 預設啟用 fetch / http / ioredis
        // traceExporter 自動讀 OTEL_EXPORTER_OTLP_ENDPOINT
      })
    } catch (err) {
      // OTel 套件未安裝（本地 dev / OTEL_SDK_DISABLED=true）→ 略過
      // 不可丟例外，否則整個 server 起不來
      // eslint-disable-next-line no-console
      console.warn(
        '[instrumentation] OpenTelemetry init skipped:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── 2. Graceful shutdown handler ────────────────────────────────────────
  const shutdown = async (signal: string) => {
    try {
      // 動態 import 避免 instrumentation.ts 啟動時就拉起整條 lib 鏈
      const { logger } = await import('@/lib/logger/logger')
      logger.info({ type: 'shutdown.received', signal }, 'shutdown signal received')

      // 關閉 Redis 連線（fail-safe，不影響後續流程）
      try {
        const { redis } = await import('@/lib/session/redis')
        await redis.quit()
      } catch (err) {
        logger.warn(
          { type: 'shutdown.redis_quit_failed', error: err instanceof Error ? err.message : String(err) },
          'Redis quit failed during shutdown',
        )
      }

      // Flush pino async destination 確保 log 送出
      try {
        const pino = await import('pino')
        // pino 預設 destination 帶 flushSync；async destination 需手動 flush
        if ('flush' in logger && typeof (logger as any).flush === 'function') {
          await new Promise<void>((resolve) => {
            ;(logger as any).flush(() => resolve())
          })
        }
      } catch {
        // flush 失敗忽略
      }
    } catch {
      // logger import 失敗時也不能 crash
    }

    // Next.js standalone server 自己會處理 in-flight requests + process.exit
    // 我們不主動 exit，避免打斷 standalone server 的 drain 邏輯
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
