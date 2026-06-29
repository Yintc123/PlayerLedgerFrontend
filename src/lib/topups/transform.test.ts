import { describe, it, expect } from 'vitest';
import { toDepositRecord, type RawDepositRecord } from './transform';

const raw: RawDepositRecord = {
  id: '0193b3f4-0001',
  player_id: '0193b3f4-0002',
  player_name: '玩家小王',
  amount: 1000,
  currency: 'TWD',
  status: 'completed',
  payment_method: 'bank_transfer',
  operator_id: '0193b3f4-0003',
  operator_ip: '192.0.2.1',
  internal_note: '客服補單',
  display_note: '銀行轉帳儲值',
  reference_no: 'TXN-001',
  created_at: '2026-06-20T03:11:22Z',
  updated_at: '2026-06-20T03:12:00Z',
};

describe('toDepositRecord', () => {
  it('should map all snake_case fields to camelCase', () => {
    expect(toDepositRecord(raw)).toEqual({
      id: '0193b3f4-0001',
      playerId: '0193b3f4-0002',
      playerName: '玩家小王',
      amount: 1000,
      currency: 'TWD',
      status: 'completed',
      paymentMethod: 'bank_transfer',
      operatorId: '0193b3f4-0003',
      operatorIp: '192.0.2.1',
      internalNote: '客服補單',
      displayNote: '銀行轉帳儲值',
      referenceNo: 'TXN-001',
      createdAt: '2026-06-20T03:11:22Z',
      updatedAt: '2026-06-20T03:12:00Z',
    });
  });

  it('should normalize missing/null nullable fields to null', () => {
    const minimal: RawDepositRecord = {
      id: 'a',
      player_id: 'p',
      player_name: 'n',
      amount: 5,
      currency: 'TWD',
      status: 'pending',
      payment_method: 'manual',
      created_at: 't1',
      updated_at: 't2',
    };
    const out = toDepositRecord(minimal);
    expect(out.operatorId).toBeNull();
    expect(out.operatorIp).toBeNull();
    expect(out.internalNote).toBeNull();
    expect(out.displayNote).toBeNull();
    expect(out.referenceNo).toBeNull();
  });
});
