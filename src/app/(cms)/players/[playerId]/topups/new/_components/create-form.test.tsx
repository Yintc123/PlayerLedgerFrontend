// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { CreateDepositForm } from './create-form';

const action = vi.fn(async () => ({}));

beforeEach(() => action.mockClear());

describe('CreateDepositForm', () => {
  it('should render amount, currency (default TWD), payment method, and optional fields', () => {
    render(<CreateDepositForm playerId="p1" action={action} />);
    expect(screen.getByLabelText(/金額/)).toBeInTheDocument();
    expect(screen.getByLabelText('幣別')).toHaveValue('TWD');
    expect(screen.getByLabelText('支付方式')).toBeInTheDocument();
    expect(screen.getByLabelText(/參考號/)).toBeInTheDocument();
    expect(screen.getByLabelText(/內部備註/)).toBeInTheDocument();
    expect(screen.getByLabelText(/顯示備註/)).toBeInTheDocument();
  });

  it('should render every payment method option from the contract', () => {
    render(<CreateDepositForm playerId="p1" action={action} />);
    ['銀行轉帳', '信用卡', '手動補單', '超商代收', '電子錢包'].forEach((label) => {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    });
  });

  it('should show a validation error and NOT submit when amount is missing', async () => {
    const user = userEvent.setup();
    render(<CreateDepositForm playerId="p1" action={action} />);
    await user.selectOptions(screen.getByLabelText('支付方式'), 'credit_card');
    await user.click(screen.getByRole('button', { name: '建立' }));
    expect(screen.getByText('金額須為大於等於 1 的整數')).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it('should show a validation error when no payment method is chosen', async () => {
    const user = userEvent.setup();
    render(<CreateDepositForm playerId="p1" action={action} />);
    await user.type(screen.getByLabelText(/金額/), '1000');
    await user.click(screen.getByRole('button', { name: '建立' }));
    expect(screen.getByText('請選擇支付方式')).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
