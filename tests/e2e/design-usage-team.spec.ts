import { test, expect } from '@playwright/test';

const fixture = { version: 2, system: { cli: 'codex', memory: { language: 'zh-CN' } },
  projects: ['one', 'two'].map(id => ({ id, name: `Project ${id}`, cwd: '/tmp', agentIds: ['architect'], resources: [], mcp: [], skills: [] })),
  agents: ['architect', 'reader'].map(id => ({ id, name: id === 'architect' ? 'Shared architect' : 'Independent reader', instructions: 'Synthetic design sample.', defaultCli: 'codex', models: {}, mcp: [], skills: [] })),
};
const totals = { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 40, cacheWriteInputTokens: null, reasoningOutputTokens: 10 };
const summary = { window: { start: '2026-10-17T00:00:00Z', end: '2026-10-18T00:00:00Z', timeZone: 'Asia/Singapore', period: 'today' }, generatedAt: '2026-10-17T05:00:00Z', totals,
  coverage: { observed: 0, partial: 1, unknown: 1, total: 2 }, daily: [{ date: '2026-10-17', totals, coverage: { observed: 0, partial: 1, unknown: 1, total: 2 } }],
  groups: { category: [{ key: 'task', totals }], agent: [], project: [], cli: [], model: [] }, recent: [],
};
test.beforeEach(async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { config: fixture, revision } })).ok()).toBe(true);
  await page.route('**/api/models?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/status?**', route => route.fulfill({ json: { status: 'ready', version: null } }));
  await page.route('**/api/usage?*', route => route.fulfill({ json: summary }));
});

test('usage preserves hierarchical metrics and preserves scoped periods and unknown detail values', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 760 });
  const requested: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/usage?')) requested.push(request.url()); });
  await page.goto('/usage?project=one');
  const usage = page.getByRole('region', { name: '已记录用量', exact: true });
  await expect(usage.locator('.usage-metrics dd')).toHaveText(['130', '100', '30']);
  await usage.getByRole('button', { name: '今日', exact: true }).click();
  await expect.poll(() => requested.some(url => url.includes('projectId=one') && url.includes('period=today'))).toBe(true);
  await expect(usage.locator('.usage-metrics dd')).toHaveText(['130', '100', '30']);
  for (const width of [1080, 390]) {
    await page.setViewportSize({ width, height: 760 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await usage.getByText('统计口径', { exact: true }).click();
  await expect(usage.locator('.usage-token-details')).toContainText('未上报');
  await usage.getByRole('combobox', { name: '分析维度' }).click();
  await page.getByRole('option', { name: '按调用类型', exact: true }).click();
  await usage.getByRole('button', { name: '表格', exact: true }).click();
  await expect(usage.getByRole('table', { name: '按调用类型' })).toContainText('130');
});

test('Agent keyboard selection shows readable relationships and explicit Project membership configuration',async({page,request})=>{
 const original=(await(await request.get('/api/config')).json()).config;await page.setViewportSize({width:1080,height:760});await page.goto('/agents');await expect(page.getByRole('searchbox',{name:'智能体',exact:true})).toHaveCount(1);const row=page.locator('.workspace-directory-row[href="/agents/architect"]');await row.focus();await row.press('Enter');const detail=page.locator('.agent-overview');await expect(detail).toBeVisible();expect((await detail.boundingBox())!.width).toBeGreaterThan(330);await expect(detail).toContainText('Project one');await expect(detail).toContainText('Project two');await page.goto('/projects/one/settings?tab=members');await expect(page.getByRole('checkbox',{name:'Shared architect',exact:true})).toBeChecked();await page.getByRole('link',{name:'返回项目',exact:true}).click();await expect(page).toHaveURL(/\/projects$/);await page.goto('/agents');await expect(row).toHaveCount(1);expect((await(await request.get('/api/config')).json()).config).toEqual(original);
});
for(const theme of ['light','dark'])test('narrow '+theme+' preserves unavailable work, scoped usage and readable identities',async({page},testInfo)=>{
 await page.setViewportSize({width:390,height:850});await page.addInitScript(value=>localStorage.setItem('mana-theme',value),theme);await page.route('**/api/v2/tasks',route=>route.fulfill({status:503,json:{error:'Unavailable'}}));const requested:string[]=[];page.on('request',request=>{if(request.url().includes('/api/usage?'))requested.push(request.url());});await page.goto('/agents/architect');const detail=page.locator('.agent-overview');await expect(detail).toContainText('Unavailable');await expect(detail.getByText('就绪',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Shared architect',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('agent-narrow-'+theme+'.png')});await page.goto('/usage?agent=architect');await expect.poll(()=>requested.some(url=>url.includes('agentId=architect'))).toBe(true);await expect(page.locator('.usage-metrics dd')).toHaveText(['130','100','30']);await page.goBack();await page.getByRole('link',{name:'返回智能体',exact:true}).click();const row=page.locator('.workspace-directory-row[href="/agents/architect"]');await expect(row).toBeVisible();await row.focus();await row.press('Enter');await expect(page.getByRole('heading',{name:'Shared architect',exact:true})).toBeInViewport();await page.getByRole('link',{name:'返回智能体',exact:true}).click();await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('no such identity');await expect(page.locator('.workspace-directory-row')).toHaveCount(0);await expect(page.locator('.ui-empty')).toBeVisible();
});

test('empty usage remains unknown and fetch failure is visible without invented zeros', async ({ page }) => {
  await page.route('**/api/usage?*', route => route.fulfill({ json: { ...summary, totals: Object.fromEntries(Object.keys(totals).map(key => [key, null])), coverage: { observed: 0, partial: 0, unknown: 0, total: 0 }, daily: [], groups: { category: [], agent: [], project: [], cli: [], model: [] } } }));
  await page.goto('/usage');
  const usage = page.getByRole('region', { name: '已记录用量', exact: true });
  await expect(usage.locator('.usage-metrics dd')).toHaveText(['—', '—', '—']);
  await expect(usage.getByText('这个时段还没有调用记录', { exact: true })).toBeVisible();
  await expect(usage.locator('.usage-breakdown')).toHaveCount(0);
  await page.route('**/api/usage?*', route => route.fulfill({ status: 503, json: { error: 'Usage unavailable' } }));
  await usage.getByRole('button', { name: '今日', exact: true }).click();
  await expect(usage.getByRole('alert')).toContainText('Usage unavailable');
  await expect(usage.locator('.usage-metrics')).toHaveCount(0);
});
