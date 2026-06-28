// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import LoginPage from './page';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import React from 'react';

const replaceMock = vi.fn();
const originalLocation = window.location;

function setLocation(search = '') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace: replaceMock, search },
  });
}

beforeEach(() => {
  replaceMock.mockReset();
  setLocation('');
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
});

function mockFetchOk() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function mockFetchError(status: number, body: object) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('LoginPage', () => {
  it('should render the username field, password field, and submit button', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('帳號')).toBeInTheDocument();
    expect(screen.getByLabelText('密碼')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登入' })).toBeInTheDocument();
  });

  it('should POST credentials to /api/login when the form is submitted', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchOk();

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: '登入' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/login');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      username: 'alice',
      password: 'secret-pw',
    });
  });

  it('should disable both inputs and the submit button while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolve: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((res) => {
        resolve = res;
      })
    );

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: '登入' }));

    expect(screen.getByLabelText('帳號')).toBeDisabled();
    expect(screen.getByLabelText('密碼')).toBeDisabled();
    expect(screen.getByRole('button', { name: /登入中/ })).toBeDisabled();

    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });

  it('should render an alert with the backend message when the API returns an error', async () => {
    const user = userEvent.setup();
    mockFetchError(401, { error: 'invalid_credentials', message: '帳號或密碼錯誤' });

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'wrong');
    await user.click(screen.getByRole('button', { name: '登入' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('帳號或密碼錯誤');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('should fall back to the error code when no message is provided', async () => {
    const user = userEvent.setup();
    mockFetchError(429, { error: 'too_many_requests' });

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('too_many_requests');
  });

  it('should render a network-error alert when fetch rejects', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('offline');
  });

  it('should redirect to "/" by default on successful login', async () => {
    const user = userEvent.setup();
    mockFetchOk();

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/'));
  });

  it('should redirect to the safe ?redirect= target after successful login', async () => {
    const user = userEvent.setup();
    setLocation('?redirect=/players');
    mockFetchOk();

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/players'));
  });

  it('should reject protocol-relative redirect targets to prevent open-redirect', async () => {
    const user = userEvent.setup();
    setLocation('?redirect=//evil.example.com/phish');
    mockFetchOk();

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/'));
  });

  it('should reject absolute external redirect targets to prevent open-redirect', async () => {
    const user = userEvent.setup();
    setLocation('?redirect=https://evil.example.com/phish');
    mockFetchOk();

    render(<LoginPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'secret');
    await user.click(screen.getByRole('button', { name: '登入' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/'));
  });

  it('should require both username and password to submit (HTML validation)', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('帳號')).toBeRequired();
    expect(screen.getByLabelText('密碼')).toBeRequired();
  });

  // 註冊成功 banner（spec 13 §12.2）
  it('should render the "註冊成功，請以新帳號登入" banner when URL has ?registered=true', () => {
    setLocation('?registered=true');
    render(<LoginPage />);
    expect(screen.getByText('註冊成功，請以新帳號登入')).toBeInTheDocument();
  });

  it('should NOT render the banner when ?registered is absent', () => {
    render(<LoginPage />);
    expect(screen.queryByText('註冊成功，請以新帳號登入')).not.toBeInTheDocument();
  });

  it('should NOT render the banner when ?registered=false', () => {
    setLocation('?registered=false');
    render(<LoginPage />);
    expect(screen.queryByText('註冊成功，請以新帳號登入')).not.toBeInTheDocument();
  });

  // 註冊入口（spec 13 §12.2）
  it('should render a link to /register at the bottom of the card', () => {
    render(<LoginPage />);
    const link = screen.getByRole('link', { name: /建立 CMS 帳號/ });
    expect(link).toHaveAttribute('href', '/register');
  });

  it('should render the link with text "建立 CMS 帳號"', () => {
    render(<LoginPage />);
    expect(screen.getByRole('link', { name: /建立 CMS 帳號/ })).toBeInTheDocument();
  });
});
