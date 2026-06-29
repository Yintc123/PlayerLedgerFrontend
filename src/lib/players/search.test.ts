import { describe, it, expect } from 'vitest';
import { searchPlayers } from './search';
import { ApiError } from '@/lib/api/errors';

describe('searchPlayers (mock)', () => {
  it('should throw invalid_input when no search field is provided', async () => {
    await expect(searchPlayers({})).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('should match displayName by prefix', async () => {
    const result = await searchPlayers({ displayName: '林' });
    expect(result.players.length).toBeGreaterThan(0);
    expect(result.players.every((p) => p.displayName.startsWith('林'))).toBe(true);
  });

  it('should return empty players for a non-matching query (not an error)', async () => {
    const result = await searchPlayers({ displayName: '不存在的玩家ZZZ' });
    expect(result.players).toEqual([]);
  });

  it('should throw a 403 ApiError when a field triggers forbidden', async () => {
    await expect(searchPlayers({ displayName: 'forbidden' })).rejects.toBeInstanceOf(ApiError);
    await expect(searchPlayers({ displayName: 'forbidden' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
