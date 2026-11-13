import { test, expect } from './helpers/execution-fixture';
import type {DisplayEvent} from '../../shared/types';

test.beforeEach(async ({ request, executionDirectory }) => {
  const { revision, config } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: {
    ...config,
    version: 2, runtimes: ['codex'],
    system: { cli: 'codex', memory: { language: 'zh-CN', request: { generate: false, read: false }, session: { generate: false, read: false } } },
    projects: [{ id: 'run-phase', name: 'Run phase fixture', cwd: executionDirectory, agentIds: ['phase-agent'], resources: [], mcp: [], skills: [] }],
    agents: [...config.agents.filter((agent:{systemRole?:string})=>agent.systemRole), { id: 'phase-agent', name: 'Phase fixture', instructions: 'Synthetic fixture only.', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
  } } })).ok()).toBe(true);
});

test('streaming answer moves the running turn from startup to generating', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'run-phase', agentId: 'phase-agent' } })).json();
  try {
    expect((await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hold' } })).ok()).toBe(true);
    await page.goto(`/?project=run-phase&conversation=${chat.id}`);
    await expect(page.getByText('Fixture reply: hold', { exact: true })).toBeVisible();
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    await expect(page.locator('.turn-process-status')).toHaveText('正在生成回复');
    await request.post(`/api/conversations/${chat.id}/stop`, { data: {} });
    await expect(page.locator('.turn-process-status')).toHaveText('本轮未完成');
  } finally { await request.post(`/api/conversations/${chat.id}/stop`, { data: {} }); }
});

for (const [message, label] of [['live-tool-flow', '正在执行的操作'], ['approval', '等待审批'], ['finished', '本轮已回复']]) {
  test(`preserves phase for ${message}`, async ({ page, request }) => {
    const chat = await (await request.post('/api/conversations', { data: { projectId: 'run-phase', agentId: 'phase-agent' } })).json();
    try {
      expect((await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: message } })).ok()).toBe(true);
      await page.goto(`/?project=run-phase&conversation=${chat.id}`);
      await expect(page.locator('.turn-process-status')).toHaveText(label);
    } finally { await request.post(`/api/conversations/${chat.id}/stop`, { data: {} }); }
  });
}

for(const accepted of [false,true])test(`running without output shows ${accepted?'generation after native acceptance':'startup before native acceptance'}`, async ({ page, request },testInfo) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'run-phase', agentId: 'phase-agent' } })).json();
  try {
    await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: 'hold' } });
    // Freeze history and stream before output, with or without native acceptance.
    const events:DisplayEvent[] = [
      { id: 1, conversationId: chat.id, kind: 'user', data: { text: 'hold' }, createdAt: new Date().toISOString() },
      { id: 2, conversationId: chat.id, kind: 'status', data: { status: 'running' }, createdAt: new Date().toISOString() },
    ];
    if(accepted)events.push({id:3,conversationId:chat.id,kind:'tool',data:{method:'turn/started',params:{turn:{id:'accepted'}}},createdAt:new Date().toISOString()});
    await page.route(`**/api/conversations/${chat.id}/history*`,route=>route.fulfill({json:events}));
    await page.route(`**/api/conversations/${chat.id}/events?*`, route => route.fulfill({
      contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'event: history-ready\ndata: {}\n\n',
    }));
    await page.goto(`/?project=run-phase&conversation=${chat.id}`);
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    await expect(page.locator('.turn-process-status')).toHaveText(accepted?'正在生成回复':'正在启动执行端');
    if(accepted){
      await page.screenshot({path:testInfo.outputPath('accepted-light.png')});
      await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:390,height:844});
      await expect(page.locator('.turn-process-status')).toHaveText('正在生成回复');
      await page.screenshot({path:testInfo.outputPath('accepted-dark-narrow.png')});
    }
  } finally { await request.post(`/api/conversations/${chat.id}/stop`, { data: {} }); }
});
