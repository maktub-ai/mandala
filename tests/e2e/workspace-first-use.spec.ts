import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

for (const [width, theme] of [[1440, 'light'], [390, 'dark']] as const) test.describe(`${width}px`, () => {
  test.use({ viewport: { width, height: 850 }, hasTouch: width === 390 });
  test('first-use actions and filtered results', async ({ page, request }) => {
    const { config, revision } = await (await request.get('/api/config')).json();
    config.projects = [];
    config.mandala = { agentId: 'system-test', soul: '', maxParallel: 3 };
    config.agents = [{ id: 'system-test', name: 'Mandala', systemRole: 'mandala', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] }];
    config.runtimes = ['codex'];
    await page.route('**/api/config', route => route.fulfill({ json: { config, revision } }));
    await page.route('**/api/v2/tasks', route => route.fulfill({ json: [] }));
    await page.route('**/api/automations', route => route.fulfill({ json: { version: 1, automations: [], runs: [] } }));
    await page.addInitScript(value => localStorage.setItem('mana-theme', value), theme);

    for (const [path, editor] of [['tasks', '.task-create-surface'], ['projects', '.project-create-card'], ['agents', '.project-create-card'], ['schedules', '.automation-editor']]) {
      await page.goto('/' + path);
      const entry = page.locator('main .workspace-first-use');
      await expect(entry.getByRole('heading')).toBeVisible();
      const action = entry.getByRole('button');
      await expect(action).toBeInViewport();
      if (width === 390) expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (path === 'agents') await expect(page.getByRole('region', { name: '系统智能体', exact: true })).toBeVisible();
      const directory = process.env.MANDALA_FIRST_USE_CAPTURE;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: join(directory, `${path}-${width}-${theme}.png`) });
      }
      const search = page.locator('main').getByRole('searchbox').first();
      if (path === 'agents') {
        await search.fill('missing-workspace-item');
        await expect(entry).toHaveCount(0);
        await search.fill('');
      } else {
        await expect(search).toHaveCount(0);
      }
      await action.focus();
      await action.press('Enter');
      await expect(page.locator(editor).first()).toBeVisible();
      if (path === 'schedules') {
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await expect(action).toBeFocused();
      }
    }
    for (const path of ['/tasks?q=unknown', '/schedules?project=unknown']) {
      await page.goto(path);
      await expect(page.locator('main .workspace-first-use')).toHaveCount(0);
      await expect(page.locator('main').getByRole('searchbox')).toBeVisible();
      await page.getByRole('button', { name: '清除筛选', exact: true }).last().click();
      await expect(page.locator('main .workspace-first-use')).toBeVisible();
    }
  });
});

test('a first schedule opens the missing prerequisite', async ({ page }) => {
  const config = { version: 2, projects: [], agents: [], runtimes: [] as string[] };
  await page.route('**/api/config', route => route.fulfill({ json: { config, revision: 'test' } }));
  await page.route('**/api/automations', route => route.fulfill({ json: { version: 1, automations: [], runs: [] } }));
  const action = page.locator('main .workspace-first-use').getByRole('button');
  await page.goto('/schedules');
  await action.click();
  await expect(page).toHaveURL(/\/settings\/runtimes$/);
  config.runtimes = ['codex'];
  await page.goto('/schedules');
  await action.click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.locator('main .workspace-first-use').getByRole('button', { name: '添加智能体' }).click();
  await expect(page.locator('.project-create-card')).toBeVisible();
});
