import { NextResponse } from 'next/server'
import { getDeepHealth } from '@/lib/health/checks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const health = await getDeepHealth()

  const statusCode = health.status === 'ok' ? 200 : 503

  return NextResponse.json(health, {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
