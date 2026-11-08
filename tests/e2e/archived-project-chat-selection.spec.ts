import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';
import { openSidebar } from './helpers/navigation';

test.beforeEach(async ({ request, executionDirectory }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  const agent = { id: 'archive-writer', name: 'Archive writer', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] };
  const projects = ['active', 'archived'].map(id => ({ id, name: `${id} project`, cwd: executionDirectory, agentIds: [agent.id], resources: [], mcp: [], skills: [],
    ...(id === 'archived' ? { archivedAt: '2026-11-01T00:00:00.000Z' } : {}) }));
  const response = await request.put('/api/config', { data: { revision, config: { ...config, projects, agents: [...config.agents.filter((item: { systemRole?: string }) => item.systemRole), agent] } } });
  expect(response.ok(), await response.text()).toBe(true);
});

test('new chat project choices exclude archived projects and retain an active selection', async ({ page }, testInfo) => {
  await page.goto('/?project=active&agent=archive-writer');
  const picker = page.getByRole('combobox', { name: '当前项目', exact: true });
  await expect(picker).toHaveAttribute('data-value', 'active');
  for (const [theme, width] of [['light', 1280], ['dark', 390]] as const) {
    await page.evaluate(theme => localStorage.setItem('mana-theme', theme), theme);
    await page.setViewportSize({ width, height: 850 });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await picker.click();
    await expect(page.getByRole('option', { name: 'active project', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'archived project', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`projects-${theme}-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveAttribute('data-value', 'active');
  }
});

for (const projectId of ['archived', 'missing']) for (const native of [false, true]) {
  test(`clears a remembered ${projectId} project from ${native ? 'desktop' : 'browser'} preferences`, async ({ page, request }) => {
    await page.addInitScript(({ projectId, native }) => {
      if (!sessionStorage.getItem('archive-fixture-seeded')) {
        localStorage.setItem('mana-project', projectId);
        localStorage.setItem('mana-chat-preferences', JSON.stringify({ projectId, agentId: 'archive-writer', cli: 'codex', model: 'model-fixture', effort: 'medium' }));
        sessionStorage.setItem('archive-fixture-seeded', 'true');
      }
      if (native) Object.defineProperty(window, 'mandalaDesktop', { value: { platform: 'darwin', preferences: {
        read: () => Object.fromEntries(['mana-project', 'mana-chat-preferences'].map(key => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null)),
        write: (key: string, value: string) => localStorage.setItem(key, value),
      } } });
    }, { projectId, native });
    await page.goto('/');
    const picker = page.getByRole('combobox', { name: '当前项目', exact: true });
    await expect(picker).toHaveAttribute('data-value', '');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('mana-project'))).toBe('');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mana-chat-preferences') || '{}').projectId)).toBe('');
    await page.reload();
    await expect(picker).toHaveAttribute('data-value', '');
    await chooseOption(page, picker, 'active');
    await chooseOption(page, '当前 智能体', 'archive-writer');
    await page.getByLabel('消息', { exact: true }).fill('Chat after clearing archived selection');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/conversation=/);
    const id = new URL(page.url()).searchParams.get('conversation');
    await expect.poll(async () => (await (await request.get(`/api/conversations/${id}`)).json()).conversation).toMatchObject({ projectId: 'active', agentId: 'archive-writer' });
    await expect(page.getByText('Fixture reply: Chat after clearing archived selection', { exact: true })).toBeVisible();
  });
}

test('clears an archived project from a new-chat link and its workspace', async ({ page }) => {
  await page.goto('/?project=archived&agent=archive-writer&workspace=stale&cwd=/tmp/stale');
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveAttribute('data-value', '');
  await expect(page).toHaveURL(url => url.searchParams.get('project') === '' && !url.searchParams.has('workspace') && !url.searchParams.has('cwd'));
  await page.reload();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveAttribute('data-value', '');
});

test('keeps an existing chat associated with its archived project, then clears the scope for New Chat', async ({ page, request }) => {
  const response = await request.post('/api/conversations', { data: { projectId: 'active', agentId: 'archive-writer', cli: 'codex' } });
  expect(response.ok(), await response.text()).toBe(true);
  const chat = await response.json();
  const { config, revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, projects: config.projects.map((project: { id: string }) => ({ ...project, archivedAt: '2026-11-01T00:00:00.000Z' })) } } })).ok()).toBe(true);
  await page.goto(`/?project=active&conversation=${chat.id}`);
  await expect(page.locator('.topbar')).toContainText('active project');
  await page.reload();
  await expect(page.locator('.topbar')).toContainText('active project');
  expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).conversation.projectId).toBe('active');
  await openSidebar(page);
  await page.locator('.new-chat').click();
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveAttribute('data-value', '');
});

test('restores the remembered historical chat before clearing any new-chat project preference', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'active', agentId: 'archive-writer', cli: 'codex' } })).json();
  const { config, revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, projects: config.projects.map((project: { id: string }) => ({ ...project, archivedAt: '2026-11-01T00:00:00.000Z' })) } } })).ok()).toBe(true);
  await page.goto(`/?project=active&conversation=${chat.id}`);
  await expect(page.locator('.topbar')).toContainText('active project');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/conversations?origin=all', async route => { await gate; await route.continue(); });
  try {
    const configRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config');
    await page.goto('/');
    await (await configRead).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    release();
    await expect(page.locator('.topbar')).toContainText('active project');
    await page.reload();
    await expect(page.locator('.topbar')).toContainText('active project');
  } finally { release(); }
});
