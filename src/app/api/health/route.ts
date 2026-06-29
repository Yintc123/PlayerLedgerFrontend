import { NextResponse } from 'next/server';
import { getLiveness } from '@/lib/health/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness probe（ECS Target Group + Docker HEALTHCHECK）。
// 只反映 BFF process 自身能否服務，不查 Redis / 上游——依賴檢查見 /api/health/ready
// 與 /api/health/deep（ADR 022）。永遠 200；process 死掉時自然無法回應，ECS 自會判定 unhealthy。
export async function GET() {
  const health = getLiveness();

  return NextResponse.json(health, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
