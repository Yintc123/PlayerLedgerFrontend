// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('should render idle variant copy when variant="idle"', () => {
    render(<EmptyState variant="idle" />);
    expect(screen.getByText('輸入玩家資訊以開始查詢')).toBeInTheDocument();
  });

  it('should render no-results variant copy with CTA when variant="no-results"', () => {
    render(<EmptyState variant="no-results" />);
    expect(screen.getByText('找不到符合條件的玩家')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改搜尋條件' })).toBeInTheDocument();
  });

  it('should focus the first form field when CTA clicked (no-results variant)', async () => {
    const user = userEvent.setup();
    const input = document.createElement('input');
    input.id = 'playerId';
    document.body.appendChild(input);

    render(<EmptyState variant="no-results" />);
    await user.click(screen.getByRole('button', { name: '修改搜尋條件' }));
    expect(document.activeElement).toBe(input);
  });
});
