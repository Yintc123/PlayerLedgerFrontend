import { config } from '@/lib/config';
import { logger } from '@/lib/logger/logger';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp（ms），由 `now + expires_in*1000` 計算
};

export class TokenRefreshError extends Error {
  constructor(
    public backendError: string,
    message: string
  ) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * 呼叫後端 /auth/refresh 端點取得新的 token pair
 * 不包含 absoluteExpiresAt：rotation 不延長 abs_exp
 *
 * @param refreshToken 用於 refresh 的 token
 * @returns TokenPair（accessToken, refreshToken, expiresAt）
 * @throws TokenRefreshError 若後端回 401（token 過期、abs_exp 過、重放偵測）
 * @throws UpstreamError 若網路錯誤或 5xx
 */
export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const url = `${config.api.baseUrl}${config.api.basePath}/auth/refresh`;
  const requestId = crypto.randomUUID();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.api.timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 後端回應解析
    const body = await response.json();

    // 失敗情況 1：401 (token 過期 / abs_exp 過 / 重放偵測)
    if (response.status === 401) {
      const errorCode = body.error || 'unknown';
      logger.error(
        {
          type: 'auth.token.refresh.failed',
          backendError: errorCode,
          status: response.status,
          requestId,
        },
        'Token refresh failed: unauthorized'
      );
      throw new TokenRefreshError(errorCode, `Backend returned 401: ${errorCode}`);
    }

    // 失敗情況 2：5xx
    if (!response.ok) {
      logger.error(
        {
          type: 'auth.token.refresh.upstream_error',
          status: response.status,
          requestId,
        },
        'Token refresh failed: upstream error'
      );
      throw new UpstreamError(`Backend returned ${response.status}`);
    }

    // 成功情況：解析 token pair（envelope { success, request_id, data }，spec §7 / §8）
    if (!body.data || typeof body.data !== 'object') {
      logger.error(
        { type: 'auth.envelope.parse_error', requestId },
        'Backend response missing envelope data field (upstream contract violation)'
      );
      throw new UpstreamError('Backend response missing data field');
    }

    const tokenData = body.data;
    const accessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token;
    const expiresInSeconds = tokenData.expires_in;

    if (!accessToken || !newRefreshToken || !expiresInSeconds) {
      logger.error(
        { type: 'auth.token.refresh.invalid_response', requestId },
        'Backend returned invalid token response'
      );
      throw new UpstreamError('Backend returned invalid token response');
    }

    logger.info({ type: 'auth.token.refresh.success', requestId }, 'Token refreshed successfully');

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
  } catch (err) {
    // 重新拋出已知的錯誤
    if (err instanceof TokenRefreshError || err instanceof UpstreamError) {
      throw err;
    }

    // 網路錯誤 / 超時
    logger.error(
      {
        type: 'auth.token.refresh.network_error',
        error: err instanceof Error ? err.message : String(err),
        requestId,
      },
      'Token refresh network error'
    );
    throw new UpstreamError(err instanceof Error ? err.message : 'Network error');
  }
}
