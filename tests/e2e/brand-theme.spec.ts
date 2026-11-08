import { test, expect } from '@playwright/test';

test('the new conversation keeps real controls, sends and continues with the selected brand', async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, projects: [], agents: [{ id: 'brand-review', name: '设计伙伴', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
  await page.goto('/?agent=brand-review');
  await expect(page.getByRole('heading', { name: '从一个想法开始', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '当前 CLI', exact: true })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('brand check');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: brand check', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '从一个想法开始', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('continue brand check');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: continue brand check', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fixture reply: brand check', { exact: true })).toBeVisible();
});
