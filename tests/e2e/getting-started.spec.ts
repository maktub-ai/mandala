import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

type Probe = { status: 'ready' | 'login-required' | 'unavailable'; version: string | null };
async function emptyWorkspace(page: Page, request: APIRequestContext) {
  await page.route(url => url.pathname === '/api/conversations', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
  const { config, revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, runtimes: ['codex', 'omp'], projects: [], agents: config.agents.filter((agent: any) => agent.systemRole).map((agent: any) => ({ ...agent, defaultCli: 'codex' })) } } })).ok()).toBe(true);
  await page.route('**/api/models?*', route => route.fulfill({ json: [{ id: 'synthetic-model', label: 'Synthetic model', isDefault: true }] }));
}
async function probes(page: Page, statuses: () => Record<string, Probe>) {
  const seen: string[] = [];
  await page.route('**/api/cli/status?*', route => { const cli = new URL(route.request().url()).searchParams.get('cli')!; seen.push(cli); return route.fulfill({ json: statuses()[cli] ?? { status: 'unavailable', version: null } }); });
  return seen;
}
const submissions = (page: Page) => { const posts: string[] = []; page.on('request', request => { if (request.method() === 'POST' && /\/api\/conversations(?:\/[^/]+\/(queue|continue))?$/.test(new URL(request.url()).pathname)) posts.push(request.url()); }); return posts; };

test('first use finds ready CLIs, adopts the choice for Mandala and opens Mandala without sending', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  const seen = await probes(page, () => ({ codex: { status: 'login-required', version: 'codex 1' }, claude: { status: 'ready', version: 'claude 1' } }));
  const posts = submissions(page);
  await page.goto('/');
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('status')).toContainText('找到 1 个可用的 CLI');
  expect(new Set(seen).size).toBeGreaterThanOrEqual(14);
  // The ready CLI is suggested even though it is not enabled yet; the signed-out one explains how to sign in.
  await expect(guide.getByRole('radio', { name: /^Claude Code/ })).toHaveAttribute('aria-checked', 'true');
  const codex = guide.getByRole('radio', { name: /^Codex/ });
  await expect(codex).toHaveAttribute('aria-disabled', 'true');
  await expect(codex).toContainText('codex login');
  await codex.click({ force: true });
  await expect(codex).toHaveAttribute('aria-checked', 'false');
  await guide.getByRole('button', { name: '用 Claude Code 开始', exact: true }).click();
  await expect(page).toHaveURL(/\/mandala\?conversation=/);
  await expect(page.getByRole('region', { name: 'Mandala 开始指引', exact: true })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Mandala 如何工作', exact: true })).toContainText('你来验收');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  const saved = (await (await request.get('/api/config')).json()).config;
  expect(saved.runtimes).toContain('claude');
  expect(saved.agents.find((agent: any) => agent.id === saved.mandala.agentId).defaultCli).toBe('claude');
  expect(posts).toEqual([]);
  await page.goto('/');
  await expect(page.getByRole('region', { name: '开始使用 Mandala', exact: true })).toHaveCount(0);
});

test('a CLI that finishes signing in becomes selectable after checking again', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  let signedIn = false;
  await probes(page, () => ({ codex: { status: signedIn ? 'ready' : 'login-required', version: 'codex 1' } }));
  await page.goto('/');
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide.getByRole('status')).toContainText('还没有可直接使用的 CLI');
  await expect(guide.getByRole('button', { name: '先选择一个可用的 CLI', exact: true })).toBeDisabled();
  signedIn = true;
  await guide.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(guide.getByRole('radio', { name: /^Codex/ })).toHaveAttribute('aria-checked', 'true');
  await expect(guide.getByRole('button', { name: '用 Codex 开始', exact: true })).toBeEnabled();
});

for (const theme of ['light', 'dark']) test('failed checks stay visible and the guide fits a narrow ' + theme + ' viewport', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem('mana-theme', value), theme);
  await page.route('**/api/status', route => route.fulfill({ json: { service: 'openmana', status: 'ready' } }));
  await page.route('**/api/cli/status?*', route => route.fulfill({ status: 503, json: { error: 'Synthetic detection failure' } }));
  await page.goto('/');
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide.getByRole('alert')).toContainText('Synthetic detection failure');
  await expect(guide).toContainText('检测没有完成');
  await guide.locator('summary').filter({ hasText: '运行环境诊断' }).click();
  await expect(guide.getByText('运行环境版本暂不可用', { exact: true })).toBeVisible();
  await expect(guide.getByRole('button', { name: '重新检测', exact: true })).toBeEnabled();
  await expect(page.locator('.cli-notice')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a configured ACP runtime opens chat preparation directly', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  const { config, revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { ...config, projects: [], runtimes: ['gemini'], agents: [...config.agents, { id: 'gemini-agent', name: 'Gemini helper', instructions: '', defaultCli: 'gemini', models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
  await page.route('**/api/cli/status?*', route => route.fulfill({ json: { status: 'ready', version: 'fixture' } }));
  await page.goto('/');
  await expect(page.getByRole('region', { name: '开始使用 Mandala', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '当前 CLI', exact: true })).toHaveAttribute('data-value', 'gemini');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
});

test('Just chat keeps the composer hidden until an explicit hand-off, and the draft survives reload', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  let unavailable = false;
  await probes(page, () => ({ omp: { status: unavailable ? 'unavailable' : 'ready', version: 'synthetic' } }));
  const posts = submissions(page);
  await page.goto('/');
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 950 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await expect(guide.getByRole('radio', { name: /^OMP/ })).toHaveAttribute('aria-checked', 'true');
  await guide.getByRole('button', { name: '直接对话', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '当前 CLI', exact: true })).toHaveAttribute('data-value', 'omp');
  await expect(page.getByRole('combobox', { name: '当前 智能体', exact: true })).toHaveAttribute('data-value', '');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('Explicit OMP draft remains accessible');
  await expect.poll(async () => { const response = await request.get('/api/drafts/entry?scope=' + encodeURIComponent(JSON.stringify({ kind: 'chat', conversationId: '', projectId: '', agentId: '' }))); return response.ok() ? await response.text() : ''; }).toContain('Explicit OMP draft remains accessible');
  unavailable = true; await page.reload();
  await expect(input).toHaveValue('Explicit OMP draft remains accessible'); await expect(guide).toHaveCount(0);
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('mana-chat-preferences')!); delete value.onboardingCompleted; localStorage.setItem('mana-chat-preferences', JSON.stringify(value)); });
  await page.reload(); await expect(input).toHaveValue('Explicit OMP draft remains accessible'); await expect(guide).toHaveCount(0);
  expect(posts).toEqual([]);
  // Leave the shared fixture service without an entry draft for later first-use scenarios.
  await input.fill('');
  await expect.poll(async () => { const response = await request.get('/api/drafts/entry?scope=' + encodeURIComponent(JSON.stringify({ kind: 'chat', conversationId: '', projectId: '', agentId: '' }))); return response.ok() ? await response.text() : ''; }).not.toContain('Explicit OMP draft');
});

test('Create Agent from the guide enables the runtime and opens Agent creation', async ({ page, request }) => {
  await emptyWorkspace(page, request);
  await probes(page, () => ({ gemini: { status: 'ready', version: 'g' } }));
  await page.goto('/');
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide.getByRole('radio', { name: /^Gemini CLI/ })).toHaveAttribute('aria-checked', 'true');
  await guide.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\?/);
  expect((await (await request.get('/api/config')).json()).config.runtimes).toContain('gemini');
});

test('settings reopen the guide on a workspace that already has data', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('mana-chat-preferences', JSON.stringify({ projectId: '', agentId: '', cli: 'codex', model: '', effort: '', onboardingCompleted: true })));
  await page.route('**/api/cli/status?*', route => route.fulfill({ json: { status: 'ready', version: 'fixture' } }));
  await page.goto('/settings/general');
  await page.getByRole('button', { name: '打开新手指引', exact: true }).click();
  const guide = page.getByRole('region', { name: '开始使用 Mandala', exact: true });
  await expect(guide).toBeVisible();
  await expect(page).toHaveURL(/\/\?welcome=1$/);
  await guide.getByRole('radio', { name: /^Codex/ }).click();
  await guide.getByRole('button', { name: '直接对话', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
});

test('multiple ready runtimes require a user choice without preferring Codex or OMP',async({page,request})=>{
 await emptyWorkspace(page,request);
 await probes(page,()=>Object.fromEntries(['codex','omp','gemini'].map(cli=>[cli,{status:'ready',version:'fixture'}])));
 await page.goto('/?welcome=1');
 const guide=page.getByRole('region',{name:'开始使用 Mandala',exact:true});
 await expect(guide.getByRole('status')).toContainText('找到 3 个可用的 CLI');
 await expect(guide.getByRole('radio',{checked:true})).toHaveCount(0);
 await expect(guide.getByRole('button',{name:'先选择一个可用的 CLI',exact:true})).toBeDisabled();
 await guide.getByRole('radio',{name:/^Gemini CLI/}).click();
 await expect(guide.getByRole('button',{name:'用 Gemini CLI 开始',exact:true})).toBeEnabled();
});

test('a fresh Mandala entry offers runtime selection without creating a guessed chat',async({page})=>{
 const fresh={config:{version:2,projects:[],agents:[]},revision:'fresh'};
 await page.route('**/api/config',route=>route.fulfill({json:fresh}));
 await page.route('**/api/mandala',route=>route.fulfill({json:{...fresh,conversation:null}}));
 await page.route(url=>url.pathname==='/api/conversations',route=>route.fulfill({json:[]}));
 await probes(page,()=>({gemini:{status:'ready',version:'fixture'}}));
 await page.goto('/mandala');
 await expect(page.getByRole('region',{name:'开始使用 Mandala',exact:true})).toBeVisible();
 await expect(page).toHaveURL(/welcome=1/);
});
test('system preferences can be saved unselected and preserve a later explicit runtime choice',async({page,request})=>{
 await emptyWorkspace(page,request);
 const current=await(await request.get('/api/config')).json();
 delete current.config.system;
 expect((await request.put('/api/config',{data:current})).ok()).toBe(true);
 await page.goto('/settings/system');
 const runtimes=page.getByRole('radiogroup',{name:'系统任务执行端',exact:true});
 await expect(runtimes.getByRole('radio',{checked:true})).toHaveCount(0);
 await page.getByRole('switch',{name:'自动生成对话标题',exact:true}).check();
 await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.system;}).toEqual({automaticTitles:true});
 await runtimes.getByRole('radio',{name:'OMP',exact:true}).click();
 await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.system?.cli;}).toBe('omp');
 await page.reload();
 await page.getByRole('switch',{name:'自动生成对话标题',exact:true}).uncheck();
 await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.system;}).toEqual({cli:'omp',automaticTitles:false});
});
