/**
 * API Client — W3C Trace Context propagation wrapper（spec 03 §4.6）
 *
 * 職責：在 BFF 內部呼叫上游 API Server 時，把 OTel 的 traceparent / tracestate
 * 注入 outbound fetch headers，讓 X-Ray / Jaeger 可以串接分散式 trace。
 *
 * 不用 @vercel/otel 自動 instrumentation：Next.js 16 的 fetch hook 在 edge/node
 * runtime 行為仍在迭代，明示注入是最保險、行為最可預期的做法（spec 03 §4.6 最後說明）。
 */

type ApiClientOptions = RequestInit & {
  /** 逾時毫秒數，預設 20000ms */
  timeoutMs?: number;
};

/**
 * fetch wrapper：自動注入 W3C trace context
 *
 * @param url 完整 URL
 * @param init fetch options
 */
export async function apiFetch(url: string, init: ApiClientOptions = {}): Promise<Response> {
  const { timeoutMs = 20000, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);

  // W3C Trace Context propagation（spec 03 §4.6）
  // 若 OTel SDK 已初始化，propagation.inject() 會注入 traceparent / tracestate
  // 若 SDK 未初始化（OTEL_SDK_DISABLED=true 或本地開發），則 context 為空，inject 為 no-op
  if (process.env.OTEL_SDK_DISABLED !== 'true') {
    try {
      const { context, propagation } = await import('@opentelemetry/api');
      propagation.inject(context.active(), headers, {
        set: (carrier: Headers, key: string, value: string) => carrier.set(key, value),
      });
    } catch {
      // OTel 套件不存在時略過（本地 dev 未安裝）
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...fetchInit,
      headers,
      signal: AbortSignal.any(
        [controller.signal, fetchInit.signal].filter(Boolean) as AbortSignal[]
      ),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
