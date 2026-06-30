// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './dropdown-menu';

/**
 * DropdownMenu 走 Radix（ADR 021 §強制要求 5：focus / portal / keyboard 元件一律 Radix）。
 * 本測試鎖定使用者最在意的「外部點擊收回」行為，以及 Esc 收回與選取回呼——
 * 這些是自寫下拉（如 topups/MultiSelect 僅處理 Esc）容易漏掉的邊界。
 *
 * jsdom 缺 Radix 依賴的 PointerEvent / pointer-capture / scrollIntoView，需先補墊片。
 */
beforeAll(() => {
  class MockPointerEvent extends Event {
    button: number;
    ctrlKey: boolean;
    constructor(type: string, props: PointerEventInit) {
      super(type, props);
      this.button = props.button ?? 0;
      this.ctrlKey = props.ctrlKey ?? false;
    }
  }
  window.PointerEvent = MockPointerEvent as unknown as typeof PointerEvent;
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function Harness({ onSelect = () => {} }: { onSelect?: () => void }) {
  return (
    <div>
      <button>外部按鈕</button>
      <DropdownMenu>
        <DropdownMenuTrigger>開啟選單</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>編輯</DropdownMenuItem>
          <DropdownMenuItem>刪除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

describe('DropdownMenu', () => {
  it('should not render menu items before the trigger is clicked', () => {
    render(<Harness />);
    expect(screen.queryByRole('menuitem', { name: '編輯' })).not.toBeInTheDocument();
  });

  it('should open the menu when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '開啟選單' }));
    expect(await screen.findByRole('menuitem', { name: '編輯' })).toBeInTheDocument();
  });

  it('should close the menu when clicking outside', async () => {
    // 選單開啟時 Radix 對外部元素套 pointer-events:none，user-event 預設會拒絕點擊；
    // 關掉該檢查以模擬真實外部點擊（Radix 的 dismissable layer 監聽 pointerdown 收回）。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '開啟選單' }));
    await screen.findByRole('menuitem', { name: '編輯' });

    // 選單開啟時 Radix 把頁面其餘部分標為 aria-hidden（dismissable layer），
    // 故 getByRole 找不到外部按鈕；用 getByText 略過 hidden 過濾以模擬點擊外部。
    await user.click(screen.getByText('外部按鈕'));

    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: '編輯' })).not.toBeInTheDocument()
    );
  });

  it('should close the menu when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '開啟選單' }));
    await screen.findByRole('menuitem', { name: '編輯' });

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: '編輯' })).not.toBeInTheDocument()
    );
  });

  it('should fire onSelect and close when an item is chosen', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: '開啟選單' }));

    await user.click(await screen.findByRole('menuitem', { name: '編輯' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: '編輯' })).not.toBeInTheDocument()
    );
  });
});
