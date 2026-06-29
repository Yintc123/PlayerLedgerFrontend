/**
 * 資料層錯誤型別。
 *
 * 真實版會由 BFF proxy / lib 層在上游回非 2xx 時拋出；mock 版以特殊輸入觸發，
 * 讓各種錯誤態（403 / 404 / 429 / 5xx）在無後端時也能在 UI 中重現。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number; // 秒，429 時帶

  constructor(status: number, code: string, message?: string, retryAfter?: number) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * 後端 error code 字串格式不一致（空白 vs 底線），統一正規化為 snake_case
 * （spec 02 / 05 §3.2）。例：`"resource not found"` → `resource_not_found`。
 */
export function normalizeErrorCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '_');
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
