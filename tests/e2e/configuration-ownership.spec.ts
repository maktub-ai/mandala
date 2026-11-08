import {openTeamDirectory, pickDirectoryAgent, pickDirectoryProject, openProjectBackground} from "./helpers/navigation";
import {waitForAutosave} from './helpers/settings';
import { test, expect } from "@playwright/test";
import { openArea } from "./helpers/navigation";
import { chooseOption } from "./helpers/select";

test("new chat model choices follow the selected Agent without changing CLI or Project", async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  await request.put('/api/config', { data: { revision, config: { version: 2, projects: [],
    agents: ['writer', 'reviewer'].map(id => ({ id, name: id, defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] })) } } });
  await page.route('**/api/models?*', route => {
    const agentId = new URL(route.request().url()).searchParams.get('agentId');
    return route.fulfill({ json: [{ id: `${agentId}-model`, label: `${agentId} model` }] });
  });
  await page.goto('/?project=&agent=writer');
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  await model.click();
  await expect(page.getByRole('option', { name: 'writer model', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await chooseOption(page, page.getByRole('combobox', { name: '当前 智能体', exact: true }), 'reviewer');
  await model.click();
  await expect(page.getByRole('option', { name: 'reviewer model', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'writer model', exact: true })).toHaveCount(0);
});

test("Agent identity, Project context and shared catalogs have distinct homes", async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  await request.put('/api/config', { data: { revision, config: { version: 2,
    projects: [{ id: 'ownership-p', name: 'Reading project', agentIds: ['ownership-a'], cwd: '/tmp', resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'ownership-a', name: 'Researcher', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
    connections: [{ id: 'files', name: 'library-search', transport: 'stdio', command: 'synthetic-mcp' }] } } });
  await page.goto('/agents');await pickDirectoryAgent(page);
  await expect(page.getByRole('textbox', { name: '智能体 名称', exact: true })).toHaveValue('Researcher');
  await page.getByRole('tab', { name: '能力', exact: true }).click();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('checkbox', { name: 'library-search', exact: true }).check();
  await page.getByRole('button', { name: '添加所选', exact: true }).click();
  await page.getByRole('tab', { name: '执行', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '模型目录读取环境' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Codex 默认模型', exact: true })).toBeEnabled();
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.agents[0].connectionIds).toEqual(['files']);
  await openArea(page, '项目');await pickDirectoryProject(page);
  await expect(page).toHaveURL(/project=ownership-p/);
  await openProjectBackground(page);
  await page.getByRole('textbox', { name: '项目背景', exact: true }).fill('A reading log');
  await expect(page.getByText('高级运行参数', { exact: true })).toHaveCount(0);
  await waitForAutosave(page);
  await expect.poll(async () => (await (await request.get('/api/config')).json()).config.projects[0].background).toBe('A reading log');
  await openArea(page, '设置');
  await expect(page.locator('main .content-navigation a[href^="/settings/"]')).toHaveCount(4);
  await expect(page.locator('main .content-navigation').getByRole('link', { name: '技能库', exact: true })).toHaveCount(0);
  await openArea(page, '团队');await openTeamDirectory(page);
  await expect(page.getByRole('link', { name: '技能库', exact: true })).toHaveAttribute('href', '/mana/skills');
  await expect(page.locator('.workspace-navigation').getByRole('link', { name: '记忆', exact: true })).toHaveAttribute('href', '/mana?tab=memory');
  await expect(page.getByRole('link', { name: '运行参数', exact: true })).toHaveCount(0);
});

test("MANA ownership and use permissions persist separately and constrain context preview", async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  const config = { version: 2, projects: [], agents: [{ id: 'access-agent', name: 'Reader', defaultCli: 'codex', models: {}, instructions: '', mcp: [], skills: [] }] };
  expect((await request.put('/api/config', { data: { revision, config } })).ok()).toBe(true);
  const doc = await (await request.post('/api/knowledge', { data: { kind: 'document', title: 'Permission reading sample', content: 'A personal reading policy', scope: 'agent', agentId: 'access-agent', status: 'active', access: { mode: 'private' } } })).json();
  try {
    const current = await (await request.get('/api/config')).json();
    current.config.agents[0].knowledgeIds = [doc.id];
    expect((await request.put('/api/config', { data: current })).ok()).toBe(true);
    await page.goto('/assets/' + doc.id);
    await expect(page.getByRole('heading', { name: doc.title })).toBeVisible();
    await page.getByRole('button', {name:'文件设置',exact:true}).click();
    await expect(page.getByRole('combobox', { name: '使用范围', exact: true })).toHaveAttribute('data-value','private');
    expect((await (await request.get('/api/v2/assets/' + doc.id)).json()).owner.agentId).toBe('access-agent');
    const preview = () => request.get('/api/effective?agentId=access-agent&cli=codex').then(r => r.json());
    expect((await preview()).context.documents).toContainEqual({ id: doc.id, title: doc.title, status: 'denied' });
    await chooseOption(page, page.getByRole('combobox', { name: '使用范围', exact: true }), 'selected');
    await page.getByRole('checkbox', { name: 'Reader' }).check();
    await page.getByRole('button', { name: '保存使用范围', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已保存');
    expect((await preview()).context.documents).toContainEqual({ id: doc.id, title: doc.title, status: 'eligible' });
    await page.reload();
    await page.getByRole('button', {name:'文件设置',exact:true}).click();
    await expect(page.getByRole('combobox', { name: '使用范围', exact: true })).toHaveAttribute('data-value','selected');
    await expect(page.getByRole('checkbox', { name: 'Reader' })).toBeChecked();
    const versionId = (await (await request.get('/api/v2/assets/' + doc.id)).json()).headVersionId;
    const chat = await (await request.post('/api/conversations', { data: { agentId: 'access-agent', projectId: '', cli: 'codex' } })).json();
    await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'reading policy' } });
    await expect.poll(async () => (await (await request.get(`/api/conversations/${chat.id}`)).json()).conversation.status).toBe('idle');
    await page.goto(`/?project=&conversation=${chat.id}`);
    await page.getByRole('button', { name: '展开本轮过程', exact: true }).click();
    await page.getByRole('button', {name:'Hooks',exact:true}).click();
    await page.locator('summary').filter({ hasText: '资料加载' }).click();
    await expect(page.locator('.recalled-records')).toContainText(doc.title);
    await expect(page.locator('.recalled-records')).toContainText(doc.id);
    await expect(page.locator('.recalled-records')).toContainText(versionId);
  } finally { await request.delete('/api/knowledge/' + doc.id); }
});
