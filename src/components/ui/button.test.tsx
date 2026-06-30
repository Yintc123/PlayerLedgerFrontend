// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from './button';

/**
 * Tailwind v4 的 preflight 把 button 預設 cursor 改回 `default`，
 * 因此所有互動按鈕需顯式 `cursor-pointer`（見 ADR 021）。此測試鎖定共用 Button 的慣例。
 */
describe('Button', () => {
  it('should render with cursor-pointer by default', () => {
    render(<Button>送出</Button>);
    expect(screen.getByRole('button', { name: '送出' })).toHaveClass('cursor-pointer');
  });

  it('should keep cursor-pointer across variants', () => {
    render(
      <>
        <Button variant="ghost">A</Button>
        <Button variant="outline">B</Button>
        <Button variant="destructive">C</Button>
      </>
    );
    for (const name of ['A', 'B', 'C']) {
      expect(screen.getByRole('button', { name })).toHaveClass('cursor-pointer');
    }
  });

  it('should drop pointer interaction when disabled (pointer-events-none)', () => {
    render(<Button disabled>停用</Button>);
    expect(screen.getByRole('button', { name: '停用' })).toHaveClass(
      'disabled:pointer-events-none'
    );
  });
});
