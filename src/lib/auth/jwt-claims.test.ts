import { describe, it, expect } from 'vitest';
import { readJwtClaims, readAccessTokenClaims } from './jwt-claims';
import { Buffer } from 'node:buffer';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${claims}.fake-signature`;
}

describe('readJwtClaims (spec §11.1)', () => {
  it('should read absoluteExpiresAt from refresh_token JWT abs_exp claim (no signature verify)', () => {
    const absExp = Math.floor(Date.now() / 1000) + 28800;
    const jwt = makeJwt({ abs_exp: absExp, exp: absExp - 27000, jti: 'test-jti' });

    const claims = readJwtClaims(jwt);

    expect(claims.abs_exp).toBe(absExp);
  });

  it('should treat malformed refresh JWT as upstream contract violation (502)', () => {
    expect(() => readJwtClaims('not-a-valid-jwt')).toThrow('malformed_jwt');
  });

  it('should treat missing abs_exp claim in refresh JWT as upstream contract violation (502)', () => {
    const jwt = makeJwt({ exp: 9999999, jti: 'test-jti' }); // abs_exp 缺失

    expect(() => readJwtClaims(jwt)).toThrow('missing_abs_exp_claim');
  });

  it('should reject JWT with fewer than 3 parts', () => {
    expect(() => readJwtClaims('header.payload')).toThrow('malformed_jwt');
  });

  it('should reject JWT with invalid base64 payload', () => {
    expect(() => readJwtClaims('header.!!!invalid!!!.sig')).toThrow('malformed_jwt');
  });

  it('should reject JWT with non-JSON payload', () => {
    const nonJson = Buffer.from('not-json').toString('base64url');
    expect(() => readJwtClaims(`header.${nonJson}.sig`)).toThrow('malformed_jwt');
  });

  it('should reject JWT with non-numeric abs_exp', () => {
    const jwt = makeJwt({ abs_exp: 'not-a-number', exp: 9999999 });

    expect(() => readJwtClaims(jwt)).toThrow('missing_abs_exp_claim');
  });

  it('should handle base64url padding correctly', () => {
    // base64url 不帶 padding，測試 readJwtClaims 正確補 padding
    const absExp = 1700000000;
    const jwt = makeJwt({ abs_exp: absExp });

    expect(() => readJwtClaims(jwt)).not.toThrow();
    expect(readJwtClaims(jwt).abs_exp).toBe(absExp);
  });
});

// spec §11.1 — access token sub claim = user_id（JWT RFC 7519）
describe('readAccessTokenClaims', () => {
  it('should read userId from access token sub claim', () => {
    const jwt = makeJwt({ sub: 'user-abc', exp: 9999999, role: 'user' });
    expect(readAccessTokenClaims(jwt).sub).toBe('user-abc');
  });

  it('should throw missing_sub_claim when sub is absent', () => {
    const jwt = makeJwt({ exp: 9999999, role: 'user' });
    expect(() => readAccessTokenClaims(jwt)).toThrow('missing_sub_claim');
  });

  it('should throw malformed_jwt for invalid JWT format', () => {
    expect(() => readAccessTokenClaims('bad-token')).toThrow('malformed_jwt');
  });
});
