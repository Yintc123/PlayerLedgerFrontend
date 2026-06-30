// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SessionProvider, type ClientSession } from '@/lib/session/client-session';
import type { Role } from '@/lib/auth/decode-token';
import type { DepositRecord } from '@/lib/topups/types';
import { ExportButton } from './export-button';

const sampleRecord: DepositRecord = {
  id: '0193b3f4-0000-7000-8000-000000000001',
  playerId: '0193b3f4-0000-7000-8000-000000000002',
  playerName: '玩家小王',
  amount: 1000,
  currency: 'TWD',
  status: 'completed',
  paymentMethod: 'bank_transfer',
  operatorId: null,
  operatorIp: null,
  internalNote: null,
  displayNote: null,
  referenceNo: 'TXN-1',
  createdAt: '2026-06-20T03:11:22Z',
  updatedAt: '2026-06-20T03:12:00Z',
};

function renderWithRole(role: Role, records: DepositRecord[] = []) {
  const session: ClientSession = {
    userId: 'u1',
    clientId: 'cms-web',
    absoluteExpiresAt: 0,
    createdAt: 0,
    role,
  };
  return render(
    <SessionProvider initialSession={session}>
      <ExportButton records={records} />
    </SessionProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportButton', () => {
  it('should NOT render when session.role is "viewer"', () => {
    renderWithRole('viewer', [sampleRecord]);
    expect(screen.queryByRole('button', { name: /匯出/ })).toBeNull();
  });

  it('should render when session.role is "user"', () => {
    renderWithRole('user', [sampleRecord]);
    expect(screen.getByRole('button', { name: /匯出/ })).toBeInTheDocument();
  });

  it('should render when session.role is "admin"', () => {
    renderWithRole('admin', [sampleRecord]);
    expect(screen.getByRole('button', { name: /匯出/ })).toBeInTheDocument();
  });

  it('should generate a CSV blob download from the provided records on click', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderWithRole('admin', [sampleRecord]);
    await userEvent.click(screen.getByRole('button', { name: /匯出/ }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('text/csv');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
