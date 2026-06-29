import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format/datetime';
import { formatPhoneForDisplay } from '@/lib/format/phone';
import type { Player } from '@/lib/players/types';
import { StatusTag } from './status-tag';
import { CopyButton } from './copy-button';

const DASH = '—';

/**
 * 基本資料卡（spec 09 §4.2 / §8.1）。Server Component：純展示，無互動。
 * 遮罩 / null 由後端決定，UI 只依資料 render（複製按鈕為 Client 子元件）。
 */
export function ProfileCard({ player }: { player: Player }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{player.displayName}</h2>
          <StatusTag status={player.status} />
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">玩家 ID</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-sm break-all">{player.playerId}</span>
            <CopyButton value={player.playerId} />
          </dd>

          {player.externalId !== null && (
            <>
              <dt className="text-muted-foreground">外部 ID</dt>
              <dd className="font-mono text-sm break-all">{player.externalId}</dd>
            </>
          )}

          <dt className="text-muted-foreground">Email</dt>
          <dd className="break-all">{player.email ?? DASH}</dd>

          <dt className="text-muted-foreground">手機</dt>
          <dd>{player.phone ? formatPhoneForDisplay(player.phone) : DASH}</dd>

          <dt className="text-muted-foreground">註冊時間</dt>
          <dd>{formatDateTime(player.registeredAt)}</dd>

          <dt className="text-muted-foreground">最近活動</dt>
          <dd>{player.lastActiveAt ? formatDateTime(player.lastActiveAt) : DASH}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
