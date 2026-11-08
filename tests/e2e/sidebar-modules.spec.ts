import { openModuleMenu, openUserMenu } from './helpers/navigation';
import { test, expect } from '@playwright/test';

test('optional modules can be hidden, opened and pinned without disabling their features', async ({ page, request }) => {
  await page.goto('/settings/general');
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  await expect(nav.getByRole('link')).toHaveText(['进度', '团队', '文件', '记忆']);
  const settings = page.getByRole('region', { name: '侧边栏模块', exact: true });
  await expect(settings).toBeVisible();
  const before = await (await request.get('/api/config')).json();
  await settings.getByRole('switch', { name: '显示文件', exact: true }).uncheck();
  await settings.getByRole('switch', { name: '显示记忆', exact: true }).uncheck();
  await expect(nav.getByRole('link')).toHaveText(['进度', '团队']);
  await page.reload();
  await expect(settings.getByRole('switch', { name: '显示记忆', exact: true })).not.toBeChecked();
  await openModuleMenu(page);
  const modules = page.getByRole('region', { name: '用户菜单', exact: true });
  await modules.getByRole('link', { name: '记忆', exact: true }).click();
  await expect(page).toHaveURL(/\/mana\?tab=memory$/);
  await expect(page.getByRole('region', { name: '记忆索引', exact: true })).toBeVisible();
  await expect(nav.locator('.sidebar-primary-navigation [data-area=memory]')).toHaveCount(0);
  await openModuleMenu(page);
  await modules.getByRole('link', { name: '设置', exact: true }).click();
  await settings.getByRole('switch', { name: '显示记忆', exact: true }).check();
  await expect(nav.locator('.sidebar-primary-navigation [data-area=memory]')).toBeVisible();
  await expect(settings.getByRole('switch', { name: '显示记忆', exact: true })).toBeChecked();
  await expect(settings.getByRole('switch', { name: '显示文件', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(settings.getByRole('switch', { name: '显示记忆', exact: true })).toBeChecked();
  expect(await (await request.get('/api/config')).json()).toEqual(before);
});

for (const language of ['zh-CN', 'en']) test(`hidden modules stay accessible with keyboard on a light mobile layout (${language})`, async ({ page }) => {
  const zh = language === 'zh-CN';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/general');
  await expect(page.getByRole('switch', { name: '显示记忆', exact: true })).toBeVisible();
  await page.evaluate(lang => {
    localStorage.setItem('mana-language', lang);
    localStorage.setItem('mana-theme', 'light');
    localStorage.setItem('mana-sidebar-modules', JSON.stringify({ assets: false, memory: false }));
  }, language);
  await page.reload();
  const toggle = page.getByRole('button', { name: zh ? '打开侧栏' : 'Open sidebar', exact: true });
  await toggle.click();
  const nav = page.getByRole('navigation', { name: zh ? '主导航' : 'Main navigation', exact: true });
  const user = nav.getByRole('button', { name: zh ? '用户菜单' : 'User menu', exact: true });
  await expect(user).toBeEnabled();
  await user.focus();
  await expect(user).toBeFocused();
  await user.press('Enter');
  const modules = page.getByRole('region', { name: zh ? '用户菜单' : 'User menu', exact: true });
  await expect(modules).toBeVisible();
  await expect(modules.getByRole('link', { name: zh ? '市场' : 'Market', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modules).toHaveCount(0);
  await expect(user).toBeFocused();
  await expect(page.locator('aside.sidebar')).toBeVisible();
  await user.press('Enter');
  const memory = modules.getByRole('link', { name: zh ? '记忆' : 'Memory', exact: true });
  await memory.focus();
  await memory.press('Enter');
  await expect(page).toHaveURL(/\/mana\?tab=memory$/);
  await expect(page.locator('aside.sidebar')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: zh ? '记忆' : 'Memory', exact: true })).toBeVisible();
  await toggle.click();
  await expect(user).toHaveAttribute('aria-current', 'page');
  await openUserMenu(page);
  await expect(modules.getByRole('button', { name: /(固定|置顶|pin)/i })).toHaveCount(0);
  await modules.getByRole('link', { name: zh ? '设置' : 'Settings', exact: true }).click();
  const checkbox = page.getByRole('switch', { name: zh ? '显示记忆' : 'Show Memory', exact: true });
  await checkbox.check();
  await toggle.click();
  const pinnedMemory = nav.locator('.sidebar-primary-navigation [data-area=memory]');
  await expect(pinnedMemory).toBeVisible();
  await page.keyboard.press('Escape');
  await checkbox.uncheck();
  await toggle.click();
  await expect(pinnedMemory).toHaveCount(0);
  await openUserMenu(page);
  await page.keyboard.press('Escape');
  await expect(user).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('aside.sidebar')).not.toBeVisible();
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('correction drafts lock module navigation', async ({ page, request }) => {
  const seeded = await request.post('/api/knowledge', { data: { kind: 'memory', title: 'Module lock example', content: 'A synthetic fact.', scope: 'global', status: 'active', level: 'L1' } });
  expect(seeded.ok()).toBe(true);
  await page.goto('/mana?tab=memory');
  await page.getByRole('article', { name: 'Module lock example', exact: true }).getByRole('button', { name: '纠正', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '纠正内容', exact: true });
  await draft.fill('Keep my correction draft');
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeDisabled();
  const assets = page.locator('.workspace-navigation').getByRole('link', { name: '文件', exact: true });
  await expect(assets).toHaveAttribute('aria-disabled', 'true');
  await assets.press('Enter');
  await expect(page).toHaveURL(/\/mana\?tab=memory$/);
  await expect(draft).toHaveValue('Keep my correction draft');
});

test('malformed saved preferences fall back to available module defaults', async ({ page }) => {
  await page.goto('/settings/general');
  await page.evaluate(() => localStorage.setItem('mana-sidebar-modules', '{broken'));
  await page.reload();
  await expect(page.getByRole('switch', { name: '显示文件', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: '显示记忆', exact: true })).toBeChecked();
});

test('the module launcher remains usable on a short mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 568 });
  await page.goto('/settings/general');
  await page.getByRole('switch', { name: '显示文件', exact: true }).uncheck();
  await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await openModuleMenu(page);
  const modules = page.getByRole('region', { name: '用户菜单', exact: true });
  await expect(modules.getByRole('button', { name: /(固定|置顶|pin)/i })).toHaveCount(0);
  await modules.getByRole('link', { name: '文件', exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.locator('aside.sidebar')).not.toBeVisible();
});

test('tabbing out of the bottom launcher closes it without stealing focus', async ({ page }) => {
  await page.goto('/settings/general');
  await openModuleMenu(page);
  const modules = page.getByRole('region', { name: '用户菜单', exact: true });
  await modules.getByRole('link', { name: '设置', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('separator',{name:'调整侧栏宽度',exact:true})).toBeFocused();
  await expect(modules).toHaveCount(0);
});
