import { expect, test } from '@playwright/test';

for (const continued of [false, true]) {
 test(`${continued ? 'Continue' : 'Start'} waits for a saved or cancelled task draft`, async ({ page, request }) => {
  const suffix = continued ? 'continue-draft' : 'start-draft';
  const { config, revision } = await (await request.get('/api/config')).json();
  const agentId = 'task-agent-' + suffix;
  const { directory } = await (await request.post('/__test__/execution-directory')).json();
  const projectId = 'task-project-' + suffix;
  expect((await request.put('/api/config', { data: { revision, config: { ...config, runtimes: ['codex'], agents: [...config.agents, { id: agentId, name: suffix, defaultCli: 'codex', models: {}, instructions: '', mcp: [], skills: [] }], projects: [...config.projects, { id: projectId, name: suffix, cwd: directory, agentIds: [agentId], resources: [], mcp: [], skills: [] }] } } })).ok()).toBe(true);
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': suffix }, data: { goal: 'hold', projectId, assigneeAgentId: agentId } })).json();
  const detail = async () => (await request.get('/api/v2/tasks/' + task.id)).json();
  const requestChanges = async () => {const current=await detail();if(current.task.state==='review')expect((await request.post('/api/v2/tasks/'+task.id+'/request_changes',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:current.task.revision,reason:'Another attempt is needed'}})).ok()).toBe(true);};
  if (continued) {
   expect((await request.post('/api/v2/tasks/' + task.id + '/start', { headers: { 'Idempotency-Key': suffix + '-initial' }, data: { expectedRevision: task.revision } })).ok()).toBe(true);
   await expect.poll(async () => (await detail()).runs.at(-1)?.state).toBe('running');
   expect((await request.post('/__test__/task-output', { data: { taskId: task.id } })).ok()).toBe(true);
   await expect.poll(async () => (await detail()).runs.at(-1)?.state).toBe('succeeded');
   await requestChanges();
  }
  await page.goto('/tasks/' + task.id + (continued ? '' : '?action=edit'));
  if (continued) await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const title = page.getByLabel('任务标题', { exact: true });
  await title.fill('Saved execution goal ' + suffix);
  const start = page.getByRole('button', { name: continued ? '继续新尝试' : '开始任务', exact: true });
  await expect(start).toBeDisabled();
  await start.evaluate((button: HTMLButtonElement) => button.click());
  expect((await detail()).runs).toHaveLength(continued ? 1 : 0);
  expect((await detail()).task.goal).toBe('hold');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect.poll(async () => (await detail()).runs.at(-1)?.state).toBe('succeeded');
  const saved = await detail();
  expect(saved.runs).toHaveLength(continued ? 2 : 1);
  expect(saved.contexts.at(-1).input).toContain('Saved execution goal ' + suffix);

  await requestChanges();
  await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toBeVisible();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await title.fill('Discarded execution goal');
  await expect(page.getByRole('button', { name: '继续新尝试', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await page.getByRole('button', { name: '继续新尝试', exact: true }).click();
  await expect.poll(async () => (await detail()).runs.length).toBe(saved.runs.length + 1);
  await expect.poll(async () => (await detail()).runs.at(-1)?.state).toBe('succeeded');
  const cancelled = await detail();
  expect(cancelled.task.goal).toBe('Saved execution goal ' + suffix);
  expect(cancelled.contexts.at(-1).input).toContain('Saved execution goal ' + suffix);
  expect(cancelled.contexts.at(-1).input).not.toContain('Discarded execution goal');
 });
}
