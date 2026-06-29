// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('should render no-results copy', () => {
    render(<EmptyState playerId="p1" />);
    expect(screen.getByText('無符合條件的儲值紀錄')).toBeInTheDocument();
  });

  it('should render a 清除篩選 CTA linking to the unfiltered list', () => {
    render(<EmptyState playerId="p1" />);
    const cta = screen.getByRole('link', { name: '清除篩選' });
    expect(cta).toHaveAttribute('href', '/players/p1/topups');
  });
});
