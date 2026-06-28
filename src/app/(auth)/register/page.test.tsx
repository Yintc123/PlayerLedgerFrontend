// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import RegisterPage from './page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: vi.fn(() => null) }),
}));

const replaceMock = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  replaceMock.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace: replaceMock },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
});

function mockFetchOk(status = 201) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
}

function mockFetchError(status: number, body: object) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('RegisterPage', () => {
  // 表單渲染
  it('should render the username, password, and confirm password fields with labels', () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText('帳號')).toBeInTheDocument();
    expect(screen.getByLabelText('密碼')).toBeInTheDocument();
    expect(screen.getByLabelText('確認密碼')).toBeInTheDocument();
  });

  it('should require all three fields (HTML validation)', () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText('帳號')).toBeRequired();
    expect(screen.getByLabelText('密碼')).toBeRequired();
    expect(screen.getByLabelText('確認密碼')).toBeRequired();
  });

  it('should render Submit button as enabled by default', () => {
    render(<RegisterPage />);
    expect(screen.getByRole('button', { name: '建立帳號' })).toBeEnabled();
  });

  it('should render link to /login at the bottom of the card', () => {
    render(<RegisterPage />);
    const link = screen.getByRole('link', { name: /返回登入/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/login');
  });

  // Client 端驗證
  it('should show "密碼與確認密碼不一致" alert when confirm differs from password (no API call)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'different123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('密碼與確認密碼不一致');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should NOT call /api/register when client-side validation fails', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'mismatch');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 提交行為
  it('should POST { username, password } to /api/register on submit', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchOk();

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/register');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      username: 'alice',
      password: 'password123',
    });
  });

  it('should NOT include confirmPassword in the request body', async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchOk();

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).not.toHaveProperty('confirmPassword');
  });

  it('should disable all inputs and the submit button while in flight', async () => {
    const user = userEvent.setup();
    let resolve: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((res) => {
        resolve = res;
      })
    );

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    expect(screen.getByLabelText('帳號')).toBeDisabled();
    expect(screen.getByLabelText('密碼')).toBeDisabled();
    expect(screen.getByLabelText('確認密碼')).toBeDisabled();
    expect(screen.getByRole('button', { name: /建立中/ })).toBeDisabled();

    resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });

  it('should set aria-busy="true" on the submit button while in flight (spec 13 §10)', async () => {
    const user = userEvent.setup();
    let resolve: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((res) => {
        resolve = res;
      })
    );

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    expect(screen.getByRole('button', { name: /建立中/ })).toHaveAttribute('aria-busy', 'true');

    resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });

  it('should render "建立中…" with spinner during loading state', async () => {
    const user = userEvent.setup();
    let resolve: (r: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((res) => {
        resolve = res;
      })
    );

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    expect(screen.getByRole('button', { name: /建立中/ })).toBeInTheDocument();

    resolve(new Response(null, { status: 201 }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });

  // 成功
  it('should redirect to /login?registered=true on 200 response', async () => {
    const user = userEvent.setup();
    mockFetchOk(200);

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login?registered=true'));
  });

  it('should redirect to /login?registered=true on 201 response', async () => {
    const user = userEvent.setup();
    mockFetchOk(201);

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login?registered=true'));
  });

  // 錯誤
  it('should render alert with backend message on 4xx', async () => {
    const user = userEvent.setup();
    mockFetchError(400, { error: 'invalid_input', message: '格式錯誤' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'a');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('格式錯誤');
  });

  it('should map username_taken to "此帳號已被使用，請換一個"', async () => {
    const user = userEvent.setup();
    mockFetchError(409, { error: 'username_taken' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('此帳號已被使用，請換一個');
  });

  it('should map "username taken" (space-form) to same message via normalizeErrorCode', async () => {
    const user = userEvent.setup();
    mockFetchError(409, { error: 'username taken' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('此帳號已被使用，請換一個');
  });

  it('should map weak_password to "密碼強度不足；需至少 8 字元且同時含字母與數字"', async () => {
    const user = userEvent.setup();
    mockFetchError(422, { error: 'weak_password' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('密碼強度不足；需至少 8 字元且同時含字母與數字');
  });

  it('should map invalid_client to "服務設定錯誤，請聯絡管理員"', async () => {
    const user = userEvent.setup();
    mockFetchError(400, { error: 'invalid_client' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('服務設定錯誤，請聯絡管理員');
  });

  it('should map invalid_input to "輸入格式不正確" when no message provided', async () => {
    const user = userEvent.setup();
    mockFetchError(400, { error: 'invalid_input' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'a');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('輸入格式不正確');
  });

  it('should pass through backend message when error code is unknown', async () => {
    const user = userEvent.setup();
    mockFetchError(400, { error: 'some_unknown_code', message: '自訂錯誤訊息' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('自訂錯誤訊息');
  });

  // spec 12 §6.3 — normalizeErrorCode 補漏
  it('should map too_many_requests to "操作過於頻繁，請稍後再試"', async () => {
    const user = userEvent.setup();
    mockFetchError(429, { error: 'too_many_requests' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('操作過於頻繁，請稍後再試');
  });

  it('should map "too many requests" (space-form) to same message via normalizeErrorCode', async () => {
    const user = userEvent.setup();
    mockFetchError(429, { error: 'too many requests' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('操作過於頻繁，請稍後再試');
  });

  it('should fall back to "建立帳號失敗" when both error code and message are absent', async () => {
    const user = userEvent.setup();
    mockFetchError(400, {});

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('建立帳號失敗');
  });

  // 網路錯誤
  it('should render alert with err.message when fetch rejects', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('offline');
  });

  it('should render fallback "網路錯誤" when err has no message', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue({});

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('網路錯誤');
  });

  // Loading 後保留輸入
  it('should retain field values after a failed submission', async () => {
    const user = userEvent.setup();
    mockFetchError(409, { error: 'username_taken' });

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    await screen.findByRole('alert');
    expect(screen.getByLabelText('帳號')).toHaveValue('alice');
    expect(screen.getByLabelText('密碼')).toHaveValue('password123');
    expect(screen.getByLabelText('確認密碼')).toHaveValue('password123');
  });

  // 無障礙
  it('should associate each input with a label via htmlFor', () => {
    render(<RegisterPage />);
    expect(screen.getByLabelText('帳號')).toHaveAttribute('id', 'username');
    expect(screen.getByLabelText('密碼')).toHaveAttribute('id', 'password');
    expect(screen.getByLabelText('確認密碼')).toHaveAttribute('id', 'confirmPassword');
  });

  it('should expose Submit as <button type="submit">', () => {
    render(<RegisterPage />);
    const btn = screen.getByRole('button', { name: '建立帳號' });
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('should render Alert with role="alert"', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));

    render(<RegisterPage />);
    await user.type(screen.getByLabelText('帳號'), 'alice');
    await user.type(screen.getByLabelText('密碼'), 'password123');
    await user.type(screen.getByLabelText('確認密碼'), 'password123');
    await user.click(screen.getByRole('button', { name: '建立帳號' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
  });
});
