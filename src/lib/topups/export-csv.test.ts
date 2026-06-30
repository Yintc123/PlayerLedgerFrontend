import { describe, it, expect } from 'vitest';
import { toDepositCsv } from './export-csv';
import type { DepositRecord } from './types';

const BOM = '﻿';

function makeRecord(overrides: Partial<DepositRecord> = {}): DepositRecord {
  return {
    id: '0193b3f4-0000-7000-8000-000000000001',
    playerId: '0193b3f4-0000-7000-8000-000000000002',
    playerName: '玩家小王',
    amount: 1000,
    currency: 'TWD',
    status: 'completed',
    paymentMethod: 'bank_transfer',
    operatorId: '0193b3f4-0000-7000-8000-000000000003',
    operatorIp: '192.0.2.1',
    internalNote: '客服補單',
    displayNote: '銀行轉帳儲值',
    referenceNo: 'TXN-20260629-001',
    createdAt: '2026-06-20T03:11:22Z',
    updatedAt: '2026-06-20T03:12:00Z',
    ...overrides,
  };
}

/** BOM 去除後依 CRLF 切列。 */
function rows(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  return csv.slice(BOM.length).split('\r\n');
}

describe('toDepositCsv', () => {
  it('should prepend a UTF-8 BOM so Excel reads 中文 correctly', () => {
    const csv = toDepositCsv([makeRecord()]);
    expect(csv.startsWith(BOM)).toBe(true);
  });

  it('should emit a header row of visible columns', () => {
    const [header] = rows(toDepositCsv([makeRecord()]));
    expect(header).toBe('建立時間,玩家,參考號,金額,幣別,支付方式,狀態');
  });

  it('should output amount as the raw integer minor-unit value (no Intl formatting)', () => {
    const [, dataRow] = rows(toDepositCsv([makeRecord({ amount: 1234567 })]));
    expect(dataRow.split(',')).toContain('1234567');
    expect(dataRow).not.toContain('1,234,567');
    expect(dataRow).not.toContain('NT$');
  });

  it('should output referenceNo as an empty cell when null', () => {
    const [, dataRow] = rows(toDepositCsv([makeRecord({ referenceNo: null })]));
    // 建立時間,玩家,參考號(空),金額,...
    expect(dataRow.split(',')[2]).toBe('');
  });

  it('should escape comma / double-quote / newline by wrapping in quotes and doubling inner quotes', () => {
    const csv = toDepositCsv([makeRecord({ playerName: 'Wang, Jr.', referenceNo: 'a"b\nc' })]);
    const dataRow = csv.slice(BOM.length).split('\r\n')[1];
    expect(dataRow).toContain('"Wang, Jr."');
    expect(dataRow).toContain('"a""b\nc"');
  });

  it('should output payment method and status as Chinese labels', () => {
    const [, dataRow] = rows(
      toDepositCsv([makeRecord({ paymentMethod: 'bank_transfer', status: 'completed' })])
    );
    const cells = dataRow.split(',');
    expect(cells[5]).toBe('銀行轉帳');
    expect(cells[6]).toBe('已完成');
  });

  it('should NOT include internalNote / operatorId / operatorIp columns', () => {
    const csv = toDepositCsv([
      makeRecord({ internalNote: 'SECRET-NOTE', operatorIp: '10.9.8.7', operatorId: 'OP-XYZ' }),
    ]);
    expect(csv).not.toContain('SECRET-NOTE');
    expect(csv).not.toContain('10.9.8.7');
    expect(csv).not.toContain('OP-XYZ');
    expect(csv).not.toContain('internalNote');
    expect(csv).not.toContain('operatorIp');
  });

  it('should return only the header row (plus BOM) when records is empty', () => {
    const csv = toDepositCsv([]);
    expect(csv).toBe(BOM + '建立時間,玩家,參考號,金額,幣別,支付方式,狀態');
  });

  it('should keep the spec-10 seven-column output unchanged when includePlayerId is omitted/false', () => {
    const withFalse = toDepositCsv([makeRecord()], { includePlayerId: false });
    const omitted = toDepositCsv([makeRecord()]);
    expect(withFalse).toBe(omitted);
    expect(rows(withFalse)[0]).toBe('建立時間,玩家,參考號,金額,幣別,支付方式,狀態');
  });

  it('should insert a "玩家 ID" header column after "玩家" when includePlayerId is true', () => {
    const [header] = rows(toDepositCsv([makeRecord()], { includePlayerId: true }));
    expect(header).toBe('建立時間,玩家,玩家 ID,參考號,金額,幣別,支付方式,狀態');
  });

  it('should output the playerId (UUID) value in the player-ID column when includePlayerId is true', () => {
    const playerId = '0193b3f4-0000-7000-8000-00000000aaaa';
    const [, dataRow] = rows(toDepositCsv([makeRecord({ playerId })], { includePlayerId: true }));
    // 建立時間, 玩家, 玩家 ID(index 2), 參考號, ...
    expect(dataRow.split(',')[2]).toBe(playerId);
  });
});
