import { NextRequest } from 'next/server'

// 從請求中提取客戶端 IP（ADR 011 + spec 01 §4.2）
// Next.js 15+ 已移除 NextRequest.ip — 改靠 proxy 注入的 header。
// 信任代理鏈：CloudFront → API Gateway → ECS Task，TRUSTED_PROXY_HOPS = 2。
const TRUSTED_HOPS = 2

export function getClientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for')

  if (!xff) {
    return request.headers.get('x-real-ip') || '0.0.0.0'
  }

  const ips = xff.split(',').map((ip) => ip.trim()).filter(Boolean)
  if (ips.length === 0) {
    return request.headers.get('x-real-ip') || '0.0.0.0'
  }

  if (ips.length > TRUSTED_HOPS + 1) {
    return ips[ips.length - TRUSTED_HOPS - 1] || '0.0.0.0'
  }

  return ips[0] || '0.0.0.0'
}
