import { NextResponse } from 'next/server';
import { getReadiness } from '@/lib/health/checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Readiness probe（內部依賴監控 / dashboard）。
// 檢查 BFF 內部依賴 Redis：失敗回 503。**禁止放進 ECS Target Group**——
// 不應讓 Redis 抖動觸發 task 替換，連鎖風險由 ADR 022 處理；改由
// health.readiness.failure metric + alarm 監控（spec 03 §3.3）。
export async function GET() {
  const health = await getReadiness();

  const statusCode = health.status === 'ok' ? 200 : 503;

  return NextResponse.json(health, {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
