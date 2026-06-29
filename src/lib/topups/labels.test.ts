import { describe, it, expect } from 'vitest';
import {
  paymentMethodLabel,
  depositStatusLabel,
  DEPOSIT_STATUS_OPTIONS,
  PAYMENT_METHOD_OPTIONS,
} from './labels';

describe('paymentMethodLabel', () => {
  it('should map a known method to its chinese label', () => {
    expect(paymentMethodLabel('convenience_store')).toBe('超商代收');
    expect(paymentMethodLabel('e_wallet')).toBe('電子錢包');
  });

  it('should return the raw value for an unknown method', () => {
    expect(paymentMethodLabel('mystery_pay')).toBe('mystery_pay');
  });
});

describe('depositStatusLabel', () => {
  it('should map completed to 已完成 (backend uses completed, not success)', () => {
    expect(depositStatusLabel('completed')).toBe('已完成');
  });

  it('should map refunded to 已退款', () => {
    expect(depositStatusLabel('refunded')).toBe('已退款');
  });
});

describe('option lists', () => {
  it('should expose all five status options in backend order', () => {
    expect(DEPOSIT_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      'pending',
      'completed',
      'failed',
      'cancelled',
      'refunded',
    ]);
  });

  it('should expose payment method options aligned to backend enum', () => {
    expect(PAYMENT_METHOD_OPTIONS.map((o) => o.value)).toEqual([
      'bank_transfer',
      'credit_card',
      'manual',
      'convenience_store',
      'e_wallet',
    ]);
  });
});
