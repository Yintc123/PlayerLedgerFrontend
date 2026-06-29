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

describe('Pagination (numbered)', () => {
  it('should NOT render when total <= pageSize (single page)', () => {
    const { container } = render(
      <Pagination basePath="/players/p1/topups" query={{}} page={1} pageSize={20} total={8} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('should render numbered page buttons when multiple pages exist', () => {
    render(
      <Pagination basePath="/players/p1/topups" query={{}} page={1} pageSize={20} total={45} />
    );
    // 45/20 = 3 頁
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
  });

  it('should mark the current page with aria-current="page"', () => {
    render(
      <Pagination
        basePath="/players/p1/topups"
        query={{ page: 2 }}
        page={2}
        pageSize={20}
        total={45}
      />
    );
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '1' })).not.toHaveAttribute('aria-current');
  });

  it('should disable 上一頁 on the first page', () => {
    render(
      <Pagination basePath="/players/p1/topups" query={{}} page={1} pageSize={20} total={45} />
    );
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一頁' })).toBeEnabled();
  });

  it('should disable 下一頁 on the last page', () => {
    render(
      <Pagination
        basePath="/players/p1/topups"
        query={{ page: 3 }}
        page={3}
        pageSize={20}
        total={45}
      />
    );
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一頁' })).toBeEnabled();
  });

  it('should push basePath with page=N (filters preserved) when a page is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        basePath="/players/p1/topups"
        query={{ status: ['pending'] }}
        page={1}
        pageSize={20}
        total={45}
      />
    );
    await user.click(screen.getByRole('button', { name: '2' }));
    expect(pushMock).toHaveBeenCalledWith('/players/p1/topups?page=2&status=pending');
  });

  it('should omit the page param when navigating to page 1 (clean default URL)', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        basePath="/deposit-records"
        query={{ playerId: 'P1', page: 2 }}
        page={2}
        pageSize={20}
        total={45}
      />
    );
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?playerId=P1');
  });

  it('should work with an arbitrary basePath (cross-player, playerId preserved)', async () => {
    const user = userEvent.setup();
    render(
      <Pagination
        basePath="/deposit-records"
        query={{ playerId: '01HABCD' }}
        page={1}
        pageSize={20}
        total={45}
      />
    );
    await user.click(screen.getByRole('button', { name: '2' }));
    expect(pushMock).toHaveBeenCalledWith('/deposit-records?playerId=01HABCD&page=2');
  });

  it('should render ellipsis (…) when pages exceed the visible window', () => {
    render(
      <Pagination
        basePath="/players/p1/topups"
        query={{ page: 5 }}
        page={5}
        pageSize={20}
        total={200}
      />
    );
    // 10 頁，current=5 → [1 … 4 5 6 … 10]
    expect(screen.getAllByText('…').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: '1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument();
  });

  it('should expose aria-busy on the pagination nav', () => {
    render(
      <Pagination basePath="/players/p1/topups" query={{}} page={1} pageSize={20} total={45} />
    );
    expect(screen.getByRole('navigation', { name: '分頁' })).toHaveAttribute('aria-busy');
  });
});
