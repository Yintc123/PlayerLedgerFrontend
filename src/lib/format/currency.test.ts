import { describe, it, expect } from 'vitest';
import { formatAmount, currencyMinorDigits, formatRefundRate } from './currency';

describe('currencyMinorDigits', () => {
  it('should return 0 for TWD (backend treats TWD as whole 元, not ISO 2)', () => {
    expect(currencyMinorDigits('TWD')).toBe(0);
  });

  it('should return 2 for USD (cents)', () => {
    expect(currencyMinorDigits('USD')).toBe(2);
  });

  it('should return 0 for JPY', () => {
    expect(currencyMinorDigits('JPY')).toBe(0);
  });

  it('should fall back to ISO/2 for an unknown currency code', () => {
    expect(currencyMinorDigits('ZZZ')).toBe(2);
  });
});

describe('formatAmount', () => {
  it('should format TWD as whole units (1000 → 1,000, no decimals)', () => {
    const out = formatAmount(1000, 'TWD');
    expect(out).toContain('1,000');
    expect(out).not.toContain('.00');
  });

  it('should format USD using cents (1050 → 10.50)', () => {
    expect(formatAmount(1050, 'USD')).toContain('10.50');
  });

  it('should format JPY without decimals (500 → 500)', () => {
    const out = formatAmount(500, 'JPY');
    expect(out).toContain('500');
    expect(out).not.toContain('.00');
  });

  it('should not throw on an invalid currency code', () => {
    expect(() => formatAmount(100, '!!')).not.toThrow();
  });
});

describe('formatRefundRate', () => {
  it('should render 0.0523 as "5.23%"', () => {
    expect(formatRefundRate(0.0523)).toBe('5.23%');
  });

  it('should render 0 as "0.00%"', () => {
    expect(formatRefundRate(0)).toBe('0.00%');
  });
});
