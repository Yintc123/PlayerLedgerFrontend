// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ResultList } from './result-list';
import type { Player } from '@/lib/players/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

describe('ResultList', () => {
  it('should render one ResultRow per player', () => {
    render(<ResultList players={[makePlayer('a'), makePlayer('b'), makePlayer('c')]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('should render no rows when players array is empty', () => {
    render(<ResultList players={[]} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('should expose role="list" on the container', () => {
    render(<ResultList players={[makePlayer('a')]} />);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
