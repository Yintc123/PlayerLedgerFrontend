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

  // 跑版修正：原生 select 的 OS 箭頭 + 不照 h-9 的盒型，與列內 pill 控件不一致。
  // 鎖定「隱藏原生箭頭 + 自畫 ChevronDown + 對齊 MultiSelect 盒型（h-9 / min-w-40）」。
  it('should hide the native arrow and match the pill box (appearance-none, h-9, min-w-40)', () => {
    render(<SortSelect onChange={() => {}} />);
    const select = screen.getByLabelText('排序');
    expect(select).toHaveClass('appearance-none');
    expect(select).toHaveClass('h-9');
    expect(select).toHaveClass('min-w-40');
  });

  it('should render a decorative chevron that does not intercept clicks', () => {
    const { container } = render(<SortSelect onChange={() => {}} />);
    const chevron = container.querySelector('svg[aria-hidden="true"]');
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveClass('pointer-events-none');
  });
});
