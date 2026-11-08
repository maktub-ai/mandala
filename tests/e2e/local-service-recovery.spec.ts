import { test, expect } from '@playwright/test';

for (const path of ['**/api/conversations?origin=all', '**/api/tasks?view=control', '**/api/config']) test(`background ${path} error clears after recovery without losing the composer draft`, async ({ page }) => {
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('恢复连接后保留的草稿');
  await page.locator('input[type=file]').setInputFiles({ name: 'workspace.txt', mimeType: 'text/plain', buffer: Buffer.from('/synthetic/workspace') });
  await page.route(path, route => route.abort());
  const error = page.locator('.error-banner');
  await expect(error).toContainText('无法连接本地服务');
  await page.unroute(path);
  await expect(error).toHaveCount(0, { timeout: 10000 });
  await expect(composer).toHaveValue('恢复连接后保留的草稿');
  await expect(page.locator('.composer-attachments')).toContainText('workspace.txt');
});


test('successful background refresh preserves an action error', async ({ page }) => {
  await page.goto('/mandala');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(composer).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  const error = page.locator('.error-banner');
  await expect(error).toContainText('附件最多 8 个');
  await page.waitForResponse(response => response.url().includes('/api/conversations?origin=all') && response.ok());
  // The next poll cannot start until the previous full Promise.all has settled.
  await page.waitForRequest(request => request.url().includes('/api/conversations?origin=all'));
  await expect(error).toContainText('附件最多 8 个');
});
