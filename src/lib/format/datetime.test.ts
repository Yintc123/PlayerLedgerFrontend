import { describe, it, expect } from 'vitest';
import { formatDateTime, formatDateTimeSeconds, formatShortDateTime } from './datetime';

const ISO = '2026-06-20T03:11:22Z';

describe('formatDateTime', () => {
  it('should render YYYY-MM-DD HH:mm in the given timezone', () => {
    expect(formatDateTime(ISO, 'UTC')).toBe('2026-06-20 03:11');
  });

  it('should shift to the user timezone (GMT+8)', () => {
    expect(formatDateTime(ISO, 'Asia/Taipei')).toBe('2026-06-20 11:11');
  });

  it('should not include seconds', () => {
    expect(formatDateTime(ISO, 'UTC')).not.toMatch(/:\d\d:\d\d/);
  });
});

describe('formatDateTimeSeconds', () => {
  it('should render YYYY-MM-DD HH:mm:ss', () => {
    expect(formatDateTimeSeconds(ISO, 'UTC')).toBe('2026-06-20 03:11:22');
  });
});

describe('formatShortDateTime', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('should render MM-DD HH:mm for an in-year date', () => {
    expect(formatShortDateTime(ISO, 'UTC', now)).toBe('06-20 03:11');
  });

  it('should render full YYYY-MM-DD HH:mm for a cross-year date', () => {
    expect(formatShortDateTime('2025-12-31T23:00:00Z', 'UTC', now)).toBe('2025-12-31 23:00');
  });
});
