// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Pagination } from './pagination';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => pushMock.mockReset());

describe('Pagination', () => {
  it('should NOT render button when on the last page (page*pageSize >= total)', () => {
    render(<Pagination playerId="p1" query={{}} page={2} pageSize={20} total={40} />);
    expect(screen.queryByRole('button', { name: '載入更多' })).not.toBeInTheDocument();
  });

  it('should render button when more pages remain', () => {
    render(<Pagination playerId="p1" query={{}} page={1} pageSize={20} total={40} />);
    expect(screen.getByRole('button', { name: '載入更多' })).toBeInTheDocument();
  });

  it('should push URL with page+1 (preserving filters) when clicked', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        playerId="p1"
        query={{ status: ['pending'], page: 1 }}
        page={1}
        pageSize={20}
        total={40}
      />
    );
    await user.click(screen.getByRole('button', { name: '載入更多' }));
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups?page=2&status=pending');
  });

  it('should expose aria-busy on the load-more button', () => {
    render(<Pagination playerId="p1" query={{}} page={1} pageSize={20} total={40} />);
    expect(screen.getByRole('button', { name: '載入更多' })).toHaveAttribute('aria-busy');
  });
});
