import { describe, it, expect } from 'vitest';
import { toPlayer, type RawPlayerDTO } from './transform';

function raw(overrides: Partial<RawPlayerDTO> = {}): RawPlayerDTO {
  return {
    player_id: '11111111-1111-1111-1111-111111111111',
    external_id: 'GAME-UID-1001',
    display_name: '玩家小王',
    email: 'wang@example.com',
    phone: '+886912345678',
    status: 'active',
    registered_at: '2025-03-04T10:23:11Z',
    last_active_at: null,
    ...overrides,
  };
}

describe('toPlayer (PlayerDTO snake_case → camelCase)', () => {
  it('should map player_id, display_name, registered_at to camelCase', () => {
    const p = toPlayer(raw());
    expect(p.playerId).toBe('11111111-1111-1111-1111-111111111111');
    expect(p.displayName).toBe('玩家小王');
    expect(p.registeredAt).toBe('2025-03-04T10:23:11Z');
  });

  it('should map external_id null to externalId null', () => {
    expect(toPlayer(raw({ external_id: null })).externalId).toBeNull();
  });

  it('should preserve viewer-masked email value verbatim (a***@example.com)', () => {
    expect(toPlayer(raw({ email: 'a***@example.com' })).email).toBe('a***@example.com');
  });

  it('should preserve viewer-masked phone value verbatim (+886***5678)', () => {
    expect(toPlayer(raw({ phone: '+886***5678' })).phone).toBe('+886***5678');
  });

  it('should map status enum value through without transformation', () => {
    expect(toPlayer(raw({ status: 'frozen' })).status).toBe('frozen');
    expect(toPlayer(raw({ status: 'closed' })).status).toBe('closed');
  });

  it('should map last_active_at null to lastActiveAt null', () => {
    expect(toPlayer(raw({ last_active_at: null })).lastActiveAt).toBeNull();
  });
});
