import { describe, it, expect } from 'vitest';
import { formatPhoneForDisplay } from './phone';

describe('formatPhoneForDisplay', () => {
  it('should group an E.164 number for readability', () => {
    expect(formatPhoneForDisplay('+886912345678')).toBe('+886 912 345 678');
  });

  it('should return masked values verbatim (does not group)', () => {
    expect(formatPhoneForDisplay('****5678')).toBe('****5678');
  });

  it('should return non-E.164 input unchanged', () => {
    expect(formatPhoneForDisplay('0912345678')).toBe('0912345678');
  });
});
