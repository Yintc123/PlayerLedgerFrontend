import { logger } from '@/lib/logger/logger';

type MetricUnit = 'Count' | 'Milliseconds' | 'Bytes' | 'Percent' | 'None';

/**
 * 发布 CloudWatch 指标（EMF 格式，§3）
 * 通过 stdout JSON 序列化，CloudWatch 自动解析成指标
 *
 * @param name 指标名称
 * @param value 指标值
 * @param unit 单位
 * @param dimensions 维度字典
 */
export function metric(
  name: string,
  value: number,
  unit: MetricUnit = 'Count',
  dimensions: Record<string, string> = {}
) {
  // 跳过 NaN 值
  if (isNaN(value)) {
    logger.warn({ metricName: name }, 'Skipping NaN metric value');
    return;
  }

  const dimensionKeys = Object.keys(dimensions);
  // EMF 规范：Dimensions 是陣列的陣列，每個內層陣列必須非空
  const dimensionSets = dimensionKeys.length > 0 ? [dimensionKeys] : [];

  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'PlayerLedger/Frontend',
            Dimensions: dimensionSets,
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      [name]: value,
      ...dimensions,
    },
    'metric'
  );
}

/**
 * 便利函式：發佈 HTTP 請求計數
 */
export function recordHttpRequest(
  route: string,
  method: string,
  statusClass: '2xx' | '4xx' | '5xx',
  durationMs: number
) {
  metric('http.request.count', 1, 'Count', { route, method, status_class: statusClass });
  metric('http.request.duration', durationMs, 'Milliseconds', { route, method });
}

/**
 * 便利函式：發佈認證事件
 */
export function recordAuthEvent(
  eventType: 'login_success' | 'login_failure' | 'refresh_success' | 'refresh_failure',
  clientId?: string
) {
  const result = eventType.includes('success') ? 'success' : 'failure';
  metric('auth.login.attempts', 1, 'Count', {
    result,
    ...(clientId ? { client_id: clientId } : {}),
  });
}

/**
 * 便利函式：發佈 Rate Limit 事件
 */
export function recordRateLimit(route: string, reason: 'ip' | 'session') {
  metric('ratelimit.hit', 1, 'Count', { route, reason });
}

// Token refresh outcome metric（spec 03 §3.3）
// outcome 對應 auth.token.refresh 的 log type — keep dimensions aligned for cross-correlation。
export type RefreshOutcome =
  | 'rotated'
  | 'waited'
  | 'expired'
  | 'absolute_expired'
  | 'replay_detected'
  | 'network_error'
  | 'session_deleted'
  | 'timeout';

export function recordRefreshOutcome(outcome: RefreshOutcome, durationMs?: number) {
  metric('auth.token.refresh.count', 1, 'Count', { outcome });
  if (durationMs !== undefined) {
    metric('auth.token.refresh.duration', durationMs, 'Milliseconds', { outcome });
  }
}
