import { openModuleMenu } from './helpers/navigation';
import { test, expect } from './helpers/execution-fixture';

for (const scene of [
  { width: 1280, language: 'zh-CN', theme: 'light' },
  { width: 1280, language: 'en', theme: 'dark' },
  { width: 390, language: 'zh-CN', theme: 'dark' },
  { width: 390, language: 'en', theme: 'light' },
]) test(`designed reference states and bottom navigation ${scene.width} ${scene.language} ${scene.theme}`, async ({ page, request, executionDirectory }, testInfo) => {
  const en = scene.language === 'en';
  const { revision } = await (await request.get('/api/config')).json();
  await request.put('/api/config', { data: { revision, config: { version: 2, runtimes: ['codex'],
    projects: [{ id: 'polish', name: 'Reading workspace', cwd: executionDirectory, agentIds: ['reader'], resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'reader', name: 'Reading assistant', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] }],
  } } });
  await page.addInitScript(({ language, theme }) => { localStorage.setItem('mana-language', language); localStorage.setItem('mana-theme', theme); }, scene);
  await page.setViewportSize({ width: scene.width, height: 850 });
  await page.route('**/auth/session', route => route.fulfill({ json: { mode: 'local', user: { id: 'synthetic-account', username: 'Reading Studio' }, connection: null } }));
  await page.route('**/api/composer-references?**', route => route.fulfill({ json: { items: [
    { id: 'skill:b', kind: 'skill', name: 'backend-patterns', status: 'available', source: 'Agent · Reading assistant', detail: '/examples/backend-patterns/SKILL.md' },
    { id: 'mcp:b', kind: 'mcp', name: 'browser-tools', status: 'unverified', source: 'Native · Codex', detail: 'stdio' },
    { id: 'skill:a', kind: 'skill', name: 'alpha', status: 'available', source: 'Agent · Reading assistant', detail: '/backend/b/SKILL.md' },
    { id: 'skill:d', kind: 'skill', name: 'debugging', status: 'disabled', source: 'Native · Codex', detail: '/examples/debugging/SKILL.md' },
  ] } }));
  await page.goto('/?project=polish&agent=reader');
  const directory = page.locator('.setup-workspace .ui-select-trigger');
  await expect(directory).toContainText(executionDirectory);
  await expect(page.locator('.personal-bar')).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: en ? 'Message' : '消息', exact: true });
  await composer.fill('/b');
  const menu = page.locator('.composer-reference-menu');
  await expect(menu.getByRole('option')).toHaveCount(2);
  await expect(menu).not.toContainText('alpha');
  await expect(menu).not.toContainText('debugging');
  await expect(menu).not.toContainText('Available');
  await expect(menu.getByRole('img', { name: en ? 'Available' : '可用', exact: true })).toBeVisible();
  const colors = await menu.evaluate(node => ({ dot: getComputedStyle(node.querySelector('.reference-status.available')!).backgroundColor, text: getComputedStyle(node.querySelector('.composer-reference-name')!).color }));
  expect(colors.dot).not.toBe(colors.text);
  await expect(page.locator('.engine .status-dot')).toHaveClass(/idle/);
  const cliColors = await page.locator('.engine').evaluate(node => ({ dot: getComputedStyle(node.querySelector('.status-dot')!).backgroundColor, text: getComputedStyle(node).color }));
  expect(cliColors.dot).not.toBe(cliColors.text);
  await page.screenshot({ path: testInfo.outputPath('references.png') });
  await composer.press('Escape');
  if (scene.width < 600) await page.getByRole('button', { name: en ? 'Chat list' : '会话列表', exact: true }).click();
  const account = page.getByRole('button', { name: en ? 'User menu' : '用户菜单', exact: true });
  await expect(account).toBeVisible();
  const accountBox = (await account.boundingBox())!;
  expect(accountBox.x).toBeLessThan(300);
  expect(accountBox.y).toBeGreaterThan(700);
  await openModuleMenu(page);
  const modules = page.getByRole('region', { name: en ? 'User menu' : '用户菜单', exact: true });
  await expect(modules).toBeVisible();
  const box = (await modules.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThan(accountBox.y);
  expect(box.x + box.width).toBeLessThanOrEqual(scene.width);
  await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('failed hook details remain inspectable without failure counts in collapsed summaries', async ({ page, request, executionDirectory }) => {
  const { revision } = await (await request.get('/api/config')).json();
  await request.put('/api/config', { data: { revision, config: { version: 2, projects: [], agents: [] } } });
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cwd: executionDirectory } })).json();
  await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hook-flow' } });
  await page.goto(`/?project=&conversation=${chat.id}`);
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await expect(page.locator('.turn-process-toggle')).not.toContainText('失败');
  const hooks = page.getByRole('button', { name: 'Hooks', exact: true });
  await expect(hooks).not.toContainText('失败');
  await hooks.click();
  await expect(page.locator('.turn-hooks')).toContainText('失败');
  await page.locator('.turn-hooks .operation-card').filter({ hasText: 'audit' }).locator('summary').click();
  await expect(page.locator('.turn-hooks')).toContainText('Synthetic hook failure');
});
