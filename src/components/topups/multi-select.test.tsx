// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MultiSelect } from './multi-select';

const OPTIONS = [
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失敗' },
  { value: 'refunded', label: '已退款' },
];

describe('MultiSelect', () => {
  it('should render checkbox per option', async () => {
    const user = userEvent.setup();
    render(<MultiSelect label="狀態" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await user.click(screen.getByRole('button'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(OPTIONS.length);
  });

  it('should render selected chips inside the trigger', () => {
    render(
      <MultiSelect label="狀態" options={OPTIONS} selected={['success']} onChange={() => {}} />
    );
    expect(within(screen.getByRole('button')).getByText('成功')).toBeInTheDocument();
  });

  it('should toggle selection with Space when option is focused', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MultiSelect label="狀態" options={OPTIONS} selected={[]} onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    const first = screen.getAllByRole('checkbox')[0];
    first.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(['success']);
  });

  it('should be keyboard-navigable (Up/Down) within options list', async () => {
    const user = userEvent.setup();
    render(<MultiSelect label="狀態" options={OPTIONS} selected={[]} onChange={() => {}} />);
    await user.click(screen.getByRole('button'));
    const boxes = screen.getAllByRole('checkbox');
    boxes[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(boxes[1]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(boxes[0]);
  });

  it('should close on Esc and return focus to trigger', async () => {
    const user = userEvent.setup();
    render(<MultiSelect label="狀態" options={OPTIONS} selected={[]} onChange={() => {}} />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    screen.getAllByRole('checkbox')[0].focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});
