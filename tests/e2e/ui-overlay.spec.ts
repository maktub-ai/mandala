import { expect, test } from '@playwright/test';

test('opening the command palette dismisses an open Select and restores its trigger', async ({ page }) => {
  await page.goto('/?project=&agent=');
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await model.click();
  await expect(page.locator('.ui-select-popup')).toBeVisible();
  const shortcut = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)) ? 'Meta+Shift+P' : 'Control+Shift+P';
  await page.keyboard.press(shortcut);
  await expect(page.getByRole('dialog', { name: '命令面板', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '搜索命令或对象', exact: true })).toBeFocused();
  await expect(page.locator('.ui-select-popup')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(model).toBeFocused();
});
