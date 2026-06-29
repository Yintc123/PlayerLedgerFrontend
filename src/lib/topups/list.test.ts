import { describe, it, expect, vi, beforeEach } from 'vitest';

const cmsRequestMock = vi.fn();
vi.mock('@/lib/api-client/cms', () => ({
  cmsRequest: (...args: unknown[]) => cmsRequestMock(...args),
}));

import { listDeposits } from './list';
import { getDeposit } from './get';
import { createDeposit } from './create';

function raw(id: string) {
  return {
    id,
    player_id: `p-${id}`,
    player_name: `玩家 ${id}`,
    amount: 1000,
    currency: 'TWD',
    status: 'completed',
    payment_method: 'bank_transfer',
    operator_id: null,
    operator_ip: null,
    internal_note: null,
    display_note: null,
    reference_no: null,
    created_at: '2026-06-20T03:11:22Z',
    updated_at: '2026-06-20T03:11:22Z',
  };
}

beforeEach(() => cmsRequestMock.mockReset());

describe('listDeposits (real API)', () => {
  it('should request /cms/deposit-records with snake_case params and repeated keys', async () => {
    cmsRequestMock.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    await listDeposits({
      playerId: 'P1',
      status: ['pending', 'failed'],
      paymentMethod: ['credit_card'],
      startDate: '2026-06-01',
      endDate: '2026-06-28',
      sort: '-amount',
      page: 2,
      pageSize: 50,
    });
    const [path, init] = cmsRequestMock.mock.calls[0];
    expect(path).toBe('/cms/deposit-records');
    const qs = (init.searchParams as URLSearchParams).toString();
    expect(qs).toContain('player_id=P1');
    expect(qs).toContain('page=2');
    expect(qs).toContain('page_size=50');
    expect(qs).toContain('status=pending');
    expect(qs).toContain('status=failed');
    expect(qs).toContain('payment_method=credit_card');
    expect(qs).toContain('start_date=2026-06-01');
    expect(qs).toContain('end_date=2026-06-28');
    expect(qs).toContain('sort=-amount');
    expect(qs).not.toContain('%2C'); // no comma-joined multi-values
  });

  it('should NOT send player_id when omitted (all players)', async () => {
    cmsRequestMock.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    await listDeposits({});
    const qs = (cmsRequestMock.mock.calls[0][1].searchParams as URLSearchParams).toString();
    expect(qs).not.toContain('player_id');
  });

  it('should transform records snake→camel and pass meta through', async () => {
    cmsRequestMock.mockResolvedValue({
      data: [raw('a')],
      meta: { page: 1, pageSize: 20, total: 137 },
    });
    const res = await listDeposits({});
    expect(res.records[0]).toMatchObject({
      id: 'a',
      playerId: 'p-a',
      playerName: '玩家 a',
      paymentMethod: 'bank_transfer',
    });
    expect(res).toMatchObject({ page: 1, pageSize: 20, total: 137 });
  });

  it('should default page/pageSize/total when meta is absent', async () => {
    cmsRequestMock.mockResolvedValue({ data: [] });
    expect(await listDeposits({})).toMatchObject({ page: 1, pageSize: 20, total: 0 });
  });

  it('should throw ApiError(400) when endDate < startDate without calling upstream', async () => {
    await expect(
      listDeposits({ startDate: '2026-06-28', endDate: '2026-06-01' })
    ).rejects.toMatchObject({ status: 400 });
    expect(cmsRequestMock).not.toHaveBeenCalled();
  });
});

describe('getDeposit (real API)', () => {
  it('should request /cms/deposit-records/{id} and transform the record', async () => {
    cmsRequestMock.mockResolvedValue({ data: raw('rec-1') });
    const out = await getDeposit('rec-1');
    expect(cmsRequestMock).toHaveBeenCalledWith('/cms/deposit-records/rec-1');
    expect(out).toMatchObject({ id: 'rec-1', playerId: 'p-rec-1' });
  });
});

describe('createDeposit (real API)', () => {
  it('should POST a snake_case body and transform the created record', async () => {
    cmsRequestMock.mockResolvedValue({ data: raw('new-1') });
    await createDeposit({
      playerId: 'P1',
      amount: 1000,
      paymentMethod: 'credit_card',
      currency: 'TWD',
      internalNote: 'note',
      referenceNo: 'TXN-1',
    });
    const [path, init] = cmsRequestMock.mock.calls[0];
    expect(path).toBe('/cms/deposit-records');
    expect(init.method).toBe('POST');
    expect(init.body).toMatchObject({
      player_id: 'P1',
      amount: 1000,
      payment_method: 'credit_card',
      currency: 'TWD',
      internal_note: 'note',
      reference_no: 'TXN-1',
    });
  });
});
