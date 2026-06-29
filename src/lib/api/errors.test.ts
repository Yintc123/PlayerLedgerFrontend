import { describe, it, expect } from 'vitest';
import { ApiError, normalizeErrorCode, isApiError } from './errors';

describe('ApiError', () => {
  it('should carry status and code', () => {
    const err = new ApiError(403, 'forbidden');
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
  });

  it('should carry retryAfter for 429', () => {
    const err = new ApiError(429, 'too_many_requests', undefined, 30);
    expect(err.retryAfter).toBe(30);
  });
});

describe('normalizeErrorCode', () => {
  it('should convert space form to snake_case', () => {
    expect(normalizeErrorCode('resource not found')).toBe('resource_not_found');
  });

  it('should leave snake_case unchanged', () => {
    expect(normalizeErrorCode('invalid_input')).toBe('invalid_input');
  });
});

describe('isApiError', () => {
  it('should detect ApiError instances', () => {
    expect(isApiError(new ApiError(500, 'x'))).toBe(true);
    expect(isApiError(new Error('plain'))).toBe(false);
  });
});
