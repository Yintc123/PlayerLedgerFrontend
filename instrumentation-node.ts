/**
 * Node-only instrumentation：由 instrumentation.ts 在 nodejs runtime dynamic import。
 *
 * 職責：
 *  1. 註冊 OpenTelemetry SDK + AsyncLocalStorageContextManager（spec 03 §4.2）
 *     - 沒有 ALS context manager 的話，pino mixin（§4.5）跨 await 抓不到 active span
 *     - propagation.inject()（§4.6）也會傳空 traceparent
 *  2. 註冊 SIGTERM / SIGINT handler，graceful shutdown（spec 04 §3.6）
 *     - Next.js standalone server 自身會 drain in-flight requests
 *     - 這裡只負責關閉 Redis client + pino flush
 */
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { registerOTel } from '@vercel/otel';

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  try {
    // 必須在 registerOTel 之前註冊 context manager
    // 否則跨 await 後 context.active() 拿不到 span
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    registerOTel({
      serviceName: 'playerledger-frontend',
      // instrumentations 由 @vercel/otel 預設啟用 fetch / http / ioredis
      // traceExporter 自動讀 OTEL_EXPORTER_OTLP_ENDPOINT
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[instrumentation] OpenTelemetry init failed:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

const shutdown = async (signal: string) => {
  try {
    const { logger, flushLogger } = await import('@/lib/logger/logger');
    logger.info({ type: 'shutdown.received', signal }, 'shutdown signal received');

    try {
      const { redis } = await import('@/lib/session/redis');
      await redis.quit();
    } catch (err) {
      logger.warn(
        {
          type: 'shutdown.redis_quit_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        'Redis quit failed during shutdown'
      );
    }

    try {
      await flushLogger();
    } catch {
      // flush 失敗忽略
    }
  } catch {
    // logger import 失敗時也不能 crash
  }

  // Next.js standalone server 自己會處理 in-flight requests + process.exit
  // 我們不主動 exit，避免打斷 standalone server 的 drain 邏輯
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
