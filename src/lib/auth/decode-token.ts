import { decodeJwtPayload } from './jwt-claims';

/**
 * Access token claims 解析（spec 07 §3.2）
 *
 * 角色 / 使用者類型來自後端 access token claims（後端 pkg/jwt/role.go 為單一可信來源）。
 * BFF 僅 decode 不驗簽（後端已驗，BFF 無 JWT secret，重新驗簽違反最小特權）。
 * role 僅供 SSR 決定 UI 顯示；任何安全判斷仍以「呼叫後端 API 後端拒絕」為準。
 */
export type Role = 'admin' | 'user' | 'viewer' | 'member';
export type UserType = 'cms' | 'member';

export type TokenClaims = {
  userId: string; // = sub
  userType: UserType; // = utype
  role: Role;
  familyId: string; // = fid
  exp: number;
};

const VALID_ROLES: ReadonlySet<string> = new Set<Role>(['admin', 'user', 'viewer', 'member']);
const VALID_USER_TYPES: ReadonlySet<string> = new Set<UserType>(['cms', 'member']);

/**
 * Base64-decode access token payload，不驗簽。
 * malformed JWT / claim 缺失或非法 → 拋 Error（呼叫端應導回 login 或回 502）
 */
export function decodeAccessToken(accessToken: string): TokenClaims {
  const claims = decodeJwtPayload(accessToken); // 拋 malformed_jwt（三段格式 / 非 JSON）

  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('missing_sub_claim');
  }
  if (typeof claims.role !== 'string' || !VALID_ROLES.has(claims.role)) {
    throw new Error('invalid_role_claim');
  }
  if (typeof claims.utype !== 'string' || !VALID_USER_TYPES.has(claims.utype)) {
    throw new Error('invalid_utype_claim');
  }
  if (typeof claims.fid !== 'string' || !claims.fid) {
    throw new Error('missing_fid_claim');
  }
  if (typeof claims.exp !== 'number') {
    throw new Error('missing_exp_claim');
  }

  return {
    userId: claims.sub,
    userType: claims.utype as UserType,
    role: claims.role as Role,
    familyId: claims.fid,
    exp: claims.exp,
  };
}
