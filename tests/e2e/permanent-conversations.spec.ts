import { storedUiState } from './helpers/preferences';
import { openUserMenu } from './helpers/navigation';
import { expect, test } from '@playwright/test';
import { openSidebar } from './helpers/navigation';

for (const locale of ['zh-CN', 'en-US']) for (const width of [1280, 390]) test.describe(`${locale} ${width}px`, () => {
  test.use({ locale, storageState: storedUiState(locale.startsWith("zh") ? "zh-CN" : "en"), viewport: { width, height: 844 } });
  test('conversations remain visible across direct module navigation and restore an unsent draft', async ({ page }) => {
  const zh = locale === 'zh-CN';
  await page.goto('/?project=&agent=');
  await page.getByRole('textbox', { name: zh ? '消息' : 'Message', exact: true }).fill('Return to this unsent work');
  await openSidebar(page);
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar.locator('.sidebar-start').getByRole('button', { name: zh ? '开始对话' : 'Start chat', exact: true })).toBeVisible();
  await expect(sidebar.locator('.workspace-navigation').getByRole('button', { name: zh ? '开始对话' : 'Start chat', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: zh ? '最近对话' : 'Recent chats', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('searchbox', { name: zh ? '搜索对话' : 'Search chats', exact: true })).toBeVisible();
  await expect(sidebar.locator('.workspace-navigation').getByRole('button', { name: zh ? '用户菜单' : 'User menu', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await openUserMenu(page);
  await sidebar.getByRole('link', { name: zh ? '设置' : 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await openSidebar(page);
  await expect(sidebar.getByRole('searchbox', { name: zh ? '搜索对话' : 'Search chats', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: zh ? 'MCP 连接' : 'MCP connections', exact: true })).toHaveCount(0);
  if (width === 390) await sidebar.getByRole('button', { name: zh ? '关闭侧栏' : 'Close sidebar', exact: true }).click();
  await page.locator('main').getByRole('link', { name: zh ? 'MCP 连接' : 'MCP connections', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await openSidebar(page);
  await sidebar.locator('.library-draft').click();
  await expect(page.getByRole('textbox', { name: zh ? '消息' : 'Message', exact: true })).toHaveValue('Return to this unsent work');
});
});
