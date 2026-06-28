import { NextResponse } from 'next/server'
import { getShallowHealth } from '@/lib/health/checks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const health = await getShallowHealth()

  const statusCode = health.status === 'ok' ? 200 : 503

  return NextResponse.json(health, {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
