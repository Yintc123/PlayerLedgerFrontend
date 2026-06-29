import { describe, it, expect } from 'vitest';
import { listDeposits } from './list';
import { getDeposit } from './get';
import { createDeposit } from './create';
import { ApiError } from '@/lib/api/errors';
import { MOCK_PLAYERS } from '@/lib/mock/dataset';

const PLAYER_ID = MOCK_PLAYERS[0].playerId;

describe('listDeposits (mock, offset pagination)', () => {
  it('should return offset page meta (page/pageSize/total)', async () => {
    const result = await listDeposits({ playerId: PLAYER_ID, pageSize: 2, page: 1 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.total).toBeGreaterThan(2);
    expect(result.records).toHaveLength(2);
  });

  it('should filter by status (multi-value OR)', async () => {
    const result = await listDeposits({ playerId: PLAYER_ID, status: ['completed'] });
    expect(result.records.every((r) => r.status === 'completed')).toBe(true);
  });

  it('should filter by payment method', async () => {
    const result = await listDeposits({ playerId: PLAYER_ID, paymentMethod: ['credit_card'] });
    expect(result.records.every((r) => r.paymentMethod === 'credit_card')).toBe(true);
  });

  it('should sort by -amount when requested', async () => {
    const result = await listDeposits({ playerId: PLAYER_ID, sort: '-amount', pageSize: 100 });
    const amounts = result.records.map((r) => r.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });

  it('should throw 400 when startDate > endDate', async () => {
    await expect(
      listDeposits({ startDate: '2026-06-30', endDate: '2026-06-01' })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('should throw a triggered ApiError (forbidden)', async () => {
    await expect(listDeposits({ playerId: 'forbidden' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getDeposit (mock)', () => {
  it('should return a record by id', async () => {
    const record = await getDeposit('01HXYZ000000000000000000R1');
    expect(record.id).toBe('01HXYZ000000000000000000R1');
    expect(record.playerName).toBeTruthy();
  });

  it('should throw 404 for an unknown id', async () => {
    await expect(getDeposit('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createDeposit (mock)', () => {
  it('should create a pending record with server-filled player_name', async () => {
    const record = await createDeposit({
      playerId: PLAYER_ID,
      amount: 250,
      paymentMethod: 'credit_card',
    });
    expect(record.status).toBe('pending');
    expect(record.playerName).toBe(MOCK_PLAYERS[0].displayName);
    expect(record.currency).toBe('TWD');
    // 建立後可被列表查到
    const list = await listDeposits({ playerId: PLAYER_ID, pageSize: 100 });
    expect(list.records.some((r) => r.id === record.id)).toBe(true);
  });

  it('should throw 404 when player_id is not a known member', async () => {
    await expect(
      createDeposit({ playerId: '00000000-0000-0000-0000-000000000000', amount: 1, paymentMethod: 'manual' })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('should throw 400 when amount < 1', async () => {
    await expect(
      createDeposit({ playerId: PLAYER_ID, amount: 0, paymentMethod: 'manual' })
    ).rejects.toMatchObject({ status: 400 });
  });
});
