import { describe, it, expect, vi, beforeEach } from 'vitest';

const redirectMock = vi.fn();
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

import RootPage from './page';

describe('RootPage (/)', () => {
  beforeEach(() => {
    redirectMock.mockReset();
  });

  // 本系統無根畫面，入口為 CMS 玩家搜尋頁（spec 02 §2.5）
  it('should redirect to /players (entry point is the player search screen)', () => {
    RootPage();
    expect(redirectMock).toHaveBeenCalledWith('/players');
  });
});
