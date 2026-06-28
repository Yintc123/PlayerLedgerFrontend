import pino from 'pino'
import { trace } from '@opentelemetry/api'
import { REDACT_PATHS, REDACT_REMOVE_PATHS } from './redact-paths'

// ECS metadata —— ECS_CONTAINER_METADATA_URI_V4 由 ECS agent 自動注入（spec 03 §2.3）。
// 背景非同步 fetch /task endpoint，拿到的 TaskARN / AvailabilityZone 透過 mixin 在每筆 log 帶上。
// 本地 dev / 測試環境 URI undefined，欄位保持空物件。
const ecsRuntimeFields: Record<string, string> = {}

async function loadEcsMetadata(): Promise<void> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4
  if (!uri) return
  try {
    const res = await fetch(`${uri}/task`)
    if (!res.ok) return
    const task = (await res.json()) as { TaskARN?: string; AvailabilityZone?: string }
    if (task.TaskARN) ecsRuntimeFields['aws.ecs.task.arn'] = task.TaskARN
    if (task.AvailabilityZone) ecsRuntimeFields['cloud.availability_zone'] = task.AvailabilityZone
  } catch {
    // 取不到不影響啟動 — 對齊 dev 環境
  }
}
void loadEcsMetadata()

const baseFields: Record<string, string | undefined> = {
  'service.name': 'playerledger-frontend',
  'service.namespace': 'playerledger',
  'service.version': process.env.APP_VERSION ?? 'unknown',
  'deployment.environment': process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'unknown',
  'cloud.region': process.env.AWS_REGION,
}

const cleanBase = Object.fromEntries(
  Object.entries(baseFields).filter(([, v]) => v !== undefined),
) as Record<string, string>

/**
 * 非同步 destination：避免 pino 預設的 sync write 在熱路徑阻塞 event loop。
 * minLength: 4096 → 累積到 4KB 或時間到才 flush，I/O 次數降一個量級。
 * SIGTERM 收到時 instrumentation.ts 會呼叫 flushLogger() 確保 buffer 寫出。
 */
const destination = pino.destination({
  sync: process.env.NODE_ENV === 'test',
  minLength: 4096,
})

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: cleanBase,
    timestamp: pino.stdTimeFunctions.isoTime,
    /**
     * mixin：將 OTel active span 的 traceId / spanId 注入每筆 log（spec 03 §4.5）。
     * OTEL_SDK_DISABLED=true 時 OTel SDK 不會被 instrumentation 啟用，
     * trace.getActiveSpan() 永遠回 undefined，fields 維持基底欄位。
     */
    mixin() {
      const fields: Record<string, string> = { ...ecsRuntimeFields }
      const span = trace.getActiveSpan()
      if (!span) return fields
      const ctx = span.spanContext()
      return { ...fields, traceId: ctx.traceId, spanId: ctx.spanId }
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    formatters: {
      // 改用 string label 而非數字，Logs Insights 更直觀
      level: (label) => ({ level: label }),
    },
  },
  destination,
)

// header 類 redaction 採 remove（連 placeholder 都不留，避免被 indexed）
export const httpLogger = logger.child(
  {},
  {
    redact: { paths: REDACT_REMOVE_PATHS, remove: true },
  },
)

// 取得 per-request logger（自動帶 requestId）
export function getRequestLogger(requestId: string) {
  return logger.child({ requestId })
}

/**
 * 優雅關閉：SIGTERM 收到後呼叫，確保 buffer 內容寫出。
 * instrumentation.ts 的 shutdown handler 會 await 此函式。
 */
export function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    if (destination.flushSync) {
      try {
        destination.flushSync()
      } catch {
        // sync flush 失敗時繼續走 async path
      }
    }
    resolve()
  })
}
