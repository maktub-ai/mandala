import { expect, test } from '@playwright/test';

// A first visit opens Tasks as a board; picking the list is remembered on this device.
test.use({ storageState: { cookies: [], origins: [] } });
test('tasks open as a board until the list is chosen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'zh-CN'));
  await page.goto('/tasks');
  const display = page.getByRole('group', { name: '任务显示方式', exact: true });
  await expect(display.getByRole('button', { name: '看板', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await display.getByRole('button', { name: '列表', exact: true }).click();
  await expect(display.getByRole('button', { name: '列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/tasks');
  await expect(display.getByRole('button', { name: '列表', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
