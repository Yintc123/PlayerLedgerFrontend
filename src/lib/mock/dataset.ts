/**
 * Mock 資料集（UI-first 開發；後端就緒前的暫時資料來源）。
 *
 * 真實版資料層會走 BFF proxy / lib 呼叫上游；此處以記憶體資料模擬，
 * 讓所有 CMS 畫面在無後端時可開發、可手動 demo 各種狀態。
 *
 * 錯誤態觸發（供手動驗證 UI）：
 *   playerId / 搜尋欄位含 "forbidden" → 403、"notfound" → 404、
 *   "ratelimited" → 429、"boom" → 500。
 */
import { ApiError } from '@/lib/api/errors';
import type { Player } from '@/lib/players/types';
import type { DepositRecord, TopupSummary } from '@/lib/topups/types';

export const MOCK_PLAYERS: Player[] = [
  {
    playerId: '01HABCDXYZ0000000000000001',
    externalId: 'GAME-UID-1001',
    displayName: '玩家小王',
    email: 'wang@example.com',
    phone: '+886912345678',
    status: 'active',
    registeredAt: '2025-03-04T10:23:11Z',
    lastActiveAt: '2026-06-26T08:11:00Z',
  },
  {
    playerId: '01HABCDXYZ0000000000000002',
    externalId: null,
    displayName: '林大明',
    email: 'l***@example.com',
    phone: '****5678',
    status: 'frozen',
    registeredAt: '2024-11-20T02:00:00Z',
    lastActiveAt: '2026-05-01T12:30:00Z',
  },
  {
    playerId: '01HABCDXYZ0000000000000003',
    externalId: 'GAME-UID-2087',
    displayName: '林小芳',
    email: null,
    phone: null,
    status: 'closed',
    registeredAt: '2023-07-15T08:45:00Z',
    lastActiveAt: null,
  },
  {
    playerId: '01HABCDXYZ0000000000000004',
    externalId: 'GAME-UID-3120',
    displayName: 'CryptoWhale',
    email: 'whale@example.com',
    phone: '+14155550123',
    status: 'active',
    registeredAt: '2025-12-01T00:00:00Z',
    lastActiveAt: '2026-06-28T22:05:00Z',
  },
  {
    playerId: '01HABCDXYZ0000000000000005',
    externalId: null,
    displayName: '陳怡君',
    email: 'chen.yi@example.com',
    phone: '+886988111222',
    status: 'active',
    registeredAt: '2026-01-09T14:00:00Z',
    lastActiveAt: '2026-06-20T09:00:00Z',
  },
];

// 種子省略 player 識別欄位（由下方 map 注入 playerId / playerName）。
type MockDepositSeed = Omit<DepositRecord, 'playerId' | 'playerName'>;

const OP_ID = '01HCMSADMIN0000000000000001';
const OP_IP = '203.0.113.10';

const PLAYER_1_DEPOSITS: MockDepositSeed[] = [
  {
    id: '01HXYZ000000000000000000R1',
    amount: 199, // TWD 元（後端最小單位＝元）
    currency: 'TWD',
    status: 'completed',
    paymentMethod: 'credit_card',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: '金流商已確認入帳',
    displayNote: '信用卡儲值',
    referenceNo: 'TXN-20260625-001',
    createdAt: '2026-06-25T14:00:00Z',
    updatedAt: '2026-06-25T14:00:32Z',
  },
  {
    id: '01HXYZ000000000000000000R2',
    amount: 990,
    currency: 'TWD',
    status: 'refunded',
    paymentMethod: 'e_wallet',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: '玩家申請退款，已退',
    displayNote: '電子錢包儲值',
    referenceNo: 'TXN-20260620-002',
    createdAt: '2026-06-20T03:11:22Z',
    updatedAt: '2026-06-22T10:00:00Z',
  },
  {
    id: '01HXYZ000000000000000000R3',
    amount: 50,
    currency: 'TWD',
    status: 'failed',
    paymentMethod: 'convenience_store',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: '超商代收逾期未付',
    displayNote: null,
    referenceNo: null,
    createdAt: '2026-06-18T19:30:00Z',
    updatedAt: '2026-06-19T19:30:00Z',
  },
  {
    id: '01HXYZ000000000000000000R4',
    amount: 300,
    currency: 'TWD',
    status: 'pending',
    paymentMethod: 'bank_transfer',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: '等待銀行入帳通知',
    displayNote: '銀行轉帳儲值',
    referenceNo: 'TXN-20260629-004',
    createdAt: '2026-06-29T01:00:00Z',
    updatedAt: '2026-06-29T01:00:00Z',
  },
  {
    id: '01HXYZ000000000000000000R5',
    amount: 120,
    currency: 'TWD',
    status: 'cancelled',
    paymentMethod: 'manual',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: '玩家取消',
    displayNote: null,
    referenceNo: null,
    createdAt: '2026-06-10T08:00:00Z',
    updatedAt: '2026-06-10T09:00:00Z',
  },
  {
    id: '01HXYZ000000000000000000R6',
    amount: 500,
    currency: 'TWD',
    status: 'completed',
    paymentMethod: 'credit_card',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: null,
    displayNote: '信用卡儲值',
    referenceNo: 'TXN-20260530-006',
    createdAt: '2026-05-30T11:20:00Z',
    updatedAt: '2026-05-30T11:20:18Z',
  },
];

const PLAYER_4_DEPOSITS: MockDepositSeed[] = [
  {
    id: '01HXYZ000000000000000000W1',
    amount: 10050, // USD cents → $100.50
    currency: 'USD',
    status: 'completed',
    paymentMethod: 'e_wallet',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: null,
    displayNote: 'USDT 入帳',
    referenceNo: 'TXN-USD-7001',
    createdAt: '2026-06-28T20:00:00Z',
    updatedAt: '2026-06-28T20:03:00Z',
  },
  {
    id: '01HXYZ000000000000000000W2',
    amount: 50000, // USD cents → $500.00
    currency: 'USD',
    status: 'completed',
    paymentMethod: 'e_wallet',
    operatorId: OP_ID,
    operatorIp: OP_IP,
    internalNote: null,
    displayNote: 'USDT 入帳',
    referenceNo: 'TXN-USD-7002',
    createdAt: '2026-06-15T18:00:00Z',
    updatedAt: '2026-06-15T18:04:00Z',
  },
];

function withPlayer(seeds: MockDepositSeed[], playerIndex: number): DepositRecord[] {
  const player = MOCK_PLAYERS[playerIndex];
  return seeds.map((s) => ({ ...s, playerId: player.playerId, playerName: player.displayName }));
}

/** playerId → 該玩家的儲值紀錄（已附 playerId / playerName）。 */
export const MOCK_TOPUPS_BY_PLAYER: Record<string, DepositRecord[]> = {
  [MOCK_PLAYERS[0].playerId]: withPlayer(PLAYER_1_DEPOSITS, 0),
  [MOCK_PLAYERS[3].playerId]: withPlayer(PLAYER_4_DEPOSITS, 3),
};

/** 全部儲值紀錄（供 /cms/deposit-records 無 player 篩選的列表）。 */
export const MOCK_ALL_DEPOSITS: DepositRecord[] = Object.values(MOCK_TOPUPS_BY_PLAYER).flat();

export const MOCK_SUMMARY_BY_PLAYER: Record<string, TopupSummary> = {
  [MOCK_PLAYERS[0].playerId]: {
    playerId: MOCK_PLAYERS[0].playerId,
    totalsByCurrency: [
      {
        currency: 'TWD',
        successCount: 2,
        successAmount: 3000, // TWD 元
        refundedCount: 1,
        refundedAmount: 990,
        failedCount: 1,
        refundRate: 0.33, // > 0.3 → 觸發警示 tag（demo）
      },
    ],
    firstTopupAt: '2026-05-30T11:20:18Z',
    lastTopupAt: '2026-06-25T14:00:32Z',
    lifetimeDays: 26,
  },
  [MOCK_PLAYERS[3].playerId]: {
    playerId: MOCK_PLAYERS[3].playerId,
    totalsByCurrency: [
      {
        currency: 'USD',
        successCount: 2,
        successAmount: 60050, // USD cents
        refundedCount: 0,
        refundedAmount: 0,
        failedCount: 0,
        refundRate: 0,
      },
    ],
    firstTopupAt: '2026-06-15T18:04:00Z',
    lastTopupAt: '2026-06-28T20:03:00Z',
    lifetimeDays: 13,
  },
};

/** 依玩家取 mock 紀錄；未定義者回空陣列。 */
export function mockTopupsFor(playerId: string): DepositRecord[] {
  return MOCK_TOPUPS_BY_PLAYER[playerId] ?? [];
}

/** 依玩家取 mock 彙總；未定義者回空彙總（尚未儲值）。 */
export function mockSummaryFor(playerId: string): TopupSummary {
  return (
    MOCK_SUMMARY_BY_PLAYER[playerId] ?? {
      playerId,
      totalsByCurrency: [],
      firstTopupAt: null,
      lastTopupAt: null,
      lifetimeDays: null,
    }
  );
}

/** 依任一字串觸發錯誤態（手動 demo 用）；無觸發回 null。 */
export function errorTriggerFor(value: string | undefined): ApiError | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes('forbidden')) return new ApiError(403, 'forbidden', '您的角色無權使用此功能');
  if (v.includes('notfound')) return new ApiError(404, 'resource_not_found', '找不到資源');
  if (v.includes('ratelimited')) return new ApiError(429, 'too_many_requests', '請求過於頻繁', 10);
  if (v.includes('boom')) return new ApiError(500, 'upstream_failure', '伺服器錯誤');
  return null;
}
