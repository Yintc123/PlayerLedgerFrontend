import type { NextConfig } from 'next';

// HSTS 只在實際以 HTTPS 對外服務時送（ENABLE_HSTS=true）。
// PoC 階段 ALB 只有 HTTP listener，送 HSTS 會讓瀏覽器強制升級 https → 連不到。
const SECURITY_HEADERS = [
  ...(process.env.ENABLE_HSTS === 'true'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;
