import { describe, it, expect } from 'vitest';
import { parseSearchQuery, serializeSearchQuery, hasAnySearchField } from './query-params';

describe('parseSearchQuery', () => {
  it('should parse all known fields from URLSearchParams', () => {
    const params = new URLSearchParams({
      playerId: 'p1',
      externalId: 'e1',
      displayName: '王',
      email: 'a@b.com',
      phone: '+886912',
      cursor: 'abc',
      limit: '10',
    });
    expect(parseSearchQuery(params)).toEqual({
      playerId: 'p1',
      externalId: 'e1',
      displayName: '王',
      email: 'a@b.com',
      phone: '+886912',
      cursor: 'abc',
      limit: 10,
    });
  });

  it('should treat empty string values as undefined', () => {
    const params = new URLSearchParams({ playerId: '', displayName: '王' });
    const result = parseSearchQuery(params);
    expect(result.playerId).toBeUndefined();
    expect(result.displayName).toBe('王');
  });

  it('should parse limit as number when valid integer string', () => {
    expect(parseSearchQuery(new URLSearchParams({ limit: '25' })).limit).toBe(25);
  });

  it('should ignore limit when non-integer (no throw)', () => {
    expect(parseSearchQuery(new URLSearchParams({ limit: 'abc' })).limit).toBeUndefined();
  });

  it('should ignore limit when out of [1, 50] range', () => {
    expect(parseSearchQuery(new URLSearchParams({ limit: '0' })).limit).toBeUndefined();
    expect(parseSearchQuery(new URLSearchParams({ limit: '51' })).limit).toBeUndefined();
  });

  it('should preserve cursor opaque string verbatim', () => {
    expect(parseSearchQuery(new URLSearchParams({ cursor: 'eyJpZCI6MX0=' })).cursor).toBe(
      'eyJpZCI6MX0='
    );
  });
});

describe('serializeSearchQuery', () => {
  it('should omit undefined and empty-string fields from output', () => {
    const out = serializeSearchQuery({ playerId: 'p1', displayName: '', email: undefined });
    expect(out).toBe('?playerId=p1');
  });

  it('should produce stable key order for snapshot diffability', () => {
    const a = serializeSearchQuery({ email: 'a@b.com', playerId: 'p1' });
    const b = serializeSearchQuery({ playerId: 'p1', email: 'a@b.com' });
    expect(a).toBe(b);
  });

  it('should return empty string when query has no fields', () => {
    expect(serializeSearchQuery({})).toBe('');
  });
});

describe('hasAnySearchField', () => {
  it('should return false when only cursor / limit are present', () => {
    expect(hasAnySearchField({ cursor: 'x', limit: 20 })).toBe(false);
  });

  it('should return true when any search field present', () => {
    expect(hasAnySearchField({ email: 'a@b.com' })).toBe(true);
    expect(hasAnySearchField({ displayName: '王' })).toBe(true);
  });
});
