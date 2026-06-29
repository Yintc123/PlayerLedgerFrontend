import { describe, it, expect } from 'vitest';
import { idlePolicyFor } from './idle-config';

describe('idlePolicyFor', () => {
  it('should return 15min idle / 30s warning for cms-web', () => {
    expect(idlePolicyFor('cms-web')).toEqual({ idleTimeoutMs: 15 * 60_000, warningMs: 30_000 });
  });

  it('should return 0 (disabled) for public-web', () => {
    expect(idlePolicyFor('public-web')).toEqual({ idleTimeoutMs: 0, warningMs: 0 });
  });

  it('should fall back to cms-web policy for unknown client_id', () => {
    expect(idlePolicyFor('something-else')).toEqual(idlePolicyFor('cms-web'));
  });
});
