// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ResultRow } from './result-row';
import type { Player } from '@/lib/players/types';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const base: Player = {
  playerId: '01HABCD',
  externalId: null,
  displayName: '玩家小王',
  email: 'a***@example.com',
  phone: '+886912345678',
  status: 'active',
  registeredAt: '2026-06-20T03:11:22Z',
  lastActiveAt: '2026-06-26T08:11:00Z',
};

beforeEach(() => pushMock.mockReset());

describe('ResultRow', () => {
  it('should render displayName, playerId, email, phone, status, registeredAt', () => {
    render(<ResultRow player={base} />);
    expect(screen.getByText('玩家小王')).toBeInTheDocument();
    expect(screen.getByText('01HABCD')).toBeInTheDocument();
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
    expect(screen.getByText('+886 912 345 678')).toBeInTheDocument();
    expect(screen.getByText('正常')).toBeInTheDocument();
  });

  it('should render "—" when email is null', () => {
    render(<ResultRow player={{ ...base, email: null, phone: null, lastActiveAt: null }} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('should render masked email verbatim without transformation', () => {
    render(<ResultRow player={base} />);
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
  });

  it('should navigate to /players/<playerId> when row clicked', async () => {
    const user = userEvent.setup();
    render(<ResultRow player={base} />);
    await user.click(screen.getByRole('listitem'));
    expect(pushMock).toHaveBeenCalledWith('/players/01HABCD');
  });

  it('should navigate when Enter pressed with row focused', async () => {
    const user = userEvent.setup();
    render(<ResultRow player={base} />);
    screen.getByRole('listitem').focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenCalledWith('/players/01HABCD');
  });

  it('should be focusable (tabIndex 0)', () => {
    render(<ResultRow player={base} />);
    expect(screen.getByRole('listitem')).toHaveAttribute('tabindex', '0');
  });
});
