import {pickDirectoryProject, openProjectBackground} from "./helpers/navigation";
import { expect, test, type APIRequestContext } from '@playwright/test';
import { chooseOption, enterModelId } from './helpers/select';
import { waitForAutosave } from './helpers/settings';

async function fixture(request: APIRequestContext) {
  const { config, revision } = await (await request.get('/api/config')).json();
  const suffix = crypto.randomUUID();
  const agents = Array.from({ length: 14 }, (_, index) => ({
    id: `ui-agent-${suffix}-${index}`, name: `页面检查 Agent ${index + 1}`,
    defaultCli: 'codex', models: {}, instructions: 'A personal UI fixture.', mcp: [], skills: [],
  }));
  const project = { id: `ui-project-${suffix}`, name: '页面检查项目', cwd: '', background: 'Review the interface.', agentIds: [agents[0].id], resources: [], mcp: [], skills: [] };
  const saved = await request.put('/api/config', { data: { revision, config: { ...config, agents: [...config.agents, ...agents], projects: [...config.projects, project] } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const title = '修复清单预览';
  const description = '当前状态：已部署，等待用户验收。\n本地路径提供复制，发布的清单可以查看正文。';
  const created = await request.post('/api/v2/tasks', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { goal: `${title}\n\n${description}`, criteria: [], acceptance: 'human', projectId: project.id, assigneeAgentId: null },
  });
  expect(created.ok()).toBe(true);
  return { task: await created.json(), title, description, project, agent: agents[0] };
}

test('task workbench separates content, execution controls and technical help', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/tasks/' + f.task.id);
  const back = page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true});
  await expect(back.locator('svg')).toHaveCount(1);
  expect(await back.evaluate(node => getComputedStyle(node).textDecorationLine)).toBe('none');
  await expect(page.locator('.task-content')).toContainText(f.description);
  await expect(page.locator('.task-content')).not.toContainText('继承 CLI 原生权限');
  await expect(page.locator('.task-content .task-description')).toBeVisible();
  await expect(page.locator('.task-diagnostics')).not.toHaveAttribute('open');
  await page.getByText('任务属性',{exact:true}).first().click();await expect(page.locator('.task-properties')).toContainText('执行智能体');
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const picker = page.getByRole('combobox', { name: '执行智能体', exact: true });
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  const inset = await picker.evaluate(node => {
    const arrow = node.querySelector('svg:last-child')!;
    return node.getBoundingClientRect().right - arrow.getBoundingClientRect().right;
  });
  expect(inset).toBeGreaterThanOrEqual(await picker.evaluate(node=>parseFloat(getComputedStyle(node).paddingRight)));
  await chooseOption(page, '执行智能体', f.agent.id);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('form', { name: '编辑任务', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(picker).toHaveAttribute('data-value', f.agent.id);
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeVisible();
  await page.locator('.task-extra-context > summary').click();
  const context = page.locator('.task-extra-context');
  await expect(context).toContainText('使用说明');
  await context.getByText('技术信息', { exact: true }).click();
  await expect(context).toContainText(f.task.id);
});

test('separates task notes from its title and offers assignment instead of stopping an unstarted task', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/tasks/' + f.task.id);
  await expect(page.getByRole('heading', { name: f.title, exact: true })).toBeVisible();
  await expect(page.locator('.task-description')).toContainText(f.description);
  await expect(page.getByRole('button', { name: '停止此任务', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '执行智能体', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await page.getByText('任务属性',{exact:true}).first().click();await expect(page.locator('.task-meta')).toContainText('执行智能体');
  await expect(page.locator('.task-meta')).toContainText('页面检查项目');
  await page.getByRole('button', { name: '提交验收', exact: true }).click();
  await expect(page.locator('.task-command-bar')).toContainText('待审阅');
  await expect(page.getByText('用户已确认完成', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: '确认完成', exact: true }).click();
  if(await page.locator('.task-properties-disclosure').getAttribute('open')===null)await page.locator('.task-properties-disclosure > summary').click();await expect(page.getByText('用户已确认完成', { exact: false })).toBeVisible();
  await page.reload();
  if(await page.locator('.task-properties-disclosure').getAttribute('open')===null)await page.locator('.task-properties-disclosure > summary').click();await expect(page.getByText('用户已确认完成', { exact: false })).toBeVisible();
});

test('uses a short task title in list and board while retaining notes on the detail page', async ({ page, request }) => {
  const f = await fixture(request);
  for (const query of ['', '?view=board']) {
    await page.goto('/tasks' + query);
    const row = page.locator('.progress-item-title[href^="/tasks/' + f.task.id + '"]');
    await expect(row).toHaveText(f.title);
    await row.click();
    await expect(page.locator('.task-description')).toContainText(f.description);
  }
});

test('keeps Agent execution controls in view and its model reachable with many Agents', async ({ page, request }) => {
  const f = await fixture(request);
  await page.goto('/agents?agent=' + f.agent.id + '&tab=execution');
  const settings = page.getByRole('region', { name: '执行设置', exact: true });
  await expect(settings.getByRole('heading', { name: '执行设置', exact: true })).toBeInViewport();
  await expect(settings.getByRole('combobox', { name: '默认执行端', exact: true })).toBeInViewport();
  await expect(settings.getByRole('heading', { name: '审批规则', exact: true })).toBeInViewport();
  await expect(page.getByRole('heading',{name:f.agent.name,exact:true})).toBeVisible();
  await expect(page.getByRole('link', {name:'返回智能体',exact:true})).toBeInViewport();
  const model = settings.getByRole('combobox', { name: 'Codex 默认模型', exact: true });
  await model.scrollIntoViewIfNeeded();
  await expect(model).toBeInViewport();
  await enterModelId(page, model, 'synthetic-layout-model');
  await waitForAutosave(page);
  await page.reload();
  await expect(model).toHaveAttribute('data-value', 'synthetic-layout-model');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [390, 768, 1280]) {
  test(`page families retain visible headings and reflow at ${width}px`, async ({ page, request }) => {
    const f = await fixture(request);
    await page.setViewportSize({ width, height: 850 });
    const routes = ['/?project=&agent=', '/tasks', '/tasks?view=board', '/tasks/' + f.task.id,
      '/tasks?tab=automation', '/projects/manage?project=' + f.project.id, '/projects/' + f.project.id + '/workbench',
      '/agents?agent=' + f.agent.id, '/agents?agent=' + f.agent.id + '&tab=execution',
      '/assets', '/mana?tab=memory', '/mana?tab=skill', '/mana?tab=organization', '/mana/skills',
      '/settings/general', '/settings/runtimes', '/settings/mcp', '/settings/system', '/market'];
    for (const path of routes) {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await expect(path==='/tasks/'+f.task.id?page.getByRole('heading',{name:f.title,exact:true}):page.locator('main').getByRole('heading',{level:1}).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), path).toBe(true);
      const main = await page.locator('main').boundingBox();
      expect(main!.width, path).toBeGreaterThan(width === 390 ? 350 : 450);
    }
  });
}

test('a published asset shows loading rather than an unpublished claim while the selected version is still loading', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=review.md', { data: '# Published review' })).json();
  const imported = await (await request.post('/api/v2/assets/imports', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'document', title: 'Published review', submissionId: stage.submissionId } })).json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v2/assets/' + imported.asset.id + '/versions/' + imported.asset.headVersionId, async route => { await gate; await route.continue(); });
  try {
    await page.goto('/assets/' + imported.asset.id);
    await expect(page.locator('.asset-detail > header').getByRole('heading', { name: 'Published review', exact: true })).toBeVisible();
    await expect(page.locator('.asset-content')).toContainText('加载中…');
    await expect(page.locator('.asset-content')).not.toContainText('尚未发布');
  } finally { release(); }
  await expect(page.locator('.asset-content')).toContainText('Published review');
});

test('Agent and project tabs retain their section after refresh and direct navigation', async ({ page, request }) => {
  const f = await fixture(request);
  for (const [path, label, value] of [
    ['/agents?agent=' + f.agent.id, '能力', 'capabilities'],
    ['/agents?agent=' + f.agent.id, '知识', 'knowledge'],
    ['/projects/manage?project=' + f.project.id, '资源', 'resources'],
    ['/projects/manage?project=' + f.project.id, '参与者', 'members'],
  ]) {
    await page.goto(path);
    if(path.startsWith('/projects'))await openProjectBackground(page);
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp('tab=' + value));
    await page.reload();
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
});

 test('selecting a different object retains its tab and URL consistently', async ({ page, request }) => {
  const f = await fixture(request);
  const { config } = await (await request.get('/api/config')).json();
  const otherAgent = config.agents.find((agent: { id: string }) => agent.id !== f.agent.id);
  await page.goto('/agents?agent=' + f.agent.id);
  await page.getByRole('tab', { name: '能力', exact: true }).click();
  await page.locator('aside.sidebar [data-area=agents]').click();await page.locator('.workspace-directory-row[href="/agents/'+otherAgent.id+'"]').click();
  await expect(page.getByRole('heading',{name:otherAgent.name,exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'概览',exact:true})).toHaveAttribute('aria-selected','true');await expect(page).toHaveURL('/agents/'+otherAgent.id);await page.getByRole('tab',{name:'能力',exact:true}).click();await expect(page).toHaveURL(new RegExp('tab=capabilities$'));
  await expect(page.getByRole('tab', { name: '能力', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: '能力', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/projects/manage?project=' + f.project.id);
  await openProjectBackground(page);
  await page.getByRole('tab', { name: '资源', exact: true }).click();
  await pickDirectoryProject(page,f.project.id,'资源');
  await expect(page.getByRole('tab', { name: '资源', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: '资源', exact: true })).toHaveAttribute('aria-selected', 'true');
 });

test('task detail waits for its content instead of claiming an access denial', async ({ page, request }) => {
  const f = await fixture(request);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v2/tasks/' + f.task.id, async route => { await gate; await route.continue(); });
  try {
    await page.goto('/tasks/' + f.task.id);
    await expect(page.getByRole('status').filter({hasText:'正在读取任务…'})).toBeVisible();
    await expect(page.locator('main')).not.toContainText('任务内容不可访问');
    await expect(page.getByRole('button', { name: '取消目标', exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: f.title, exact: true })).toBeVisible();
});

 test('failed asset loading exits the loading state without claiming the asset is unpublished', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=load.md', { data: '# Saved review' })).json();
  const saved = await (await request.post('/api/v2/assets/imports', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'document', title: 'Saved review', submissionId: stage.submissionId } })).json();
  await page.route('**/api/v2/assets/' + saved.asset.id + '/versions/' + saved.asset.headVersionId, route => route.fulfill({ status: 503, json: { error: 'temporary failure' } }));
  await page.goto('/assets/' + saved.asset.id);
  await expect(page.getByRole('alert')).toContainText('temporary failure');
  await expect(page.locator('.asset-content')).toContainText('加载失败');
  await expect(page.locator('.asset-content')).not.toContainText('加载中');
  await expect(page.locator('.asset-content')).not.toContainText('尚未发布');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
 });


test('a failed version list preserves the independently loaded published content and offers retry', async ({ page, request }) => {
  const stage = await (await request.post('/api/v2/assets/uploads?name=history.md', { data: '# Available review' })).json();
  const saved = await (await request.post('/api/v2/assets/imports', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { kind: 'document', title: 'Available review', submissionId: stage.submissionId } })).json();
  const versionsPath = '**/api/v2/assets/' + saved.asset.id + '/versions';
  await page.route(versionsPath, route => route.fulfill({ status: 503, json: { error: 'Version history unavailable' } }));
  await page.goto('/assets/' + saved.asset.id);
  await expect(page.getByRole('alert')).toContainText('Version history unavailable');
  await expect(page.getByRole('region', { name: '内容预览', exact: true })).toContainText('Available review');
  await expect(page.getByRole('region', { name: '内容预览', exact: true })).not.toContainText('尚未发布');
  await page.unroute(versionsPath);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '内容预览', exact: true })).toContainText('Available review');
});
