// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProfileCard } from './profile-card';
import { formatDateTime } from '@/lib/format/datetime';
import type { Player } from '@/lib/players/types';

const base: Player = {
  playerId: '01HABCDXYZ0000000000000001',
  externalId: 'GAME-UID-1001',
  displayName: '玩家小王',
  email: 'wang@example.com',
  phone: '+886912345678',
  status: 'active',
  registeredAt: '2025-03-04T10:23:11Z',
  lastActiveAt: '2026-06-26T08:11:00Z',
};

describe('ProfileCard', () => {
  it('should render displayName as primary heading', () => {
    render(<ProfileCard player={base} />);
    expect(screen.getByRole('heading', { name: '玩家小王' })).toBeInTheDocument();
  });

  it('should render status tag with active/frozen/closed visual variant', () => {
    const { rerender } = render(<ProfileCard player={base} />);
    expect(screen.getByText('正常')).toBeInTheDocument();

    rerender(<ProfileCard player={{ ...base, status: 'frozen' }} />);
    expect(screen.getByText('凍結')).toBeInTheDocument();

    rerender(<ProfileCard player={{ ...base, status: 'closed' }} />);
    expect(screen.getByText('已關閉')).toBeInTheDocument();
  });

  it('should render playerId in monospace with Copy button', () => {
    render(<ProfileCard player={base} />);
    const idNode = screen.getByText(base.playerId);
    expect(idNode).toBeInTheDocument();
    expect(idNode.className).toContain('font-mono');
    expect(screen.getByRole('button', { name: '複製玩家 ID' })).toBeInTheDocument();
  });

  it('should hide externalId row when value is null', () => {
    render(<ProfileCard player={{ ...base, externalId: null }} />);
    expect(screen.queryByText('外部 ID')).not.toBeInTheDocument();
  });

  it('should render externalId row when value is present', () => {
    render(<ProfileCard player={base} />);
    expect(screen.getByText('外部 ID')).toBeInTheDocument();
    expect(screen.getByText('GAME-UID-1001')).toBeInTheDocument();
  });

  it('should render "—" when email is null', () => {
    render(<ProfileCard player={{ ...base, email: null }} />);
    expect(screen.getByText('Email').nextElementSibling).toHaveTextContent('—');
  });

  it('should render "—" when phone is null', () => {
    render(<ProfileCard player={{ ...base, phone: null }} />);
    expect(screen.getByText('手機').nextElementSibling).toHaveTextContent('—');
  });

  it('should render masked email verbatim (a***@example.com)', () => {
    render(<ProfileCard player={{ ...base, email: 'a***@example.com' }} />);
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
  });

  it('should render E.164 phone with grouping for display only (does not mutate value)', () => {
    const player = { ...base, phone: '+886912345678' };
    render(<ProfileCard player={player} />);
    expect(screen.getByText('+886 912 345 678')).toBeInTheDocument();
    expect(player.phone).toBe('+886912345678');
  });

  it('should render registeredAt in user timezone format', () => {
    render(<ProfileCard player={base} />);
    expect(screen.getByText(formatDateTime(base.registeredAt))).toBeInTheDocument();
  });

  it('should render "—" when lastActiveAt is null', () => {
    render(<ProfileCard player={{ ...base, lastActiveAt: null }} />);
    expect(screen.getByText('最近活動').nextElementSibling).toHaveTextContent('—');
  });
});
