import { test, expect } from '@playwright/test';

for (const mode of ['local', 'control']) {
  test(`${mode} preview login explains that daily accounts belong to the existing installation`, async ({ page }) => {
    await page.route('**/auth/session', route => route.fulfill({ json: { mode, user: null, provisioned: true, preview: true } }));
    await page.goto('/');
    const note = page.getByRole('note', { name: '隔离验收环境' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('不包含日常账号');
    await expect(note).toContainText('打开原有安装');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.screenshot({ path: `.superpowers/login-environment/${mode}-preview-login.png` });
  });
}

test('normal login has no preview warning and signed-in previews retain their environment label', async ({ page }) => {
  let preview = false, user: null | { id: string; username: string } = null;
  await page.route('**/auth/session', route => route.fulfill({ json: { mode: 'local', user, provisioned: true, preview } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录 Mandala', exact: true })).toBeVisible();
  await expect(page.getByRole('note', { name: '隔离验收环境' })).toHaveCount(0);
  preview = true; user = { id: 'synthetic-preview', username: 'synthetic_preview' };
  await page.reload();
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toContainText('隔离验收');
  await expect(page).toHaveTitle('Mandala · 隔离验收环境');
});
