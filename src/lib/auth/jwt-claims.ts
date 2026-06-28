import { Buffer } from 'node:buffer';

/**
 * 解析 JWT payload claims，不驗簽（spec §11.1）
 *
 * BFF 沒有 JWT_REFRESH_SECRET，無法驗簽。
 * 此函式僅用於從 refresh token 取出 abs_exp 作為 hint —— 安全把關仍在後端。
 *
 * 不可用於：
 *  - access token 驗證（後端負責）
 *  - 信賴 claim 值做安全決策（abs_exp 之外的 claim 一律忽略）
 */
export type RefreshTokenClaims = {
  abs_exp: number; // unix seconds；後端 ADR 007 line 104 規定
  exp: number; // unix seconds；refresh sliding TTL
  jti: string; // 後端 audit ID，BFF 不持有（ADR 010 §決策 6）
};

/**
 * 解析 JWT payload，不驗簽。
 * malformed JWT 或缺少 abs_exp → 拋 Error（login 流程應回 502）
 */
export function readJwtClaims(jwt: string): RefreshTokenClaims {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed_jwt');

  // base64url → base64 → JSON
  const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);

  let claims: Record<string, unknown>;
  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    claims = JSON.parse(json);
  } catch {
    throw new Error('malformed_jwt');
  }

  if (typeof claims.abs_exp !== 'number') {
    throw new Error('missing_abs_exp_claim');
  }

  return claims as RefreshTokenClaims;
}
