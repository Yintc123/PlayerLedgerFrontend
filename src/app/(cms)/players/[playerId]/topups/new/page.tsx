import { redirect } from 'next/navigation';
import { createDeposit } from '@/lib/topups/create';
import { isApiError } from '@/lib/api/errors';
import { recordMetric } from '@/lib/observability/ui-metrics';
import type { PaymentMethod } from '@/lib/topups/types';
import { CreateDepositForm, type CreateDepositState } from './_components/create-form';

function optional(data: FormData, key: string): string | undefined {
  const v = String(data.get(key) ?? '').trim();
  return v.length > 0 ? v : undefined;
}

/**
 * 建立儲值頁（spec 10 §3）。Server Component：定義 Server Action，建立成功後導回列表。
 */
export default async function CreateDepositPage({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;

  async function createAction(
    _prev: CreateDepositState,
    formData: FormData
  ): Promise<CreateDepositState> {
    'use server';

    const amount = Number(String(formData.get('amount') ?? '').trim());
    const paymentMethod = String(formData.get('paymentMethod') ?? '').trim() as PaymentMethod;

    try {
      await createDeposit({
        playerId,
        amount,
        currency: optional(formData, 'currency') ?? 'TWD',
        paymentMethod,
        internalNote: optional(formData, 'internalNote'),
        displayNote: optional(formData, 'displayNote'),
        referenceNo: optional(formData, 'referenceNo'),
      });
    } catch (err) {
      recordMetric('topups.create.error', { code: isApiError(err) ? err.code : 'unknown' });
      if (isApiError(err)) return { error: err.message };
      throw err;
    }

    recordMetric('topups.create.success', {});
    redirect(`/players/${playerId}/topups`);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">建立儲值</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          手動建立一筆儲值紀錄；初始狀態為「等待處理」。
        </p>
      </header>

      <CreateDepositForm playerId={playerId} action={createAction} />
    </div>
  );
}
