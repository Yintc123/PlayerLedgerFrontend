// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ActivePlayerChip } from './active-player-chip';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => pushMock.mockReset());

describe('ActivePlayerChip', () => {
  it('should NOT render when no playerId is focused', () => {
    const { container } = render(<ActivePlayerChip query={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('should render the focused playerName when provided', () => {
    render(
      <ActivePlayerChip playerId="01HABCD" playerName="玩家小王" query={{ playerId: '01HABCD' }} />
    );
    expect(screen.getByText('玩家小王')).toBeInTheDocument();
  });

  it('should fall back to a playerId fragment when playerName is unavailable', () => {
    render(<ActivePlayerChip playerId="0193b3f4-1234" query={{ playerId: '0193b3f4-1234' }} />);
    expect(screen.getByText('0193b3f4')).toBeInTheDocument(); // first 8 chars
  });

  it('should router.push without playerId (preserving other filters) when clear is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ActivePlayerChip
        playerId="01HABCD"
        playerName="玩家小王"
        query={{ playerId: '01HABCD', status: ['pending'] }}
      />
    );
    await user.click(screen.getByRole('button', { name: '清除玩家聚焦' }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?status=pending');
  });

  it('should expose an accessible clear button (aria-label)', () => {
    render(<ActivePlayerChip playerId="01HABCD" query={{ playerId: '01HABCD' }} />);
    expect(screen.getByRole('button', { name: '清除玩家聚焦' })).toBeInTheDocument();
  });
});
