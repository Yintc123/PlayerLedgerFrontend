import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTimeSeconds } from '@/lib/format/datetime';
import { paymentMethodLabel } from '@/lib/topups/labels';
import type { DepositRecord } from '@/lib/topups/types';
import { CopyButton } from './copy-button';

/**
 * 交易資訊卡（spec 11 §4.3，對齊後端 DepositRecord）。`<dl><dt><dd>` 描述列表語意。
 * `null` 欄位整列隱藏（非顯示「—」）。id / referenceNo 等寬字型 + CopyButton；
 * playerId 連回玩家詳情並一併顯示 playerName。時間皆含秒。
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2.5 last:border-b-0">
      <dt className="text-muted-foreground shrink-0 text-sm">{label}</dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
}

export function TransactionCard({ record }: { record: DepositRecord }) {
  const {
    id,
    playerId,
    playerName,
    referenceNo,
    paymentMethod,
    internalNote,
    displayNote,
    operatorId,
    operatorIp,
    createdAt,
    updatedAt,
  } = record;

  return (
    <Card>
      <CardHeader>
        <CardTitle>交易資訊</CardTitle>
      </CardHeader>
      <CardContent>
        <dl>
          <Field label="紀錄 ID">
            <span className="inline-flex items-center justify-end gap-1">
              <span className="font-mono break-all">{id}</span>
              <CopyButton value={id} label="紀錄 ID" />
            </span>
          </Field>

          <Field label="玩家">
            <a href={`/players/${playerId}`} className="text-blue-600 hover:underline">
              {playerName}
              <span className="text-muted-foreground ml-1 font-mono text-xs">{playerId}</span>
            </a>
          </Field>

          {referenceNo !== null && (
            <Field label="金流交易號">
              <span className="inline-flex items-center justify-end gap-1">
                <span className="font-mono break-all">{referenceNo}</span>
                <CopyButton value={referenceNo} label="金流交易號" />
              </span>
            </Field>
          )}

          <Field label="支付方式">{paymentMethodLabel(paymentMethod)}</Field>

          {internalNote !== null && <Field label="內部備註">{internalNote}</Field>}

          {displayNote !== null && <Field label="顯示備註">{displayNote}</Field>}

          {operatorId !== null && (
            <Field label="操作人員">
              <span className="font-mono break-all">{operatorId}</span>
            </Field>
          )}

          {operatorIp !== null && (
            <Field label="操作 IP">
              <span className="font-mono">{operatorIp}</span>
            </Field>
          )}

          <Field label="建立時間">{formatDateTimeSeconds(createdAt)}</Field>

          <Field label="更新時間">{formatDateTimeSeconds(updatedAt)}</Field>
        </dl>
      </CardContent>
    </Card>
  );
}
