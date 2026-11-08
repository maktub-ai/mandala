import { expect, test, type APIRequestContext } from '@playwright/test';

async function fixture(request: APIRequestContext) {
 const suffix = crypto.randomUUID(), agentId = 'reload-agent-' + suffix, projectId = 'reload-project-' + suffix;
 const { directory } = await (await request.post('/__test__/execution-directory')).json();
 const { config, revision } = await (await request.get('/api/config')).json();
 expect((await request.put('/api/config', { data: { revision, config: { ...config, agents: [...config.agents, { id: agentId, name: 'Reload reader', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] }], projects: [...config.projects, { id: projectId, name: 'Reload project', cwd: directory, agentIds: [agentId], resources: [], mcp: [], skills: [] }] } } })).ok()).toBe(true);
 return { projectId, agentId };
}

test('automation execution conversation survives reload and followup without creating a sidebar chat', async ({ page, request }) => {
 const scope = await fixture(request);
 const plan = await (await request.post('/api/automations', { data: { ...scope, name: 'Reload execution', instructions: 'Synthetic automation reload', cli: 'codex', workspaceId: null, enabled: false, schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Singapore' } } })).json();
 expect((await request.post('/api/automations/' + plan.id + '/run', { data: {} })).ok()).toBe(true);
 let conversationId = '';
 await expect.poll(async () => { const result = await (await request.get('/api/automations')).json(); const run = result.runs.find((r: any) => r.automationId === plan.id); conversationId = run?.conversationId; return run?.status; }).toBe('succeeded');
 const before = await (await request.get('/api/conversations')).json();
 expect(before.some((c: any) => c.id === conversationId)).toBe(false);
 await page.goto('/mana?tab=automation&project=' + scope.projectId);
 await page.locator('.automation-run').filter({ hasText: 'Reload execution' }).getByRole('button', { name: '查看对话', exact: true }).click();
 await expect(page.getByText('Fixture reply: Synthetic automation reload', { exact: true })).toBeVisible();
 await page.reload();
 await expect(page).toHaveURL(new RegExp('conversation=' + conversationId));
 await expect(page.getByText('Fixture reply: Synthetic automation reload', { exact: true })).toBeVisible();
 await page.getByRole('textbox', { name: '消息', exact: true }).fill('Synthetic same execution followup');
 await page.getByRole('button', { name: '发送消息', exact: true }).click();
 await expect(page.getByText('Fixture reply: Synthetic same execution followup', { exact: true })).toBeVisible();
 await expect(page).toHaveURL(new RegExp('conversation=' + conversationId));
 const after = await (await request.get('/api/conversations')).json();
 expect(after.map((c: any) => c.id).sort()).toEqual(before.map((c: any) => c.id).sort());
});

test('task execution conversation direct URL restores its existing history after reload', async ({ page, request }) => {
 const { projectId, agentId } = await fixture(request);
 const task = (await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'reload-create-' + crypto.randomUUID() }, data: { goal: 'Synthetic task execution reload', projectId, assigneeAgentId: agentId, participantAgentIds: [agentId] } })).json());
 expect((await request.post('/api/v2/tasks/' + task.id + '/start', { headers: { 'Idempotency-Key': 'reload-start-' + crypto.randomUUID() }, data: { expectedRevision: task.revision } })).ok()).toBe(true);
 let conversationId = '';
 await expect.poll(async () => { const detail = await (await request.get('/api/v2/tasks/' + task.id)).json(); conversationId = detail.runs.at(-1)?.routing.executionConversationId; return conversationId; }).toBeTruthy();
 await expect.poll(async () => (await (await request.get('/api/conversations/' + conversationId)).json()).conversation.status).toBe('idle');
 expect((await (await request.get('/api/conversations')).json()).some((c: any) => c.id === conversationId)).toBe(false);
 for (const reload of [false, true]) {
  if (reload) await page.reload(); else await page.goto('/?conversation=' + conversationId + '&project=' + projectId);
  await expect(page.locator('.agent-reply .message.text')).toContainText('Fixture reply:');
  await expect(page).toHaveURL(new RegExp('conversation=' + conversationId));
 }
});

for (const status of [403, 404]) test(`inaccessible explicit conversation (${status}) cannot send into a new chat`, async ({ page, request }) => {
 const before = await (await request.get('/api/conversations')).json();
 const id = 'inaccessible-' + status;
 await page.route('**/api/conversations/' + id, route => route.fulfill({ status, json: { error: status === 403 ? 'forbidden' : 'Conversation not found' } }));
 await page.goto('/?conversation=' + id);
 await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('textbox', { name: '消息', exact: true }).fill('Must not create a chat');
 await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
 await expect(page).toHaveURL(new RegExp('conversation=' + id));
 expect((await (await request.get('/api/conversations')).json()).map((c: any) => c.id).sort()).toEqual(before.map((c: any) => c.id).sort());
});

for (const resource of ['detail', 'events']) test(`pending authorized ${resource} cannot create a chat or mutate the target model/input`, async ({ page, request }) => {
 const scope = await fixture(request);
 const conversation = await (await request.post('/api/conversations', { data: { ...scope, workspaceId: null, cli: 'codex' } })).json();
 let release!: () => void, entered = false;
 const held = new Promise<void>(resolve => { release = resolve; });
 const mutations: string[] = [];
 page.on('request', req => { if (req.method() === 'POST' && /\/api\/conversations(?:$|\/)/.test(req.url())) mutations.push(req.url()); });
 await page.route('**/api/conversations/' + conversation.id + (resource === 'events' ? '/events' : ''), async route => { entered = true; await held; await route.continue(); });
 await page.goto('/?conversation=' + conversation.id);
 try {
  await expect.poll(() => entered).toBe(true);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Blocked until authorized detail');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
  expect(mutations).toEqual([]);
 } finally { release(); }
 await page.unrouteAll({ behavior: 'wait' });
 await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('late initial configuration does not replace the explicit conversation runtime context', async ({ page, request }) => {
 const scope = await fixture(request);
 const conversation = await (await request.post('/api/conversations', { data: { ...scope, workspaceId: null, cli: 'omp', model: 'fixture-persisted-model' } })).json();
 let release!: () => void, entered = false;
 const held = new Promise<void>(resolve => { release = resolve; });
 const modelRequests: string[] = [];
 page.on('request', req => { if (req.url().includes('/api/models?')) modelRequests.push(req.url()); });
 await page.route('**/api/config', async route => { if (route.request().method() === 'GET') { entered = true; await held; } await route.continue(); });
 await page.goto('/?conversation=' + conversation.id);
 try { await expect.poll(() => entered).toBe(true); await expect(page.getByRole('button', { name: '会话视图', exact: true })).toHaveCount(0); await expect(page.getByRole('combobox', {name:'会话视图',exact:true})).toBeDisabled(); } finally { release(); }
 await page.unrouteAll({ behavior: 'wait' });
 await expect(page.getByRole('button', { name: '执行端状态', exact: true })).toContainText('OMP');
 await page.getByRole('textbox', { name: '消息', exact: true }).fill('Keep runtime context');
 await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
 await expect.poll(() => new URL(modelRequests.at(-1)!).searchParams.get('cli')).toBe('omp');
 expect((await (await request.get('/api/conversations/' + conversation.id)).json()).conversation.model).toBe('fixture-persisted-model');
});
