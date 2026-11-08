import { expect, test } from '@playwright/test';
import { waitForAutosave } from './helpers/settings';

test.beforeEach(async ({ request, page }) => {
  const { revision } = await (await request.get('/api/config')).json();
  const agents = ['Writer', 'Reviewer'].map((name, i) => ({ id: `skills-a${i}`, name, instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [], skillIds: ['legacy-skill'], connectionIds: ['shared-mcp'] }));
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, projects: [], agents, skillLibrary: [{ id: 'legacy-skill', name: 'legacy-skill', path: '/tmp/external-skill' }], connections: [{ id: 'shared-mcp', name: 'shared-mcp', transport: 'http', url: 'https://example.test/mcp' }] } } })).ok()).toBe(true);
  await page.route('**/api/capabilities?*', route => route.fulfill({ json: { skills: [{ name: 'runtime-readonly', path: '/tmp/runtime/SKILL.md', source: 'native', scope: 'user' }], mcp: [{ name: 'native-mcp', path: '/tmp/native.json', source: 'native' }] } }));
});

test('configured abilities pause and unassign without removing shared assets or other assignments', async ({ page, request }) => {
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  await expect(page.getByRole('heading', { name: '已配置技能', exact: true })).toBeVisible();
  const row = page.locator('[data-configured-skill="legacy-skill"]');
  await row.getByRole('switch').click();
  await waitForAutosave(page);
  let config = (await (await request.get('/api/config')).json()).config;
  expect(config.agents[0].skillIds).toEqual(['legacy-skill']);
  expect(config.agents[0].disabledSkillIds).toEqual(['legacy-skill']);
  await page.reload();
  await expect(row.getByRole('switch')).not.toBeChecked();
  await row.getByRole('button', { name: '移除 legacy-skill 的分配', exact: true }).click();
  await waitForAutosave(page);
  config = (await (await request.get('/api/config')).json()).config;
  expect(config.skillLibrary).toHaveLength(1);
  expect(config.agents[1].skillIds).toEqual(['legacy-skill']);
  expect(config.agents[0].skillIds).toEqual([]);
  expect(config.agents[0].disabledSkillIds).toEqual([]);
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.locator('[data-configured-connection="shared-mcp"]').getByRole('switch').click();
  await waitForAutosave(page);
  config = (await (await request.get('/api/config')).json()).config;
  expect(config.agents[0].disabledConnectionIds).toEqual(['shared-mcp']);
  expect(config.agents[1].disabledConnectionIds).toBeUndefined();
});

test('agent registers system content and the library manages content and assignments', async ({ page, request }) => {
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加技能', exact: true });
  await dialog.getByRole('button', { name: '注册新技能', exact: true }).click();
  await dialog.getByRole('textbox', { name: '技能标识', exact: true }).fill('team-review');
  await dialog.getByRole('textbox', { name: 'SKILL.md 内容', exact: true }).fill('---\nname: team-review\ndescription: Review changes\n---\n\n# Team review\n\nCheck the change.');
  await dialog.getByRole('button', { name: '注册并添加', exact: true }).click();
  await waitForAutosave(page);
  await page.reload();
  await expect(page.locator('[data-configured-skill]').filter({ hasText: 'team-review' })).toBeVisible();
  await page.goto('/mana/skills');
  await page.locator('.team-skill-index').getByRole('button', { name: 'team-review', exact: true }).click();
  await page.getByRole('textbox', { name: 'SKILL.md 内容', exact: true }).fill('---\nname: team-review\ndescription: Review changes\n---\n\n# Team review\n\nRevised and shared.');
  await page.getByRole('checkbox', { name: '分配给 Reviewer', exact: true }).check();
  await waitForAutosave(page);
  await expect(page.getByRole('button', { name: '删除系统技能', exact: true })).toBeDisabled();
  await page.reload();
  await page.locator('.team-skill-index').getByRole('button', { name: 'team-review', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '分配给 Reviewer', exact: true })).toBeChecked();
  const { config } = await (await request.get('/api/config')).json();
  const skill = config.skillLibrary.find((item: { name: string }) => item.name === 'team-review');
  expect(skill.content).toContain('Revised and shared.');
  expect(config.agents.every((agent: { skillIds: string[] }) => agent.skillIds.includes(skill.id))).toBe(true);
});

test('native capabilities and legacy content are readonly and never claim a loaded state', async ({ page }) => {
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  const inherited = page.locator('[data-native-capabilities]');
  await expect(inherited).toContainText('runtime-readonly');
  await expect(inherited).toContainText('已发现，未验证加载');
  await expect(inherited.getByRole('switch')).toHaveCount(0);
  await expect(inherited.getByRole('button', { name: /添加|删除|移除/ })).toHaveCount(0);
  await page.goto('/mana/skills');
  await expect(page.getByText('/tmp/external-skill', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'SKILL.md 内容', exact: true })).toHaveCount(0);
});

test('registration validates content in place and existing skill selection is persisted', async ({ page, request }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  config.agents[0].skillIds = [];
  await request.put('/api/config', { data: { config, revision } });
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '添加技能', exact: true });
  await dialog.getByRole('checkbox', { name: 'legacy-skill', exact: true }).check();
  await dialog.getByRole('button', { name: '添加所选', exact: true }).click();
  await waitForAutosave(page);
  await expect(page.locator('[data-configured-skill="legacy-skill"]')).toBeVisible();
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '添加技能', exact: true });
  await dialog.getByRole('button', { name: '注册新技能', exact: true }).click();
  await dialog.getByRole('textbox', { name: '技能标识', exact: true }).fill('invalid-header');
  await dialog.getByRole('textbox', { name: 'SKILL.md 内容', exact: true }).fill('# No metadata');
  await dialog.getByRole('button', { name: '注册并添加', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('技能头部');
  await expect(dialog.getByRole('textbox', { name: 'SKILL.md 内容', exact: true })).toHaveValue('# No metadata');
  expect((await (await request.get('/api/config')).json()).config.skillLibrary).toHaveLength(1);
});

test('project directory findings are a separate readonly inventory', async ({ page, request }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  config.projects = [{ id: 'discovery-project', name: 'Working project', cwd: '/tmp', agentIds: ['skills-a0'], resources: [], mcp: [], skills: [] }];
  await request.put('/api/config', { data: { config, revision } });
  await page.route('**/api/capabilities?*', route => route.fulfill({ json: { skills: [
    { name: 'user-native', path: '/tmp/user/SKILL.md', scope: 'user', source: 'native' },
    { name: 'project-native', path: '/tmp/project/SKILL.md', scope: 'directory', source: 'native' },
  ], mcp: [] } }));
  await page.goto('/agents?agent=skills-a0&project=discovery-project&tab=capabilities');
  const runtime = page.getByRole('region', { name: '执行环境自带', exact: true });
  const project = page.getByRole('region', { name: '项目附带技能', exact: true });
  await expect(runtime).toContainText('user-native');
  await expect(runtime).not.toContainText('project-native');
  await expect(project).toContainText('project-native');
  await expect(project.getByRole('button')).toHaveCount(0);
  await expect(project.getByRole('switch')).toHaveCount(0);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`capabilities and library ${width} ${theme} remain readable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => { localStorage.setItem('mana-theme', theme); localStorage.setItem('mana-language', 'en'); }, theme);
    await page.goto('/agents?agent=skills-a0&tab=capabilities');
    await expect(page.getByRole('heading', { name: 'Configured skills', exact: true })).toBeVisible();
    await expect(page.locator('[data-native-capabilities]')).toContainText('runtime-readonly');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('abilities.png'), fullPage: true });
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await expect(page.locator('[data-native-capabilities]')).toContainText('native-mcp');
    await page.screenshot({ path: testInfo.outputPath('mcp.png'), fullPage: true });
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: 'Add skill', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add skill', exact: true });
    await dialog.getByRole('button', { name: 'Register new skill', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'SKILL.md content', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('registration.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.goto('/mana/skills');
    await expect(page.locator('.team-skill-library')).toContainText('External directory reference');
    await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('duplicate legacy catalog names cannot create invalid assignments', async ({ page, request }) => {
  const { config, revision } = await (await request.get('/api/config')).json();
  config.skillLibrary.push({ id: 'legacy-duplicate', name: 'legacy-skill', path: '/tmp/another-external-skill' });
  config.agents[0].skillIds = [];
  await request.put('/api/config', { data: { config, revision } });
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  await page.getByRole('button', { name: '添加技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加技能', exact: true });
  const choices = dialog.getByRole('checkbox', { name: 'legacy-skill', exact: true });
  await choices.first().check();
  await expect(choices.last()).toBeDisabled();
  await choices.first().uncheck();
  await expect(choices.last()).toBeEnabled();
  await choices.last().check();
  await dialog.getByRole('button', { name: '添加所选', exact: true }).click();
  await waitForAutosave(page);
  await page.goto('/mana/skills');
  await expect(page.getByRole('checkbox', { name: '分配给 Writer', exact: true })).toBeDisabled();
  expect((await (await request.get('/api/config')).json()).config.agents[0].skillIds).toEqual(['legacy-duplicate']);
});

test('MCP registration keeps invalid drafts and stores a valid shared connection', async ({ page, request }) => {
  await page.goto('/agents?agent=skills-a0&tab=capabilities');
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加连接', exact: true });
  await dialog.getByRole('button', { name: '注册新连接', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'MCP 名称', exact: true }).fill('new-connection');
  await dialog.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.test/mcp?token=synthetic');
  await dialog.getByRole('button', { name: '注册并添加', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'URL', exact: true })).toHaveValue('https://example.test/mcp?token=synthetic');
  await dialog.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.test/new-mcp');
  await dialog.getByRole('button', { name: '注册并添加', exact: true }).click();
  await waitForAutosave(page);
  const { config } = await (await request.get('/api/config')).json();
  const connection = config.connections.find((item: { name: string }) => item.name === 'new-connection');
  expect(connection.url).toBe('https://example.test/new-mcp');
  expect(config.agents[0].connectionIds).toContain(connection.id);
  expect(config.agents[1].connectionIds).not.toContain(connection.id);
});
