// 所有敏感的 key path，pino 的 redact 選項會自動隱藏
export const REDACT_PATHS = [
  // Token 類欄位（任何深度）
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.id_token',
  '*.access_token',
  '*.refresh_token',
  '*.token',
  '*.jwt',
  '*.apiKey',
  '*.api_key',

  // Session / 密碼類
  '*.sid',
  '*.sessionId',
  '*.password',
  '*.passwd',
  '*.secret',

  // 個資（必要時改 hash，預設整段擋掉）
  '*.email',
  '*.phone',
  '*.ssn',

  // Request / Response headers
  'headers.cookie',
  'headers["set-cookie"]',
  'headers.authorization',
  'headers["proxy-authorization"]',
  'headers["x-csrf-token"]',
  'headers["x-api-key"]',
  // 大小寫變體：pino redact 不會自動 case-insensitive
  'headers.Cookie',
  'headers.Authorization',

  // Request body / query 全文預設不 log（只記 size）；萬一有人錯誤地把整段 body 塞進 log，這幾條再擋一層
  '*.body.password',
  '*.body.email',
  '*.requestBody',
]

// Remove path 用於 header，連 placeholder 都不留
export const REDACT_REMOVE_PATHS = [
  'headers.cookie',
  'headers["set-cookie"]',
  'headers.authorization',
  'headers["proxy-authorization"]',
  'headers.Cookie',
  'headers.Authorization',
]
