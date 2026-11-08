import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';

for (const view of ['projects', 'agents', 'recent', 'archived']) {
  test(`opening a conversation preserves ${view}, search and sort`, async ({ page, request, executionDirectory }) => {
    const current = await (await request.get('/api/config')).json();
    const agent = { id: 'feedback-agent-' + view, name: 'Feedback Agent ' + view, instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] };
    const project = { id: 'feedback-project-' + view, name: 'Feedback Project ' + view, cwd: executionDirectory, agentIds: [agent.id], resources: [], mcp: [], skills: [] };
    expect((await request.put('/api/config', { data: { revision: current.revision, config: { ...current.config, projects: [...current.config.projects, project], agents: [...current.config.agents, agent] } } })).ok()).toBe(true);
    const chat = await (await request.post('/api/conversations', { data: { projectId: project.id, agentId: agent.id } })).json();
    const title = 'Feedback selection ' + view;
    await request.patch('/api/conversations/' + chat.id, { data: { title } });
    if (view === 'recent') await request.post('/api/conversations/' + chat.id + '/completion', { data: { completed: true } });
    if (view === 'archived') await request.post('/api/conversations/' + chat.id + '/archive', { data: { archived: true } });
    await page.goto('/tasks');
    const picker = page.getByRole('combobox', { name: '会话视图', exact: true });
    await chooseOption(page, picker, view);
    await chooseOption(page, '排序方式', 'name');
    const search = page.getByRole('searchbox', { name: '搜索对话', exact: true });
    await search.fill(title);
    const item = page.locator('.library-list').getByRole('button', { name: title, exact: true });
    await item.click();
    await expect(page).toHaveURL(new RegExp('conversation=' + chat.id));
    await expect(picker).toHaveAttribute('data-value', view);
    await expect(search).toHaveValue(title);
    await expect(page.getByRole('combobox', { name: '排序方式', exact: true })).toHaveAttribute('data-value', 'name');
    await item.click();
    await expect(search).toHaveValue(title);
    await page.reload();
    await expect(picker).toHaveAttribute('data-value', view);
    await page.goBack();
    await expect(picker).toHaveAttribute('data-value', view);
  });
}

test('memory has an independent module; chat and task have no permanent related-memory link', async ({ page, request, executionDirectory }) => {
  const current=await (await request.get('/api/config')).json();
  const system={cli:'codex',...current.config.system,memoryCapture:true,memory:{...current.config.system?.memory,request:{generate:true,read:true}}};
  const runtimes=[...new Set([...(current.config.runtimes??['codex','omp']),'codex',system.tasks?.memory?.cli??system.cli])];
  expect((await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,runtimes,system}}})).ok()).toBe(true);
  try {
  await page.goto('/assets');
  await expect(page.locator('main .content-navigation').getByRole('link', { name: '记忆', exact: true })).toHaveCount(0);
  await page.goto('/settings/general');
  await page.locator('.workspace-navigation').getByRole('link', { name: '记忆', exact: true }).click();
  await expect(page).toHaveURL(/\/mana\?tab=memory$/);
  await expect(page.locator('.workspace-navigation [data-area=memory]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.workspace-navigation [data-area=assets]')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: '记忆索引', exact: true })).toBeVisible();
  await page.goto('/?cwd=' + encodeURIComponent(executionDirectory));
  await page.getByLabel('消息', { exact: true }).fill('请记住：反馈示例用中文');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: 请记住：反馈示例用中文', { exact: true })).toBeVisible();
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await expect(page.getByRole('link', { name: '关联记忆', exact: true })).toHaveCount(0);
  const id = new URL(page.url()).searchParams.get('conversation')!;
  expect((await request.post('/api/conversations/' + id + '/completion', { data: { completed: true } })).ok()).toBe(true);
  const hooks = page.getByRole('button', { name: 'Hooks', exact: true }).last();
  await expect(hooks).toBeVisible();await hooks.click();
  const operation = page.locator('.turn-hooks summary').filter({ hasText: '提炼记忆' }).last();
  await operation.click();
  const result = page.locator('.turn-hooks .operation-output').last();
  await expect(result).toContainText('count');
  await expect.poll(async () => JSON.parse((await result.textContent())!).count).toBeGreaterThan(0);
  await expect.poll(async()=> (await (await request.get('/api/conversations/'+id+'/history')).json()).filter((event:any)=>event.kind==='metadata'&&event.data.systemTask==='memory'&&event.data.status==='completed'&&event.data.count>0).length).toBeGreaterThan(0);
  await expect.poll(async()=> (await (await request.get('/api/v2/memory/jobs')).json()).filter((job:any)=>job.conversationId===id&&job.state==='completed').length).toBeGreaterThan(0);
  await expect.poll(async()=> (await (await request.get('/api/v2/memory/records?conversationId='+id)).json()).records.filter((record:any)=>record.status==='active').length).toBeGreaterThan(0);
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'feedback-task' }, data: { goal: 'Synthetic quiet task', criteria: [], acceptance: 'delivery', projectId: null, assigneeAgentId: null } })).json();
  await page.goto('/tasks/' + task.id);
  await expect(page.getByRole('heading', { name: 'Synthetic quiet task', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '关联记忆', exact: true })).toHaveCount(0);
  } finally {
    const latest=await (await request.get('/api/config')).json();
    expect((await request.put('/api/config',{data:{revision:latest.revision,config:current.config}})).ok()).toBe(true);
  }
});
