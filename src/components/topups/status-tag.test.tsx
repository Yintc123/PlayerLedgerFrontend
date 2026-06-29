// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TopupStatusTag } from './status-tag';

describe('TopupStatusTag', () => {
  it.each([
    ['pending', '等待處理'],
    ['completed', '已完成'],
    ['failed', '失敗'],
    ['refunded', '已退款'],
    ['cancelled', '已取消'],
  ] as const)('should render %s as %s', (status, label) => {
    render(<TopupStatusTag status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('should expose data-status for styling/tests', () => {
    render(<TopupStatusTag status="completed" />);
    expect(screen.getByText('已完成')).toHaveAttribute('data-status', 'completed');
  });
});
