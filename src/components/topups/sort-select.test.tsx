// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SortSelect } from './sort-select';

describe('SortSelect', () => {
  it('should default to -created_at shown as 最新優先', () => {
    render(<SortSelect onChange={() => {}} />);
    expect(screen.getByLabelText('排序')).toHaveValue('-created_at');
    expect(screen.getByRole('option', { name: '最新優先' })).toBeInTheDocument();
  });

  it('should render all four sort options', () => {
    render(<SortSelect onChange={() => {}} />);
    ['最新優先', '最舊優先', '金額高→低', '金額低→高'].forEach((label) => {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    });
  });

  it('should call onChange with the selected sort value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SortSelect onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText('排序'), '金額高→低');
    expect(onChange).toHaveBeenCalledWith('-amount');
  });
});
