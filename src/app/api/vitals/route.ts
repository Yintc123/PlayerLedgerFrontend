import { NextRequest, NextResponse } from 'next/server';
import { getRequestLogger } from '@/lib/logger/logger';
import { metric } from '@/lib/observability/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WebVitalMetric = {
  name: string;
  value: number;
  id: string;
  navigationType?: string;
};

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID();
  const reqLogger = getRequestLogger(requestId);

  try {
    // 接受 JSON 或 form-urlencoded（sendBeacon 發送的）
    const contentType = request.headers.get('content-type') || '';
    const body: WebVitalMetric[] = [];

    if (contentType.includes('application/json')) {
      const json = await request.json();
      body.push(json as WebVitalMetric);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      // sendBeacon 會送單個指標
      const name = formData.get('name') as string;
      const value = parseFloat(formData.get('value') as string);
      const id = formData.get('id') as string;
      const navigationType = formData.get('navigationType') as string | null;

      if (name && !isNaN(value)) {
        body.push({ name, value, id, navigationType: navigationType || undefined });
      }
    }

    // 發佈每個 vital
    for (const vital of body) {
      if (!vital.name || isNaN(vital.value)) continue;

      metric(`http.client.web_vitals`, vital.value, 'Milliseconds', {
        name: vital.name,
        navigationType: vital.navigationType || 'navigation',
      });

      reqLogger.info(
        {
          type: 'client.web_vitals',
          metricName: vital.name,
          value: vital.value,
          id: vital.id,
        },
        'Web Vital reported'
      );
    }

    return NextResponse.json({ success: true, requestId }, { status: 200 });
  } catch (err) {
    reqLogger.error(
      {
        type: 'http.response',
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      },
      'Vitals endpoint error'
    );

    return NextResponse.json({ error: 'server_error', requestId }, { status: 500 });
  }
}
