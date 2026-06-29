import { describe, it, expect } from 'vitest';
import { parseListQuery, serializeListQuery } from './query-params';
import type { DepositListQuery } from './types';

describe('parseListQuery', () => {
  it('should parse all known fields from URLSearchParams', () => {
    const params = new URLSearchParams();
    params.set('page', '2');
    params.set('pageSize', '50');
    params.append('status', 'pending');
    params.append('status', 'failed');
    params.append('paymentMethod', 'credit_card');
    params.set('startDate', '2026-06-01');
    params.set('endDate', '2026-06-28');
    params.set('sort', 'amount');
    expect(parseListQuery(params)).toEqual({
      page: 2,
      pageSize: 50,
      status: ['pending', 'failed'],
      paymentMethod: ['credit_card'],
      startDate: '2026-06-01',
      endDate: '2026-06-28',
      sort: 'amount',
    });
  });

  it('should parse status as array from REPEATED keys (not comma)', () => {
    const p = new URLSearchParams();
    p.append('status', 'pending');
    p.append('status', 'completed');
    expect(parseListQuery(p).status).toEqual(['pending', 'completed']);
  });

  it('should parse paymentMethod as array from repeated keys', () => {
    const p = new URLSearchParams();
    p.append('paymentMethod', 'credit_card');
    p.append('paymentMethod', 'bank_transfer');
    expect(parseListQuery(p).paymentMethod).toEqual(['credit_card', 'bank_transfer']);
  });

  it('should parse page / pageSize as integers', () => {
    const q = parseListQuery(new URLSearchParams({ page: '3', pageSize: '20' }));
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(20);
  });

  it('should fall back to undefined when page is non-integer (no throw)', () => {
    expect(parseListQuery(new URLSearchParams({ page: '2.5' })).page).toBeUndefined();
    expect(parseListQuery(new URLSearchParams({ page: 'abc' })).page).toBeUndefined();
  });

  it('should parse startDate and endDate independently', () => {
    expect(parseListQuery(new URLSearchParams({ startDate: '2026-06-01' }))).toEqual({
      startDate: '2026-06-01',
    });
    expect(parseListQuery(new URLSearchParams({ endDate: '2026-06-28' }))).toEqual({
      endDate: '2026-06-28',
    });
  });

  it('should ignore sort not in the enum', () => {
    expect(parseListQuery(new URLSearchParams({ sort: 'bogus' })).sort).toBeUndefined();
    expect(parseListQuery(new URLSearchParams({ sort: '-amount' })).sort).toBe('-amount');
  });

  it('should drop unsupported legacy params (currency/minAmount/cursor)', () => {
    const q = parseListQuery(
      new URLSearchParams({ currency: 'TWD', minAmount: '100', cursor: 'abc' })
    );
    expect(q).toEqual({});
  });
});

describe('serializeListQuery', () => {
  it('should serialize multi-value as REPEATED keys (not comma)', () => {
    const out = serializeListQuery({
      status: ['pending', 'failed'],
      paymentMethod: ['credit_card'],
    });
    expect(out).toContain('status=pending');
    expect(out).toContain('status=failed');
    expect(out).not.toContain('%2C'); // no comma
    expect(out).toContain('paymentMethod=credit_card');
  });

  it('should omit undefined and empty arrays', () => {
    expect(serializeListQuery({})).toBe('');
    expect(serializeListQuery({ status: [], paymentMethod: [] })).toBe('');
  });

  it('should serialize page / pageSize / dates', () => {
    const out = serializeListQuery({
      page: 2,
      pageSize: 50,
      startDate: '2026-06-01',
      endDate: '2026-06-28',
    });
    expect(out).toContain('page=2');
    expect(out).toContain('pageSize=50');
    expect(out).toContain('startDate=2026-06-01');
    expect(out).toContain('endDate=2026-06-28');
  });

  it('should omit default sort but keep non-default sort', () => {
    expect(serializeListQuery({ sort: '-created_at' })).toBe('');
    expect(serializeListQuery({ sort: 'amount' })).toBe('?sort=amount');
  });

  it('should round-trip through parseListQuery', () => {
    const q: DepositListQuery = {
      page: 2,
      status: ['pending', 'failed'],
      paymentMethod: ['credit_card'],
      sort: 'amount',
    };
    const parsed = parseListQuery(new URLSearchParams(serializeListQuery(q)));
    expect(parsed).toEqual(q);
  });
});
