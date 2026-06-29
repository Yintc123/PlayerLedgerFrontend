// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PlayerStatusTag } from './status-tag';

describe('PlayerStatusTag', () => {
  it.each([
    ['active', '正常'],
    ['frozen', '凍結'],
    ['closed', '已關閉'],
  ] as const)('should render %s with label %s and data-status', (status, label) => {
    render(<PlayerStatusTag status={status} />);
    const tag = screen.getByText(label);
    expect(tag).toBeInTheDocument();
    expect(tag).toHaveAttribute('data-status', status);
  });

  it('should convey status with text, not color alone', () => {
    render(<PlayerStatusTag status="frozen" />);
    expect(screen.getByText('凍結')).toBeInTheDocument();
  });
});
