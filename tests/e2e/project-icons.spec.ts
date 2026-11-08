import { expect, test } from '@playwright/test';
import { waitForAutosave } from './helpers/settings';

test.beforeEach(async ({ request }) => {
  const { revision, config } = await (await request.get('/api/config')).json();
  // Keep the system-managed Mandala identity; replace only the projects under test.
  expect((await request.put('/api/config', { data: { revision, config: { ...config,
    projects: [{ id: 'icons', name: 'Example project', cwd: '', agentIds: [], resources: [], mcp: [], skills: [], color: '#124abc' }],
  } } })).ok()).toBe(true);
});

test('choosing a project icon saves it and updates directory and detail', async ({ page, request }) => {
  await page.goto('/projects/manage?project=icons&tab=background');
  const trigger = page.getByRole('button', { name: '项目图标', exact: true });
  await expect(trigger.locator('[data-project-icon="project"]')).toBeVisible();
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '项目图标', exact: true });
  await expect(picker.locator('.identity-picker-grid button')).toHaveCount(48);
  await picker.getByRole('button', { name: '书籍', exact: true }).click();
  await waitForAutosave(page);
  const saved = (await (await request.get('/api/config')).json()).config.projects[0];
  expect(saved).toMatchObject({ icon: 'book', color: '#124abc' });
  await page.reload();
  await expect(trigger.locator('[data-project-icon="book"]')).toBeVisible();
  await expect(page.getByLabel('身份颜色', { exact: true })).toHaveValue('#124abc');
  await page.goto('/projects');
  await expect(page.locator('[data-project-icon="book"]').first()).toBeVisible();
});

test('a project emoji replaces its icon and any pasted emoji is accepted', async ({ page, request }) => {
  await page.addInitScript(() => { localStorage.setItem('mana-language', 'en'); localStorage.setItem('mana-theme', 'dark'); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/projects/manage?project=icons&tab=background');
  const trigger = page.getByRole('button', { name: 'Project icon', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Project icon', exact: true });
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await picker.getByRole('searchbox').fill('rocket');
  await picker.getByRole('button', { name: '🚀', exact: true }).click();
  await waitForAutosave(page);
  let saved = (await (await request.get('/api/config')).json()).config.projects[0];
  expect(saved.emoji).toBe('🚀');
  expect(saved.icon).toBeUndefined();
  await expect(trigger.locator('[data-identity-emoji="🚀"]')).toBeVisible();
  await trigger.click();
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await picker.getByRole('searchbox').fill('🦖');
  await picker.getByRole('button', { name: '🦖', exact: true }).click();
  await waitForAutosave(page);
  saved = (await (await request.get('/api/config')).json()).config.projects[0];
  expect(saved.emoji).toBe('🦖');
  await trigger.click();
  await page.screenshot({ animations: 'disabled', path: '/tmp/mandala-identity-picker-mobile.png' });
  await picker.getByRole('tab', { name: 'Icons', exact: true }).click();
  await picker.getByRole('searchbox').fill('database');
  await picker.getByRole('button', { name: 'Database', exact: true }).click();
  await waitForAutosave(page);
  saved = (await (await request.get('/api/config')).json()).config.projects[0];
  expect(saved).toMatchObject({ icon: 'database' });
  expect(saved.emoji).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an Agent keeps its circle with an emoji and can return to the generated avatar', async ({ page, request }) => {
  const { revision, config } = await (await request.get('/api/config')).json();
  const agent = { id: 'writer', name: 'Writer', instructions: 'Writes', defaultCli: 'codex', models: {}, mcp: [], skills: [] };
  expect((await request.put('/api/config', { data: { revision, config: { ...config, agents: [...config.agents, agent] } } })).ok()).toBe(true);
  await page.goto('/agents/writer');
  await page.getByRole('button', { name: '对象操作' }).click(); await page.getByRole('menuitem', { name: '编辑名称与外观' }).click();
  const trigger = page.getByRole('button', { name: 'Agent 图标', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Agent 图标', exact: true });
  await expect(picker.getByRole('button', { name: '自动头像', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await picker.getByRole('tab', { name: 'Emoji', exact: true }).click();
  await picker.getByRole('button', { name: '🦊', exact: true }).click();
  await waitForAutosave(page);
  const saved = async () => (await (await request.get('/api/config')).json()).config.agents.find((a: { id: string }) => a.id === 'writer');
  expect((await saved()).emoji).toBe('🦊');
  await expect(page.locator('.object-identity > .identity-avatar [data-identity-emoji="🦊"]')).toBeVisible();
  await trigger.click();
  await picker.getByRole('tab', { name: '图标', exact: true }).click();
  await picker.getByRole('button', { name: '自动头像', exact: true }).click();
  await waitForAutosave(page);
  expect((await saved()).emoji).toBeUndefined();
  await expect(page.locator('.object-identity > .identity-avatar rect').first()).toBeAttached();
});

test('module icons use distinct recognizable symbols in the rendered sidebar', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mana-language', 'en');
    localStorage.setItem('mana-sidebar-modules', JSON.stringify({market:true,memory:true,usage:true,schedules:true}));
  });
  await page.goto('/projects/manage?project=icons&tab=background');
  for (const glyph of ['bot','store','brain','chart-column-increasing','calendar-clock']) {
    await expect(page.locator(`.sidebar .lucide-${glyph}`).first()).toBeVisible();
  }
  await page.screenshot({animations:'disabled',path:'/tmp/mandala-recognizable-modules.png'});
});
