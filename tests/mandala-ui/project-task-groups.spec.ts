import { expect, type APIResponse, type Locator } from '@playwright/test';
import { test } from '../e2e/helpers/isolated-authority';
import { createTaskWithExecutionChats } from '../e2e/helpers/task-executions';

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function goalTitles(scope: Locator) {
  return (await scope.locator('.mandala-collab-task-title').allTextContents()).sort();
}

test('opening a project from the narrow task panel releases the chat overlay', async ({page, isolatedAuthority}) => {
  const {request, baseURL}=isolatedAuthority;
  const {projectId}=await json(await request.post('/__test__/mandala-panels'));
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
  await page.goto(baseURL+'/mandala');
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
  const panel=page.locator('.mandala-panels');
  await panel.locator('a.mandala-collab-task-project').first().click();
  await expect(page).toHaveURL(baseURL+'/projects/'+projectId+'/overview');
  await expect(panel).toBeHidden();
  await page.getByRole('navigation',{name:'项目导航'}).getByRole('link',{name:'资料库',exact:true}).click();
  await expect(page).toHaveURL(baseURL+'/projects/'+projectId+'/library');
});

test('Mandala groups the same tasks and opens the matching project and its activity', async ({ page, isolatedAuthority }) => {
  const { request, baseURL } = isolatedAuthority;
  await page.setViewportSize({width: 1440, height: 900});
  await page.addInitScript(() => { localStorage.setItem('mana-language', 'zh-CN'); localStorage.setItem('mana-theme', 'light'); });
  const roots = await Promise.all([0, 1].map(async () => (await json(await request.post('/__test__/execution-directory'))).directory));
  const id = crypto.randomUUID();
  const projects = [id + '-app', id + '-api'];
  const agents = [id + '-designer', id + '-developer', id + '-unused'];
  const projectNames = ['桌面客户端', '同步服务'];
  const agentNames = ['交互设计', '服务开发', '文档编辑'];
  const titles = ['打通离线编辑与同步接口', '整理试用反馈', '更新安装指引'];
  const chatNames = ['离线编辑交互', '同步接口联调'];
  const files = ['客户端交互说明', '同步接口协议'];
  const headers = () => ({ 'Idempotency-Key': crypto.randomUUID() });

  const { config, revision } = await json(await request.get('/api/config'));
  await json(await request.put('/api/config', { data: { revision, config: { ...config,
    agents: [...config.agents, ...agents.map((id, i) => ({ id, name: agentNames[i], defaultCli: 'codex', models: {}, instructions: '', skills: [], mcp: [] }))],
    projects: [...config.projects, ...projects.map((id, i) => ({ id, name: projectNames[i], cwd: roots[i], agentIds: [agents[i], agents[2]], resources: [], skills: [], mcp: [] }))],
  } } }));
  const chats: string[] = [];
  for (const [i, projectId] of projects.entries()) {
    const chat = await json(await request.post('/api/conversations', { data: { projectId, agentId: agents[i], cli: 'codex' } }));
    chats.push(chat.id);
    await json(await request.patch('/api/conversations/' + chat.id, { data: { title: chatNames[i] } }));
    const upload = await json(await request.post('/api/v2/assets/uploads?name=notes.md', { data: 'Fixture ' + files[i] }));
    const { asset } = await json(await request.post('/api/v2/assets/imports', { headers: headers(), data: { kind: 'document', title: files[i], submissionId: upload.submissionId } }));
    await json(await request.post('/api/v2/assets/' + asset.id + '/bindings', { data: { ownerType: 'project', ownerId: projectId, versionPolicy: 'latest' } }));
  }
  const inferredTitle = '同步异常排查';
  const inferred = await json(await request.post('/api/conversations', { data: { projectId: '', agentId: agents[1], cli: 'codex', cwd: roots[1] } }));
  await json(await request.patch('/api/conversations/' + inferred.id, { data: { title: inferredTitle } }));
  const cross = await json(await createTaskWithExecutionChats(request, { headers: headers(), data: { goal: titles[0], projectId: projects[0], assigneeAgentId: agents[0] } }, chats));
  const none = await json(await request.post('/api/v2/tasks', { headers: headers(), data: { goal: titles[1] } }));
  const cleared = await json(await request.post('/api/v2/tasks', { headers: headers(), data: { goal: titles[2], projectId: projects[1], projectIds: [] } }));
  expect((await request.post('/__test__/project-task-groups/takeover', { data: [cross.id, none.id, cleared.id] })).ok()).toBe(true);

  await page.goto(baseURL + '/mandala');
  const panel = page.locator('.mandala-panels');
  // The panel no longer regroups by Agent or project: Tasks are thin parents, each with one project tag.
  const expected = [...titles].sort();
  await expect.poll(() => goalTitles(panel)).toEqual(expected);
  const search = panel.getByRole('textbox', { name: '搜索协作' });
  await search.fill(projectNames[1]);
  await expect.poll(() => goalTitles(panel)).toEqual([titles[0]]);
  await search.fill(agentNames[0]);
  await expect.poll(() => goalTitles(panel)).toEqual([titles[0]]);
  await search.fill('');

  const crossTask = panel.locator('.mandala-collab-task').filter({ hasText: titles[0] });
  const clientTag = crossTask.getByRole('link', { name: projectNames[0], exact: true });
  await expect(clientTag).toHaveAttribute('href', '/projects/' + projects[0] + '/overview');
  await clientTag.click();
  await expect(page).toHaveURL(baseURL + '/projects/' + projects[0] + '/overview');
  await expect(panel).toBeHidden();
  await page.goto(baseURL + '/projects/' + projects[1] + '/overview');

  const main = page.locator('main');
  const tasks = main.getByRole('region', { name: '项目任务', exact: true });
  const participants = main.getByRole('region', { name: '参与智能体', exact: true });
  const sessions = main.getByRole('region', { name: '最近会话', exact: true });
  const documents = main.getByRole('region', { name: '最近文件', exact: true });
  await expect(tasks.getByText(titles[0], { exact: true })).toBeVisible();
  await expect(tasks.getByText(titles[2], { exact: true })).toHaveCount(0);
  await expect(participants.getByText(agentNames[1], { exact: true })).toBeVisible();
  await expect(participants.getByText(agentNames[2], { exact: true })).toHaveCount(0);
  await expect(sessions.getByText(chatNames[1], { exact: true })).toBeVisible();
  await expect(sessions.getByText(inferredTitle, { exact: true })).toBeVisible();
  await expect(sessions.getByText(chatNames[0], { exact: true })).toHaveCount(0);
  await expect(documents.getByText(files[1], { exact: true })).toBeVisible();
  await expect(documents.getByText(files[0], { exact: true })).toHaveCount(0);
  const nav = main.getByRole('navigation', { name: '项目导航' });
  await expect(nav.getByRole('link')).toHaveText(['概览', '资料库', '设置']);
  await nav.getByRole('link', { name: '资料库' }).click();
  await expect(page).toHaveURL(baseURL + '/projects/' + projects[1] + '/library');
  await nav.getByRole('link', { name: '概览' }).click();
  await main.getByRole('link', { name: /关联任务/ }).first().click();
  await expect(page).toHaveURL(url => url.pathname === '/tasks' && url.searchParams.get('project') === projects[1]);
  await expect(main.getByText(titles[0], { exact: true }).first()).toBeVisible();
  await expect(main.getByText(titles[2], { exact: true })).toHaveCount(0);
});
