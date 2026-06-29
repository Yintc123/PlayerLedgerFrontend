// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CopyButton } from './copy-button';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

describe('CopyButton', () => {
  it('should write the value to the clipboard on click', async () => {
    render(<CopyButton value="REC-1" label="紀錄 ID" />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('REC-1');
  });

  it('should announce 已複製 after a successful copy', async () => {
    render(<CopyButton value="REC-1" label="紀錄 ID" />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('已複製')).toBeInTheDocument();
  });

  it('should expose an aria-label describing the copy action', () => {
    render(<CopyButton value="ORD-9" label="訂單 ID" />);
    expect(screen.getByRole('button', { name: '複製訂單 ID' })).toBeInTheDocument();
  });
});
