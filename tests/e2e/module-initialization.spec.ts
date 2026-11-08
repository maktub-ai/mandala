import { expect, test } from '@playwright/test';

// Gate a real fixture response so module initialization is tested without timing sleeps.
test('Market waits for the initial configuration read before taking its install revision', async ({ page, request }) => {
 for (const item of await (await request.get('/api/market/installed')).json()) {
  if (item.name !== 'synthetic-tools') continue;
  for (const target of item.targets) {
   const { revision } = await (await request.get('/api/config')).json();
   expect((await request.post('/api/market/installed/' + item.id + '/unlink', { data: { revision, target: { kind: target.kind, id: target.id } } })).ok()).toBe(true);
  }
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.post('/api/market/installed/' + item.id + '/uninstall', { data: { revision } })).ok()).toBe(true);
 }
 const { config, revision } = await (await request.get('/api/config')).json();
 expect((await request.put('/api/config', { data: { revision, config: { ...config, system: { cli: 'codex', ...config.system, memory: { ...config.system?.memory, language: 'en' } }, projects: [], agents: [{ id: 'startup-reader', name: 'Startup reader', defaultCli: 'codex', instructions: '', models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
 let release!: () => void, started!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { started = resolve; });
 let marketReads = 0;
 page.on('request', req => { if (req.url().includes('/api/market/')) marketReads++; });
 await page.route('**/api/config', async route => { if (route.request().method() === 'GET') { started(); await held; } await route.continue(); });
 await page.goto('/market?tab=mcp');await pending;
 try { await expect(page.getByRole('status', { name: '正在读取配置…', exact: true })).toBeVisible(); expect(marketReads).toBe(0); } finally { release(); }
 await page.getByRole('button', { name: '查看详情 synthetic-tools', exact: true }).click();
 await page.getByRole('dialog').getByRole('button', { name: '安装', exact: true }).click();
 await page.getByRole('checkbox', { name: '智能体 · Startup reader', exact: true }).check();
 await page.getByRole('textbox', { name: 'SYNTHETIC_KEY', exact: true }).fill('${STARTUP_FIXTURE_KEY}');
 await page.getByRole('button', { name: '安装并关联', exact: true }).click();
 await expect(page.getByRole('status')).toContainText('已安装并关联');
 expect((await (await request.get('/api/config')).json()).config.connections.at(-1).env).toEqual({ SYNTHETIC_KEY: '${STARTUP_FIXTURE_KEY}' });
});

test('direct file detail waits for configuration and retains existing project binding after reload', async ({ page, request }) => {
 const id = 'startup-binding-' + crypto.randomUUID();
 const { config, revision } = await (await request.get('/api/config')).json();
 expect((await request.put('/api/config', { data: { revision, config: { ...config, projects: [...config.projects, { id, name: 'Startup bound project', cwd: '/tmp', agentIds: [], resources: [], mcp: [], skills: [] }] } } })).ok()).toBe(true);
 const stage = await (await request.post('/api/v2/assets/uploads?name=startup.md', { data: 'Synthetic startup document' })).json();
 const publication = await (await request.post('/api/v2/assets/imports', { headers: { 'Idempotency-Key': id }, data: { kind: 'document', title: 'Startup document', submissionId: stage.submissionId } })).json();
 expect((await request.post('/api/v2/assets/' + publication.asset.id + '/bindings', { data: { ownerType: 'project', ownerId: id, versionPolicy: 'latest' } })).ok()).toBe(true);
 for (const reload of [false, true]) {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/config', async route => { if (route.request().method() === 'GET') { started(); await held; } await route.continue(); });
  if (reload) await page.reload(); else await page.goto('/assets/' + publication.asset.id);
  await pending;
  try { await expect(page.getByRole('status', { name: '正在读取配置…', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Startup document', exact: true })).toHaveCount(0); } finally { release(); }
  await page.unrouteAll({ behavior: 'wait' });
  const inspector = page.getByRole('button', { name: '查看来源与引用', exact: true });
  if (await inspector.getAttribute('aria-expanded') === 'false') await inspector.click();
  await expect(page.locator('.workspace-inspector').getByRole('link', { name: 'Startup bound project', exact: true })).toBeVisible();
 }
});

test('module startup exposes GET failure and retry', async ({ page, request }) => {
 const { config, revision } = await (await request.get('/api/config')).json();
 expect((await request.put('/api/config', { data: { revision, config: { ...config, system: { cli: 'codex', ...config.system, memory: { ...config.system?.memory, language: 'en' } } } } })).ok()).toBe(true);
 await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: 'Synthetic startup failure' } }) : route.continue());
 await page.goto('/market');
 await expect(page.getByRole('alert')).toContainText('Synthetic startup failure');
 await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
 await page.unroute('**/api/config');
 await page.getByRole('button', { name: '重试', exact: true }).click();
 await expect(page.getByRole('heading', { name: '市场', exact: true })).toBeVisible();
 await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
});

test('configuration failure survives navigation from Market to Files and can be retried', async ({ page }) => {
 await page.route('**/api/config', route => route.fulfill({ status: 503, json: { error: 'Synthetic config unavailable' } }));
 await page.goto('/market');
 await expect(page.getByRole('alert')).toHaveText('Synthetic config unavailable');
 await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '文件', exact: true }).click();
 await expect(page).toHaveURL(/\/assets/);
 await expect(page.getByRole('alert')).toHaveText('Synthetic config unavailable');
 await page.unroute('**/api/config');
 await page.getByRole('button', { name: '重试', exact: true }).click();
 await expect(page.getByRole('heading', { name: '文件', exact: true })).toBeVisible();
});

test('Market initializes configuration once and defers model failures until entering chat', async ({ page }) => {
 let release!: () => void, started!: () => void, modelFailed!: () => void, reads = 0, modelReads = 0;
 const held = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { started = resolve; }), model = new Promise<void>(resolve => { modelFailed = resolve; });
 await page.route('**/api/config', async route => { reads++; started(); await held; await route.continue(); });
 await page.route('**/api/models?*', async route => { modelReads++; await route.fulfill({ status: 503, json: { error: 'Synthetic model unavailable' } }); modelFailed(); });
 await page.goto('/market');await pending;
 try {
  await expect(page.getByRole('status', { name: '正在读取配置…', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  expect(reads).toBe(1);expect(modelReads).toBe(0);
 } finally { release(); }
 await page.unroute('**/api/config');
 await expect(page.getByRole('heading', { name: '市场', exact: true })).toBeVisible();
 expect(reads).toBe(1);expect(modelReads).toBe(0);
 await page.locator('aside.sidebar .sidebar-start .new-chat').click();await model;
 await expect(page.getByRole('alert')).toContainText('Synthetic model unavailable');
 await expect(page.getByRole('status', { name: '正在读取配置…', exact: true })).toHaveCount(0);
});
