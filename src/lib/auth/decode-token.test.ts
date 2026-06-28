import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { decodeAccessToken, type Role } from './decode-token';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${claims}.fake-signature`;
}

// spec 07 §10.1 — src/lib/auth/decode-token.test.ts
describe('decodeAccessToken (spec 07 §10.1)', () => {
  it('should decode userId, userType, role, familyId, exp from valid JWT payload', () => {
    const jwt = makeJwt({
      sub: '0193b3f4-1234-7abc-9def-0123456789ab',
      utype: 'cms',
      role: 'admin',
      fid: '0193b3f4-aaaa-bbbb-cccc-000000000000',
      iat: 1719500000,
      exp: 1719500900,
    });

    expect(decodeAccessToken(jwt)).toEqual({
      userId: '0193b3f4-1234-7abc-9def-0123456789ab',
      userType: 'cms',
      role: 'admin',
      familyId: '0193b3f4-aaaa-bbbb-cccc-000000000000',
      exp: 1719500900,
    });
  });

  it('should map utype="cms" / role="admin" to TokenClaims correctly', () => {
    const jwt = makeJwt({ sub: 'u1', utype: 'cms', role: 'admin', fid: 'f1', exp: 1 });
    const claims = decodeAccessToken(jwt);
    expect(claims.userType).toBe('cms');
    expect(claims.role).toBe('admin');
  });

  it('should accept all 4 role values (admin / user / viewer / member)', () => {
    const roles: Role[] = ['admin', 'user', 'viewer', 'member'];
    for (const role of roles) {
      const utype = role === 'member' ? 'member' : 'cms';
      const jwt = makeJwt({ sub: 'u1', utype, role, fid: 'f1', exp: 1 });
      expect(decodeAccessToken(jwt).role).toBe(role);
    }
  });

  it('should throw when role claim is not one of the 4 enum values', () => {
    const jwt = makeJwt({ sub: 'u1', utype: 'cms', role: 'superuser', fid: 'f1', exp: 1 });
    expect(() => decodeAccessToken(jwt)).toThrow('invalid_role_claim');
  });

  it('should NOT verify signature (decode-only): tampered signature still decodes', () => {
    const jwt = makeJwt({ sub: 'u1', utype: 'cms', role: 'user', fid: 'f1', exp: 1 });
    const tampered = jwt.replace(/\.[^.]*$/, '.tampered-signature-value');
    expect(decodeAccessToken(tampered).userId).toBe('u1');
  });

  it('should throw when token is not three base64url segments', () => {
    expect(() => decodeAccessToken('header.payload')).toThrow('malformed_jwt');
  });

  it('should throw when payload is not valid JSON', () => {
    const nonJson = Buffer.from('not-json').toString('base64url');
    expect(() => decodeAccessToken(`header.${nonJson}.sig`)).toThrow('malformed_jwt');
  });
});
