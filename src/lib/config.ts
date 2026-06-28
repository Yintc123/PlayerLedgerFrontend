export function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function optionalInt(
  key: string,
  defaultValue: number,
  opts: { min?: number; max?: number } = {}
): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new Error(`${key} must be an integer, got: ${value}`);
  if (opts.min !== undefined && parsed < opts.min) {
    throw new Error(`${key}=${parsed} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`${key}=${parsed} must be <= ${opts.max}`);
  }
  return parsed;
}

// 對齊後端 OpenAPI schema ClientID enum，不允許未列值
const ALLOWED_CLIENT_IDS = ['cms-web', 'public-web', 'ios-app', 'android-app'] as const;
export type ClientId = (typeof ALLOWED_CLIENT_IDS)[number];

export function clientId(key: string): ClientId {
  const value = required(key);
  if (!(ALLOWED_CLIENT_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `${key}="${value}" is not a valid client_id. ` +
        `Allowed: ${ALLOWED_CLIENT_IDS.join(', ')} (per backend OpenAPI ClientID enum)`
    );
  }
  return value as ClientId;
}

export function createConfig() {
  return {
    session: {
      ttlSeconds: optionalInt('SESSION_TTL_SECONDS', 28800), // 8h，對齊 cms-web abs_exp
      refreshThresholdSeconds: optionalInt('REFRESH_THRESHOLD_SECONDS', 180),
      refreshLockTtlSeconds: optionalInt('REFRESH_LOCK_TTL_SECONDS', 10),
      cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    },
    redis: {
      host: required('REDIS_HOST'),
      port: optionalInt('REDIS_PORT', 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: optionalInt('REDIS_DB', 0),
    },
    api: {
      baseUrl: required('API_BASE_URL').replace(/\/$/, ''), // 強制去掉 trailing slash 避免雙 //
      basePath: (process.env.API_BASE_PATH ?? '/api/v1').replace(/\/$/, ''), // auth endpoint prefix（lib/auth/*.ts 用）；ops 端點不用
      cmsBasePath: (process.env.CMS_API_BASE_PATH ?? '/api').replace(/\/$/, ''), // CMS 業務 endpoint prefix（catch-all proxy 用，後端無版本號）
      clientId: clientId('CLIENT_ID'), // 啟動時驗證屬於 OpenAPI ClientID enum，fail-fast
      timeoutMs: optionalInt('API_TIMEOUT_MS', 20_000, { min: 1_000, max: 25_000 }),
      // 上界 25000：API Gateway 29 秒上限的安全餘量；超過會被 APIGW 直接砍
      // 下界 1000：低於 1 秒幾乎所有上游呼叫都會 timeout，必為設定錯誤
    },
    app: {
      publicOrigin: required('PUBLIC_ORIGIN'),
      allowedOrigins: new Set([
        required('PUBLIC_ORIGIN'),
        ...(process.env.ALLOWED_ORIGINS_EXTRA?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []),
      ]),
    },
    isProd: process.env.NODE_ENV === 'production',
  } as const;
}

// 初始化配置。在測試環境下嘗試創建，但若失敗則返回空物件（測試可自行 mock）
let configInstance: ReturnType<typeof createConfig> | null = null;

export function initConfig(): ReturnType<typeof createConfig> {
  if (!configInstance) {
    configInstance = createConfig();
  }
  return configInstance;
}

export const config = process.env.VITEST
  ? (() => {
      try {
        return createConfig();
      } catch {
        // vitest 內 env 尚未塞值時回 stub；測試本身會 mock '@/lib/config'，
        // 此 stub 只是為了 module-eval 不爆。
        return {} as unknown as ReturnType<typeof createConfig>;
      }
    })()
  : initConfig();
