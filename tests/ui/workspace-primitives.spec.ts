import { test, expect } from '@playwright/test';

test.describe('touch controls', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width:390, height:844 } });
  test('selectors, tabs and segmented choices preserve a touch target', async ({ page }) => {
    await page.goto('/ui.html');
    expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(true);
    for (const control of [page.getByRole('combobox', {name:'无搜索选项'}), page.getByRole('tab', {name:'基础控件'}), page.getByRole('radio', {name:'舒适'}), page.getByRole('button', {name:'提交示例'})]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    }
    await page.getByRole('combobox', {name:'无搜索选项'}).click();
    await expect.poll(async () => (await page.getByRole('option', {name:'第一项', exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(40);
  });
});

test('workspace composition keeps filters, list/detail navigation and status feedback distinct', async ({ page }) => {
  await page.goto('/ui.html');
  const sample = page.locator('.catalog-workspace');
  await sample.getByRole('button', { name: '返回列表' }).click();
  await sample.getByRole('textbox', { name: '样例搜索' }).fill('不存在');
  await expect(sample.getByText('当前筛选没有匹配项。')).toBeVisible();
  await sample.getByRole('button', { name: '恢复样例' }).click();
  await sample.getByRole('button', { name: /审阅跨项目交付资料/ }).click();
  await expect(sample.getByText('等待用户审阅', { exact: true })).toBeVisible();
  await expect(sample.getByText('已成功', { exact: true })).toBeVisible();
  await sample.getByRole('button', { name: '显示状态' }).click();
  await page.getByRole('menuitem', { name: '加载中' }).click();
  await expect(sample.getByRole('status', { name: '加载样例' })).toHaveAttribute('aria-busy', 'true');
});

for (const width of [1440, 1024, 768, 390]) {
  test(`shared composition remains readable at ${width}px in both themes and zoom`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/ui.html');
    for (const theme of ['浅色', '深色']) {
      await page.getByRole('button', { name: theme, exact: true }).click();
      const sample = page.locator('.catalog-workspace');
      await expect(sample.getByRole('heading', { name: '交付审阅' })).toBeVisible();
      if (width <= 768) {
        await expect(sample.locator('.workspace-list')).not.toBeVisible();
        await sample.getByRole('button', { name: '返回列表' }).click();
        await expect(sample.getByRole('button', { name: /审阅跨项目交付资料/ })).toBeVisible();
        await sample.getByRole('button', { name: /审阅跨项目交付资料/ }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.locator('.ui-catalog').screenshot({ path: `/tmp/mandala-components-${theme === '浅色' ? 'light' : 'dark'}-${width}.png` });
    }
    await page.evaluate(() => { document.body.style.zoom = '1.25'; });
    await expect(page.getByRole('combobox', { name: '选择字段' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
