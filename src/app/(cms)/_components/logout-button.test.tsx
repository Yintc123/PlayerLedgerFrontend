// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { LogoutButton } from './logout-button';

const { postLogoutMock, disposeMock, createAuthChannelMock } = vi.hoisted(() => ({
  postLogoutMock: vi.fn(),
  disposeMock: vi.fn(),
  createAuthChannelMock: vi.fn(),
}));

vi.mock('@/lib/idle', () => ({
  createAuthChannel: createAuthChannelMock,
}));

const replaceMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  createAuthChannelMock.mockReturnValue({
    postActivity: () => {},
    postWarning: () => {},
    postLogout: postLogoutMock,
    postLogin: () => {},
    dispose: disposeMock,
  });
  Object.defineProperty(window, 'location', {
    value: { replace: replaceMock },
    writable: true,
    configurable: true,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LogoutButton', () => {
  it('should broadcast postLogout to other tabs before navigating (spec §3.2 step 6)', async () => {
    render(<LogoutButton />);
    await userEvent.click(screen.getByRole('button', { name: /登出/ }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(postLogoutMock).toHaveBeenCalledOnce();
    // 廣播必須發生在導頁之前，否則分頁來不及收到訊息
    expect(postLogoutMock.mock.invocationCallOrder[0]).toBeLessThan(
      replaceMock.mock.invocationCallOrder[0]
    );
  });

  it('should POST /api/logout and then redirect to /login', async () => {
    render(<LogoutButton />);
    await userEvent.click(screen.getByRole('button', { name: /登出/ }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(fetch).toHaveBeenCalledWith('/api/logout', { method: 'POST' });
  });

  it('should still navigate to /login even if the logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<LogoutButton />);
    await userEvent.click(screen.getByRole('button', { name: /登出/ }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
  });
});
