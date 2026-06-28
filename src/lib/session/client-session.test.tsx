// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { SessionProvider, useSession, type ClientSession } from './client-session';

function Probe() {
  const session = useSession();
  return (
    <div>
      <span data-testid="role">{session.role}</span>
      <span data-testid="keys">{Object.keys(session).sort().join(',')}</span>
    </div>
  );
}

const baseSession: ClientSession = {
  userId: 'u1',
  clientId: 'cms-web',
  absoluteExpiresAt: 1719500900000,
  createdAt: 1719500000000,
  role: 'admin',
};

// spec 07 §10.2 — 擴充 spec 02 §9 既有 client-session 測試
describe('ClientSession (spec 07 §10.2)', () => {
  it('should include role string in ClientSession value', () => {
    render(
      <SessionProvider initialSession={baseSession}>
        <Probe />
      </SessionProvider>
    );
    expect(screen.getByTestId('role').textContent).toBe('admin');
  });

  it('should never include accessToken / refreshToken / sid in value', () => {
    render(
      <SessionProvider initialSession={baseSession}>
        <Probe />
      </SessionProvider>
    );
    const keys = screen.getByTestId('keys').textContent ?? '';
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('refreshToken');
    expect(keys).not.toContain('sid');
  });
});
