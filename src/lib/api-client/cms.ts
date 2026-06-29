/**
 * CMS API 請求輔助（BFF server-side → 後端 /api/cms/*）。
 *
 * 職責：
 * - 從 session 取有效 access token（含必要時 refresh），以 Bearer 帶往後端
 * - 經 `apiFetch`（注入 W3C trace context）呼叫上游
 * - 解開後端統一 envelope `{ success, request_id, data, meta? }`
 * - 非 2xx → 拋 `ApiError`（code 正規化；429 帶 Retry-After 秒數）
 *
 * 僅供 Server Component / Route Handler 呼叫（用到 next/headers cookies）。
 */
import { cookies } from 'next/headers';
import { getValidAccessToken } from '@/lib/session/session';
import { SESSION_COOKIE_NAME } from '@/lib/session/cookie';
import { config } from '@/lib/config';
import { ApiError, normalizeErrorCode } from '@/lib/api/errors';
import { apiFetch } from './client';

export type CmsMeta = { page: number; pageSize: number; total: number };

type CmsRequestInit = {
  method?: string;
  searchParams?: URLSearchParams;
  body?: unknown;
};

/**
 * 對後端 CMS 端點發一次請求並回傳解開 envelope 後的 `{ data, meta }`。
 * @param path 以 `/cms/...` 開頭的端點路徑（會接在 baseUrl + cmsBasePath 之後）
 */
export async function cmsRequest<T = unknown>(
  path: string,
  init: CmsRequestInit = {}
): Promise<{ data: T; meta?: CmsMeta }> {
  const sid = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const token = await getValidAccessToken(sid);
  if (!token) {
    // 無有效 session → 視同 401（呼叫端頁面會導向 login / 顯示 forbidden）
    throw new ApiError(401, 'unauthorized', '沒有有效的登入狀態');
  }

  const qs = init.searchParams?.toString();
  const url = `${config.api.baseUrl}${config.api.cmsBasePath}${path}${qs ? `?${qs}` : ''}`;
  const hasBody = init.body !== undefined;

  const res = await apiFetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(init.body) : undefined,
    timeoutMs: config.api.timeoutMs,
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const code = normalizeErrorCode(json?.error ?? `http_${res.status}`);
    const retryAfter =
      res.status === 429 ? Number(res.headers.get('retry-after')) || undefined : undefined;
    throw new ApiError(res.status, code, json?.message, retryAfter);
  }

  const meta = json?.meta
    ? { page: json.meta.page, pageSize: json.meta.page_size, total: json.meta.total }
    : undefined;

  return { data: json?.data as T, meta };
}
