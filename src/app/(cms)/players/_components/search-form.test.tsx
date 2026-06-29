// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SearchForm } from './search-form';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => pushMock.mockReset());

describe('SearchForm', () => {
  it('should render all five search fields with labels', () => {
    render(<SearchForm initialQuery={{}} />);
    ['玩家 ID', '外部 ID', '暱稱', 'Email', '手機'].forEach((label) => {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    });
  });

  it('should hydrate field values from initial query on mount', () => {
    render(<SearchForm initialQuery={{ displayName: '王' }} />);
    expect(screen.getByLabelText('暱稱')).toHaveValue('王');
  });

  it('should render Submit disabled when all fields empty after trim', () => {
    render(<SearchForm initialQuery={{}} />);
    expect(screen.getByRole('button', { name: /搜尋/ })).toBeDisabled();
  });

  it('should enable Submit when any field has non-whitespace value', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{}} />);
    await user.type(screen.getByLabelText('暱稱'), '王');
    expect(screen.getByRole('button', { name: /搜尋/ })).toBeEnabled();
  });

  it('should call router.push with serialized query when Submit clicked', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{}} />);
    await user.type(screen.getByLabelText('暱稱'), '王');
    await user.click(screen.getByRole('button', { name: /搜尋/ }));
    expect(pushMock).toHaveBeenCalledWith('/players?displayName=%E7%8E%8B');
  });

  it('should call router.push with serialized query when Enter pressed in a field', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{}} />);
    const field = screen.getByLabelText('Email');
    await user.type(field, 'a@b.com{Enter}');
    expect(pushMock).toHaveBeenCalledWith('/players?email=a%40b.com');
  });

  it('should NOT include empty fields in the pushed URL', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{}} />);
    await user.type(screen.getByLabelText('暱稱'), '王');
    await user.click(screen.getByRole('button', { name: /搜尋/ }));
    expect(pushMock).toHaveBeenCalledWith(expect.not.stringContaining('email='));
  });

  it('should call router.push("/players") when Clear clicked', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{ displayName: '王' }} />);
    await user.click(screen.getByRole('button', { name: /清除/ }));
    expect(pushMock).toHaveBeenCalledWith('/players');
  });

  it('should clear current field when Esc pressed with focused non-empty field', async () => {
    const user = userEvent.setup();
    render(<SearchForm initialQuery={{ displayName: '王' }} />);
    const field = screen.getByLabelText('暱稱');
    field.focus();
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('');
  });

  it('should expose Submit as <button type="submit">', () => {
    render(<SearchForm initialQuery={{}} />);
    expect(screen.getByRole('button', { name: /搜尋/ })).toHaveAttribute('type', 'submit');
  });
});
