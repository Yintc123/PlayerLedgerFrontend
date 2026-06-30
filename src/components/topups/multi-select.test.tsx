// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MultiSelect } from './multi-select';

const OPTIONS = [
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失敗' },
  { value: 'refunded', label: '已退款' },
];

// MultiSelect 走 Radix Popover；jsdom 缺其依賴的 pointer-capture / scrollIntoView。
// 不 mock window.PointerEvent——Popover（modal=false）以 click 開啟、不需建構式；
// 反而會干擾 user-event 對 checkbox 的 Space→click（見「Space 切換」測試）。
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

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

  it('should close when clicking outside the dropdown', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button>外部</button>
        <MultiSelect label="狀態" options={OPTIONS} selected={[]} onChange={() => {}} />
      </div>
    );
    await user.click(screen.getByRole('button', { name: '狀態' }));
    await screen.findByRole('listbox');

    await user.click(screen.getByRole('button', { name: '外部' }));

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });
});
