import { test, expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * CMS 閒置自動登出 E2E（spec 02 §5.5 / §5.6 / §9）。
 *
 * 用 Playwright `page.clock` 快轉時間（不可能真等 15 分鐘）；BroadcastChannel
 * 跨分頁同步以同一 context 的兩個 page 驗證（真實瀏覽器，同 origin）。
 *
 * 需後端 + redis 運作且 admin 帳號已 seed。帳密可由 E2E_ADMIN_* 覆寫。
 *
 * **時序重點**：IdleTimerProvider 的 timer 在 hydration 後的 useEffect 才排程，
 * 必須等 provider 掛載完成「之後」才 fastForward，否則 timer 排在已凍結的時鐘之後永不觸發。
 */
const BASE = 'http://localhost:3000';
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'dev-only-admin-pw-not-for-prod-123';

const IDLE_PAST = 16 * 60 * 1000; // > 15min cms-web idle
const INTO_WARNING = 14 * 60 * 1000 + 45_000; // 14:45 → 落在 30 秒警告窗內
const NEAR_WARNING = 14 * 60 * 1000; // 逼近警告但未到

async function login(context: BrowserContext) {
  const res = await context.request.post('/api/login', {
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    test.skip(true, `login failed (${res.status()}); backend/seed not available`);
  }
}

/** 進入受保護頁並等 hydration + IdleTimerProvider effect 掛上（排好 timer）後才回傳。 */
async function gotoPlayersReady(page: Page) {
  await page.goto('/players');
  await expect(page.getByRole('heading', { name: '玩家搜尋' })).toBeVisible();
  await page.waitForTimeout(1500); // hydration buffer：effect 排程 timer
}

test.describe('CMS idle auto-logout', () => {
  test('should auto-logout the cms tab after idle timeout and redirect to login', async ({
    context,
  }) => {
    await login(context);
    const page = await context.newPage();
    await page.clock.install();
    await gotoPlayersReady(page);
    await expect(page).toHaveURL(/\/players/);

    await page.clock.fastForward(IDLE_PAST);

    await expect(page).toHaveURL(/\/login/);
    expect(page.url()).toContain('reason=idle_timeout');
  });

  test('should show the warning modal before logging out', async ({ context }) => {
    await login(context);
    const page = await context.newPage();
    await page.clock.install();
    await gotoPlayersReady(page);

    await page.clock.fastForward(INTO_WARNING);

    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('button', { name: /繼續/ })).toBeVisible();
  });

  test('should keep the session alive when "繼續工作" is clicked in the warning', async ({
    context,
  }) => {
    await login(context);
    const page = await context.newPage();
    await page.clock.install();
    await gotoPlayersReady(page);

    await page.clock.fastForward(INTO_WARNING);
    await page.getByRole('button', { name: /繼續/ }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();

    await page.clock.fastForward(60_000); // 跨過原到期點；已重置故不應登出
    await expect(page).toHaveURL(/\/players/);
  });

  test('should sync idle logout across tabs via BroadcastChannel', async ({ context }) => {
    await login(context);
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.clock.install(); // 只快轉 A；B 靠廣播被踢
    await gotoPlayersReady(tabA);
    await gotoPlayersReady(tabB);
    await expect(tabB).toHaveURL(/\/players/);

    await tabA.clock.fastForward(IDLE_PAST); // A 閒置登出 → 廣播 logout

    await expect(tabA).toHaveURL(/\/login/);
    await expect(tabB).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('should keep other tabs alive when one tab stays active (cross-tab activity sync)', async ({
    context,
  }) => {
    await login(context);
    const tabA = await context.newPage(); // 持續活動的分頁
    const tabB = await context.newPage(); // 被快轉的分頁
    await tabB.clock.install();
    await gotoPlayersReady(tabA);
    await gotoPlayersReady(tabB);

    await tabB.clock.fastForward(NEAR_WARNING); // 逼近警告但未到

    // A 有互動 → 廣播 activity → B 重置 timer
    await tabA.mouse.move(100, 100);
    await tabA.mouse.move(160, 160);
    await tabB.waitForTimeout(500); // 等廣播實際送達（真實時間）

    await tabB.clock.fastForward(NEAR_WARNING); // 再快轉；若 B 已重置則不應登出
    await expect(tabB).toHaveURL(/\/players/);
  });
});
