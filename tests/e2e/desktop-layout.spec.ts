import { test, expect } from '@playwright/test';

for (const desktop of [true, false]) {
  test(`${desktop ? 'mac' : 'web'} authenticated pages fit the window without document scrolling`, async ({ page }) => {
    if (desktop) await page.addInitScript(() => Object.defineProperty(window, 'mandalaDesktop', { value: { platform: 'darwin' } }));
    await page.route('**/auth/session', route => route.fulfill({ json: { mode: 'local', user: { id: 'layout-owner', username: 'layout_owner' } } }));
    for (const viewport of [{ width: 1280, height: 850 }, { width: 1000, height: 600 }]) {
      await page.setViewportSize(viewport);
      for (const path of ['/tasks', '/', '/assets', '/settings/general']) {
        await page.goto(path);
        const sidebar = page.locator('.sidebar');
        await expect(sidebar).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
        await page.mouse.move(viewport.width - 30, viewport.height - 30);
        await page.mouse.wheel(0, 600);
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        await expect.poll(async () => {
          const bounds = await sidebar.boundingBox();
          return bounds ? { top: bounds.y, bottom: bounds.y + bounds.height } : null;
        }).toEqual({ top: desktop ? 48 : 0, bottom: viewport.height });
        if (path === '/') {
          await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport({ ratio: 1 });
          await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport({ ratio: 1 });
        }
      }
    }
  });
}

test('mac login fits below the titlebar and keeps short-window fields reachable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'mandalaDesktop', { value: { platform: 'darwin' } }));
  await page.route('**/auth/session', route => route.fulfill({ json: { mode: 'local', user: null, provisioned: true, setup: { available: false } } }));
  await page.goto('/');
  const form = page.locator('.personal-access');
  await expect(form).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(850);
  expect((await form.boundingBox())!.y).toBe(48);
  await page.setViewportSize({ width: 1000, height: 500 });
  const submit = page.getByRole('button', { name: '登录', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
});
