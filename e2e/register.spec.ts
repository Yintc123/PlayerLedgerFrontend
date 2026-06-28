import { test, expect } from '@playwright/test';

// spec 13 §12.3 — E2E 測試
// /api/register 以 route mock 替代後端，不 mock 內部 lib

test.describe('Register Flow', () => {
  test('/login → click 建立 CMS 帳號 → /register page renders', async ({ page }) => {
    await page.goto('/login');

    const link = page.getByRole('link', { name: '建立 CMS 帳號' });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL('/register');
    await expect(page.getByLabel('帳號')).toBeVisible();
    await expect(page.getByLabel('密碼', { exact: true })).toBeVisible();
    await expect(page.getByLabel('確認密碼')).toBeVisible();
  });

  test('/register submit with mismatched confirm password → inline alert, no navigation', async ({
    page,
  }) => {
    await page.goto('/register');

    await page.getByLabel('帳號').fill('alice');
    await page.getByLabel('密碼', { exact: true }).fill('password123');
    await page.getByLabel('確認密碼').fill('different456');
    await page.getByRole('button', { name: '建立帳號' }).click();

    await expect(page.getByRole('alert')).toContainText('密碼與確認密碼不一致');
    await expect(page).toHaveURL('/register');
  });

  test('/register submit with valid input → /login?registered=true with success banner', async ({
    page,
  }) => {
    await page.route('/api/register', (route) => route.fulfill({ status: 201, body: '' }));

    await page.goto('/register');
    await page.getByLabel('帳號').fill('newuser');
    await page.getByLabel('密碼', { exact: true }).fill('password123');
    await page.getByLabel('確認密碼').fill('password123');
    await page.getByRole('button', { name: '建立帳號' }).click();

    await expect(page).toHaveURL('/login?registered=true');
    await expect(page.getByRole('alert')).toContainText('註冊成功，請以新帳號登入');
  });

  test('/register submit with duplicate username → red alert with backend message', async ({
    page,
  }) => {
    await page.route('/api/register', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'username_taken' }),
      })
    );

    await page.goto('/register');
    await page.getByLabel('帳號').fill('existing');
    await page.getByLabel('密碼', { exact: true }).fill('password123');
    await page.getByLabel('確認密碼').fill('password123');
    await page.getByRole('button', { name: '建立帳號' }).click();

    await expect(page.getByRole('alert')).toContainText('此帳號已被使用，請換一個');
    await expect(page).toHaveURL('/register');
  });
});
