import { test, expect } from '@playwright/test';
import { chooseOption } from './helpers/select';
for (const variant of ['light', 'dark']) test(`data plugin lifecycle and compatible preferences in ${variant}`, async ({ page, request }) => {
  const current = await (await request.get('/api/market/sources')).json();
  expect((await request.put('/api/market/sources', { data: { revision: current.revision, sources: [], enabled: ['mandala-plugins'] } })).ok()).toBe(true);
  const snapshot = await (await request.get('/api/market/extensions')).json();
  for (const plugin of snapshot.plugins ?? []) {
    const latest = await (await request.get('/api/market/extensions')).json();
    expect((await request.post('/api/market/extensions/uninstall', { data: { catalogId: plugin.catalogId, revision: latest.revision } })).ok()).toBe(true);
  }
  await page.addInitScript(value => localStorage.setItem('mana-theme', value), variant);
  await page.goto('/market?kind=plugin');
  await expect(page.locator('html')).toHaveAttribute('data-theme', variant);
  await chooseOption(page, '能力类型', 'pet');
  await page.getByRole('button', { name: '查看详情 Studio', exact: true }).click();
  const dialog = page.getByRole('dialog'), palette = await page.locator('html').getAttribute('data-palette');
  await dialog.getByRole('button', { name: '安装', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '应用主题', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-palette', palette!);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/mandala-data-plugin-${variant}-${width}.png`, animations: 'disabled' });
  }
  await dialog.getByRole('button', { name: '使用此桌宠', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已应用');
  await dialog.getByRole('button', { name: '应用主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', /market:plugin-[a-f0-9]{32}:light/);
  const appliedPalette = await page.locator('html').getAttribute('data-palette');
  await dialog.getByRole('button', { name: '使用此语言', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.goto('/market?tab=installed&kind=plugin');
  await page.route('**/api/market/detail?*', route => route.abort());
  await page.getByRole('button', { name: 'View details Studio', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply theme', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-palette', appliedPalette!);
  await expect(page.getByRole('button', { name: 'View details Studio', exact: true })).toHaveCount(0);
  await page.goto('/pet');
  await expect(page.locator('.pet-window-figure svg.mandala-pet')).toBeVisible();
});

test('registers a plugin source and keeps its installed data after removing the source', async ({ page, request }) => {
  const sources = await (await request.get('/api/market/sources')).json();
  await request.put('/api/market/sources', { data: { revision: sources.revision, sources: [], enabled: [] } });
  await page.goto('/market?kind=plugin');
  await page.getByRole('button', { name: '管理来源', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '添加来源', exact: true }).click();
  await chooseOption(page, '来源类型', 'plugin');
  await dialog.getByLabel('来源名称', { exact: true }).fill('Example plugins');
  await dialog.getByLabel('仓库地址', { exact: true }).fill('https://github.com/example/plugins');
  await dialog.getByRole('button', { name: '加入草稿', exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '查看详情 Studio', exact: true }).click();
  await dialog.getByRole('button', { name: '安装', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '应用主题', exact: true })).toBeVisible();
  const current = await (await request.get('/api/market/sources')).json();
  await request.put('/api/market/sources', { data: { revision: current.revision, sources: [], enabled: [] } });
  await page.goto('/market?tab=installed&kind=plugin');
  await page.getByRole('button', { name: '查看详情 Studio', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '使用此桌宠', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '卸载', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看详情 Studio', exact: true })).toHaveCount(0);
});
