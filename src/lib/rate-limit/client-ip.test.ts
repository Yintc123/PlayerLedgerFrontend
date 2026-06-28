import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getClientIp } from './client-ip';

function buildRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest(new Request('http://localhost/test', { headers }));
}

describe('getClientIp', () => {
  it('should extract first IP from X-Forwarded-For', () => {
    const request = buildRequest({ 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1' });
    expect(getClientIp(request)).toBe('192.168.1.1');
  });

  it('should fall back to x-real-ip header when XFF is missing (Next.js 15+ removed request.ip)', () => {
    const request = buildRequest({ 'x-real-ip': '203.0.113.5' });
    expect(getClientIp(request)).toBe('203.0.113.5');
  });

  it('should return 0.0.0.0 when neither XFF nor x-real-ip is present', () => {
    const request = buildRequest({});
    expect(getClientIp(request)).toBe('0.0.0.0');
  });

  it('should handle XFF with extra spaces', () => {
    const request = buildRequest({ 'x-forwarded-for': '192.168.1.1  ,  10.0.0.1' });
    expect(getClientIp(request)).toBe('192.168.1.1');
  });

  it('should detect tampering (more than TRUSTED_HOPS + 1 IPs)', () => {
    const request = buildRequest({
      'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1, 203.0.113.1, 203.0.113.2',
    });
    // TRUSTED_HOPS = 2，最多 3 個 IPs，這裡有 5 個，跳過最後 2 個
    expect(getClientIp(request)).toBe('172.16.0.1');
  });

  it('should handle single IP in XFF', () => {
    const request = buildRequest({ 'x-forwarded-for': '192.168.1.1' });
    expect(getClientIp(request)).toBe('192.168.1.1');
  });

  it('should treat empty XFF as missing and fall back to x-real-ip', () => {
    const request = buildRequest({ 'x-forwarded-for': '', 'x-real-ip': '203.0.113.5' });
    expect(getClientIp(request)).toBe('203.0.113.5');
  });

  it('should not throw on IPv6 client IP', () => {
    const request = buildRequest({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1, 172.16.0.1' });
    expect(getClientIp(request)).toBe('2001:db8::1');
  });
});
