import { test, expect } from '@playwright/test';

test.use({ locale: 'zh-CN', storageState: { cookies: [], origins: [] } });

test('first visit defaults to English even with a Chinese browser locale', async ({ page }) => {
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Market', exact: true })).toBeVisible();
  await page.goto('/settings/general');
  await expect(page.getByRole('combobox', { name: 'Language / 语言', exact: true })).toContainText('English');
  await page.getByRole('combobox', { name: 'Language / 语言', exact: true }).click();
  await expect(page.getByRole('option').first()).toContainText('English');
  await page.keyboard.press('Escape');
});

test('an explicitly saved Chinese preference is retained', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'zh-CN'));
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: '市场', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});
