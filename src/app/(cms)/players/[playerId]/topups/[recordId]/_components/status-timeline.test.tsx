// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatusTimeline } from './status-timeline';

const created = '2026-06-20T03:11:22Z';
const updated = '2026-06-20T03:11:45Z';

describe('StatusTimeline', () => {
  it('should render two steps: 建立 / 目前狀態', () => {
    render(<StatusTimeline status="completed" createdAt={created} updatedAt={updated} />);
    expect(screen.getByText('建立')).toBeInTheDocument();
    expect(screen.getByText('目前狀態')).toBeInTheDocument();
  });

  it('should always render the 建立 step as reached', () => {
    render(<StatusTimeline status="pending" createdAt={created} updatedAt={created} />);
    expect(screen.getByText('建立').closest('li')).toHaveAttribute('data-reached', 'true');
  });

  it('should render 目前狀態 as not reached when status is pending and updatedAt equals createdAt', () => {
    render(<StatusTimeline status="pending" createdAt={created} updatedAt={created} />);
    const currentLi = screen.getByText('目前狀態').closest('li');
    expect(currentLi).toHaveAttribute('data-reached', 'false');
    expect(currentLi).toHaveTextContent('—');
  });

  it('should render 目前狀態 as reached when status is not pending', () => {
    render(<StatusTimeline status="completed" createdAt={created} updatedAt={updated} />);
    expect(screen.getByText('目前狀態').closest('li')).toHaveAttribute('data-reached', 'true');
  });

  it('should render 目前狀態 as reached when updatedAt differs from createdAt', () => {
    render(<StatusTimeline status="pending" createdAt={created} updatedAt={updated} />);
    expect(screen.getByText('目前狀態').closest('li')).toHaveAttribute('data-reached', 'true');
  });

  it('should show the status label under 目前狀態 when reached', () => {
    render(<StatusTimeline status="refunded" createdAt={created} updatedAt={updated} />);
    expect(screen.getByText('已退款')).toBeInTheDocument();
  });

  it('should use <ol> + <li> structure with aria-current on the last reached step', () => {
    const { container } = render(
      <StatusTimeline status="completed" createdAt={created} updatedAt={updated} />
    );
    expect(container.querySelector('ol')).toBeInTheDocument();
    // completed → last reached is 目前狀態
    expect(screen.getByText('目前狀態').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('建立').closest('li')).not.toHaveAttribute('aria-current');
  });

  it('should mark 建立 as the current step when 目前狀態 is not reached', () => {
    render(<StatusTimeline status="pending" createdAt={created} updatedAt={created} />);
    expect(screen.getByText('建立').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('目前狀態').closest('li')).not.toHaveAttribute('aria-current');
  });
});
