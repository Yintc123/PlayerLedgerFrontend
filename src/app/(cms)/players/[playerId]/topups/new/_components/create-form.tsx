'use client';

import { useActionState, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PAYMENT_METHOD_OPTIONS } from '@/lib/topups/labels';

export type CreateDepositState = { error?: string };

const INITIAL: CreateDepositState = {};

/**
 * 建立儲值表單（spec 10 §3 / deposit-records-api §4.1）。
 *
 * Client Component：提交前做基本驗證（amount 為正整數、payment_method 必填），
 * 通過後交由父層傳入的 Server Action 實際建立並導頁。Server Action 回傳之錯誤
 * （404 玩家不存在 / 409 reference_no 重複 / 400 金額錯誤）透過 useActionState 呈現。
 */
export function CreateDepositForm({
  playerId,
  action,
}: {
  playerId: string;
  action: (state: CreateDepositState, formData: FormData) => Promise<CreateDepositState>;
}) {
  const [state, submitAction] = useActionState(action, INITIAL);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    // 一律阻止原生提交；客端驗證通過後才手動派發 Server Action。
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const amountRaw = String(data.get('amount') ?? '').trim();
    const method = String(data.get('paymentMethod') ?? '').trim();

    let ok = true;
    if (!/^\d+$/.test(amountRaw) || Number(amountRaw) < 1) {
      setAmountError('金額須為大於等於 1 的整數');
      ok = false;
    } else {
      setAmountError(null);
    }
    if (!method) {
      setMethodError('請選擇支付方式');
      ok = false;
    } else {
      setMethodError(null);
    }
    if (ok) submitAction(data);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="建立儲值表單"
      className="max-w-lg space-y-5 rounded-xl border bg-white p-6"
    >
      <input type="hidden" name="playerId" value={playerId} />

      {state.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="amount">金額（最小單位整數）</Label>
        <Input
          id="amount"
          name="amount"
          type="number"
          min={1}
          step={1}
          required
          aria-invalid={amountError != null}
        />
        {amountError && (
          <p role="alert" className="text-destructive text-xs">
            {amountError}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="currency">幣別</Label>
        <Input id="currency" name="currency" defaultValue="TWD" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="paymentMethod">支付方式</Label>
        <select
          id="paymentMethod"
          name="paymentMethod"
          required
          defaultValue=""
          aria-invalid={methodError != null}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        >
          <option value="" disabled>
            請選擇
          </option>
          {PAYMENT_METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {methodError && (
          <p role="alert" className="text-destructive text-xs">
            {methodError}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="referenceNo">參考號（選填）</Label>
        <Input id="referenceNo" name="referenceNo" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="internalNote">內部備註（選填）</Label>
        <Input id="internalNote" name="internalNote" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="displayNote">顯示備註（選填）</Label>
        <Input id="displayNote" name="displayNote" />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit">建立</Button>
        <a
          href={`/players/${playerId}/topups`}
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          取消
        </a>
      </div>
    </form>
  );
}
