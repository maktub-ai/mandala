import { pickDirectoryAgent, pickDirectoryProject } from './helpers/navigation';
import { openUserMenu } from './helpers/navigation';
import { test, expect } from './helpers/execution-fixture';
import { waitForAutosave } from './helpers/settings';

test.beforeEach(async ({ request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { version: 2,
    projects: ['studio', 'lab'].map(id => ({ id, name: id === 'studio' ? 'Design studio' : 'Research lab', cwd: '', agentIds: ['editor'], resources: [], mcp: [], skills: [] })),
    agents: [{ id: 'editor', name: 'Shared editor', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
  } } })).ok()).toBe(true);
});

for (const width of [1280, 390]) test(`Team exposes confirmed Agent deletion and keeps project history at ${width}px`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'studio', agentId: 'editor' } })).json();
  await page.goto('/agents');
  await pickDirectoryAgent(page, 'editor');
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await expect(page.getByText('已读取 2 个候选', { exact: true })).toBeVisible();
  const remove = page.locator('.object-detail-heading').getByRole('button', { name: '删除智能体', exact: true });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '确认删除智能体', exact: true });
  await expect(dialog).toContainText('Shared editor');
  await expect(dialog).toContainText('历史对话');
  await page.screenshot({ path: testInfo.outputPath('delete-agent.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(remove).toBeFocused();
  expect((await (await request.get('/api/config')).json()).config.agents).toHaveLength(1);
  await remove.click();
  await dialog.getByRole('button', { name: '删除智能体', exact: true }).click();
  await waitForAutosave(page);
  await page.reload();
  await expect(page.locator('[data-graph-agent=editor]')).toHaveCount(0);
  const config = (await (await request.get('/api/config')).json()).config;
  expect(config.agents).toEqual([]);
  expect(config.projects).toHaveLength(2);
  expect(config.projects.every((project: { agentIds: string[] }) => project.agentIds.length === 0)).toBe(true);
  expect((await request.get(`/api/conversations/${chat.id}`)).ok()).toBe(true);
});

for (const scene of [
  { width: 1280, language: 'zh-CN', theme: 'light', username: '天成' },
  { width: 390, language: 'en', theme: 'dark', username: 'Maktub' },
]) test(`Team icon choices and account navigation ${scene.width} ${scene.language}`, async ({ page, request }, testInfo) => {
  const en = scene.language === 'en';
  await page.setViewportSize({ width: scene.width, height: 850 });
  await page.addInitScript(({ language, theme }) => { localStorage.setItem('mana-language', language); localStorage.setItem('mana-theme', theme); }, scene);
  await page.route('**/auth/session', route => route.fulfill({ json: { mode: 'local', user: { id: 'synthetic', username: scene.username }, connection: null } }));
  await page.goto('/agents');
  await pickDirectoryProject(page, 'studio', en ? 'Resources' : '资源');
  await page.getByRole('tab', { name: en ? 'Resources' : '资源', exact: true }).click();
  const heading = page.locator('.object-detail-heading');
  const picker = heading.getByRole('combobox', { name: en ? 'Project icon' : '项目图标', exact: true });
  await picker.click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(8);
  await page.screenshot({ path: testInfo.outputPath('project-icons.png') });
  await page.getByRole('option', { name: en ? 'Stars' : '星标', exact: true }).click();
  await waitForAutosave(page);
  await page.reload();
  await expect(picker).toContainText(en ? 'Star' : '星标');
  expect((await (await request.get('/api/config')).json()).config.projects[0].icon).toBe('star');
  await heading.getByRole('button', { name: en ? 'Delete project' : '删除项目', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: en ? 'Cancel' : '取消', exact: true }).click();
  if (scene.width < 600) await page.getByRole('button', { name: en ? 'Open sidebar' : '打开侧栏', exact: true }).click();
  const nav = page.locator('.sidebar-bottom-navigation');
  await expect(nav.locator('.sidebar-account-avatar')).toHaveText(Array.from(scene.username)[0]);
  const menu = await openUserMenu(page);
  const settings = menu.getByRole('link', { name: en ? 'Settings' : '设置', exact: true });
  const market = menu.getByRole('link', { name: en ? 'Market' : '市场', exact: true });
  expect((await settings.boundingBox())!.y).toBeGreaterThan((await market.boundingBox())!.y);
  await expect(menu.getByRole('button', { name: en ? 'More modules' : '更多模块', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: en ? 'Account' : '账号', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'studio', agentId: 'editor' } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hello' } });
  await page.goto(`/?project=studio&conversation=${chat.id}`);
  await expect(page.locator('.message.user .message-avatar')).toHaveText(Array.from(scene.username)[0]);
  await expect(page.getByTestId('chat-status')).toHaveText(en ? 'Ready' : '就绪');
  await expect(page.locator('.engine .status-dot')).toHaveClass(/idle/);
  await page.screenshot({ path: testInfo.outputPath('chat-avatar.png') });
});
