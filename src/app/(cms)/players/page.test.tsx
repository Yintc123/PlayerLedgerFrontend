// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ApiError } from '@/lib/api/errors';
import type { Player } from '@/lib/players/types';

const searchPlayersMock = vi.fn();
vi.mock('@/lib/players/search', () => ({ searchPlayers: (q: unknown) => searchPlayersMock(q) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const recordMetricMock = vi.fn();
vi.mock('@/lib/observability/ui-metrics', () => ({
  recordMetric: (...a: unknown[]) => recordMetricMock(...a),
}));

import PlayersPage, { PlayersResult } from './page';

function makePlayer(id: string): Player {
  return {
    playerId: id,
    externalId: null,
    displayName: `玩家${id}`,
    email: null,
    phone: null,
    status: 'active',
    registeredAt: '2026-06-20T03:11:22Z',
    lastActiveAt: null,
  };
}

beforeEach(() => {
  searchPlayersMock.mockReset();
  recordMetricMock.mockReset();
});

describe('PlayersPage', () => {
  it('should render idle EmptyState and SearchForm when URL has no search params', async () => {
    const ui = await PlayersPage({ searchParams: Promise.resolve({}) });
    render(ui);
    // PlayersResult is a nested async RSC; render its resolved output too
    render(await PlayersResult({ query: {} }));
    expect(screen.getByText('輸入玩家資訊以開始查詢')).toBeInTheDocument();
    expect(searchPlayersMock).not.toHaveBeenCalled();
  });
});

describe('PlayersResult', () => {
  it('should call searchPlayers with parsed query when query has search fields', async () => {
    searchPlayersMock.mockResolvedValue({ players: [], nextCursor: null });
    render(await PlayersResult({ query: { displayName: '王' } }));
    expect(searchPlayersMock).toHaveBeenCalledWith({ displayName: '王' });
  });

  it('should render ResultList when searchPlayers returns players', async () => {
    searchPlayersMock.mockResolvedValue({ players: [makePlayer('a'), makePlayer('b')], nextCursor: null });
    render(await PlayersResult({ query: { displayName: '玩' } }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('should render no-results EmptyState when searchPlayers returns empty array', async () => {
    searchPlayersMock.mockResolvedValue({ players: [], nextCursor: null });
    render(await PlayersResult({ query: { displayName: 'zzz' } }));
    expect(screen.getByText('找不到符合條件的玩家')).toBeInTheDocument();
  });

  it('should render forbidden ErrorState when searchPlayers throws 403', async () => {
    searchPlayersMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await PlayersResult({ query: { displayName: '王' } }));
    expect(screen.getByText('無權使用玩家查詢功能')).toBeInTheDocument();
  });

  it('should render rate-limited ErrorState when searchPlayers throws 429', async () => {
    searchPlayersMock.mockRejectedValue(new ApiError(429, 'too_many_requests', undefined, 5));
    render(await PlayersResult({ query: { displayName: '王' } }));
    expect(screen.getByText('請求過於頻繁')).toBeInTheDocument();
  });

  it('should render server-error ErrorState when searchPlayers throws 500', async () => {
    searchPlayersMock.mockRejectedValue(new ApiError(500, 'upstream_failure'));
    render(await PlayersResult({ query: { displayName: '王' } }));
    expect(screen.getByText('發生錯誤')).toBeInTheDocument();
  });

  it('should render "Load more" when nextCursor is not null', async () => {
    searchPlayersMock.mockResolvedValue({ players: [makePlayer('a')], nextCursor: 'NEXT' });
    render(await PlayersResult({ query: { displayName: '玩' } }));
    expect(screen.getByRole('button', { name: '載入更多' })).toBeInTheDocument();
  });

  it('should NOT render "Load more" when nextCursor is null', async () => {
    searchPlayersMock.mockResolvedValue({ players: [makePlayer('a')], nextCursor: null });
    render(await PlayersResult({ query: { displayName: '玩' } }));
    expect(screen.queryByRole('button', { name: '載入更多' })).not.toBeInTheDocument();
  });

  it('should emit players.search.result_count metric on successful render', async () => {
    searchPlayersMock.mockResolvedValue({ players: [makePlayer('a')], nextCursor: null });
    render(await PlayersResult({ query: { displayName: '玩' } }));
    expect(recordMetricMock).toHaveBeenCalledWith('players.search.result_count', { count: 1 });
  });

  it('should emit players.search.error metric on error render', async () => {
    searchPlayersMock.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(await PlayersResult({ query: { displayName: '王' } }));
    expect(recordMetricMock).toHaveBeenCalledWith('players.search.error', { code: 'forbidden' });
  });
});
