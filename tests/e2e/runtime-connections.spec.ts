import {putRuntimeConfig} from './helpers/runtime-config';
import {waitForAutosave} from './helpers/settings';
import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';

async function fixture(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, executionDirectory: string) {
  const { revision } = await (await request.get('/api/config')).json();
  await putRuntimeConfig(request, { version: 2,
    projects: [{ id: 'runtime-project', name: 'Runtime project', cwd: executionDirectory, agentIds: ['runtime-agent'], resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'runtime-agent', name: 'Runtime Agent', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }],
  });
  await page.route('**/api/models?scope=system&cli=*', route => {
    const cli = new URL(route.request().url()).searchParams.get('cli');
    return route.fulfill({ json: [{ id: `${cli}-synthetic`, label: `${cli} Synthetic model` }] });
  });
  await page.route('**/api/cli/status?**', route => route.fulfill({ json: { status: 'ready', version: 'synthetic-version' } }));
}

test('system model candidates follow each task CLI independently of Project configuration', async ({ page, request, executionDirectory }) => {
  await fixture(page, request, executionDirectory);
  await page.goto('/settings/system');
  const title = page.getByRole('region', { name: '自动标题', exact: true });
  const memory = page.getByRole('region', { name: '记忆提炼', exact: true });
  await chooseOption(page, title.getByRole('combobox', { name: '模型', exact: true }), 'codex-synthetic');
  await chooseOption(page, title.getByRole('combobox', { name: '执行端', exact: true }), 'omp');
  await expect(title.getByRole('combobox', { name:'模型', exact: true })).toHaveAttribute('data-value','');
  await chooseOption(page, title.getByRole('combobox', { name: '模型', exact: true }), 'omp-synthetic');
  await chooseOption(page, memory.getByRole('combobox', { name: '模型', exact: true }), 'codex-synthetic');
  await waitForAutosave(page);
  const saved = (await (await request.get('/api/config')).json()).config;
  expect(saved.system.tasks).toEqual({ title: { cli: 'omp', model: 'omp-synthetic' }, memory: { cli: 'codex', model: 'codex-synthetic' } });
  await page.reload();
  await expect(title.getByRole('combobox', {name:'模型',exact:true})).toHaveAttribute('data-value','omp-synthetic');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('runtime access is saved centrally and only enabled CLIs are offered for new work', async ({ page, request, executionDirectory }) => {
  await fixture(page, request, executionDirectory);
  await page.goto('/settings/runtimes');
  await expect(page.locator('.runtime-connections')).toBeVisible();
  const codex = page.getByRole('region', { name: 'Codex', exact: true });
  await expect(codex.getByText('synthetic-version', { exact: true })).toBeVisible();
  await codex.getByRole('button', {name:'配置',exact:true}).click();
  await page.getByRole('button', {name:'停用 CLI',exact:true}).click();
  await expect(page).toHaveURL('/settings/runtimes');
  expect((await (await request.get('/api/config')).json()).config.runtimes).toEqual(['omp']);
  await page.getByRole('link', { name: '系统任务', exact: true }).click();
  const title = page.getByRole('region', { name: '自动标题', exact: true });
  await title.getByRole('combobox', { name: '执行端', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/?project=runtime-project&agent=runtime-agent');
  await expect(page.getByRole('combobox', { name: '当前 CLI', exact: true })).toHaveAttribute('data-value', 'omp');
  await page.getByRole('combobox', { name: '当前 CLI', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Codex', exact: true })).toHaveCount(0);
});

test('failed model discovery can retry and leaves custom model IDs editable', async ({ page, request, executionDirectory }) => {
  await fixture(page, request, executionDirectory);
  let fail = true;
  await page.route('**/api/models?scope=system&cli=codex', route => route.fulfill(fail
    ? { status: 400, json: { error: 'Synthetic discovery failure' } }
    : { json: [{ id: 'codex-recovered', label: 'Recovered model' }] }));
  await page.goto('/settings/system');
  const title = page.getByRole('region', { name: '自动标题', exact: true });
  await expect(title.getByText('Synthetic discovery failure', { exact: true })).toBeVisible();
  await title.getByRole('combobox',{name:'模型',exact:true}).click();
  await page.getByRole('searchbox',{name:'模型 · 搜索选项',exact:true}).fill('custom-model');
  await page.getByRole('option',{name:'custom-model',exact:true}).click();
  fail = false;
  await title.getByRole('button', { name: '刷新模型目录', exact: true }).click();
  await chooseOption(page, title.getByRole('combobox', { name: '模型', exact: true }), 'codex-recovered');
  await expect(title.getByRole('combobox', {name:'模型',exact:true})).toHaveAttribute('data-value','codex-recovered');
});

test('system catalogs need no Project and runtime connections work in English on narrow screens', async ({ page, request, executionDirectory }) => {
  await fixture(page, request, executionDirectory);
  const { revision } = await (await request.get('/api/config')).json();
  await putRuntimeConfig(request, { version: 2, projects: [], agents: [] });
  await page.addInitScript(() => localStorage.setItem('mana-project', 'obsolete-project'));
  const projectCatalogRequests: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/models?projectId=')) projectCatalogRequests.push(r.url()); });
  await page.goto('/settings/system');
  const title = page.getByRole('region', { name: '自动标题', exact: true });
  await chooseOption(page, title.getByRole('combobox', { name: '模型', exact: true }), 'codex-synthetic');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(projectCatalogRequests).toEqual([]);
  await page.goto('/settings/general');
  await chooseOption(page, 'Language / 语言', 'en');
  await page.getByRole('link', { name: 'CLI adapters', exact: true }).click();
  await expect(page.locator('.runtime-connections')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'OMP', exact: true }).getByRole('button', {name:'Configure',exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('disabling all runtimes prevents new work and preserves native settings and old chats', async ({ page, request, executionDirectory }) => {
  await fixture(page, request, executionDirectory);
  const chat = await (await request.post('/api/conversations', { data: { projectId: 'runtime-project', agentId: 'runtime-agent', cli: 'codex' } })).json();
  await page.goto('/settings/runtimes');
  for (const name of ['Codex', 'OMP']) {
    await page.getByRole('region', { name, exact: true }).getByRole('button', {name:'配置',exact:true}).click();
    await page.getByRole('button', {name:'停用 CLI',exact:true}).click();
    await expect(page).toHaveURL('/settings/runtimes');
  }
  const config = (await (await request.get('/api/config')).json()).config;
  expect(config.runtimes).toEqual([]);
  expect(config.agents[0].defaultCli).toBe('codex');
  await page.goto('/?project=runtime-project&agent=runtime-agent');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Do not start');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: '启用执行端后开始对话', exact: true })).toBeVisible();
  await page.goto(`/?project=runtime-project&conversation=${chat.id}`);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('Existing conversation continues');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Fixture reply: Existing conversation continues', { exact: true })).toBeVisible();
});

test('ACP runtimes can be enabled for chats and tools-disabled system tasks',async({page,request,executionDirectory},testInfo)=>{
 await fixture(page,request,executionDirectory);
 await page.goto('/settings/runtimes');
 await page.getByRole('button',{name:'新增 CLI',exact:true}).click();
 await page.getByRole('combobox',{name:'选择 CLI',exact:true}).click();
 for(const name of ['Claude Code','Gemini CLI','OpenCode'])await expect(page.getByRole('option',{name,exact:true})).toBeVisible();
 await page.getByRole('option',{name:'Gemini CLI',exact:true}).click();
 await page.getByRole('button',{name:'启用 CLI',exact:true}).click();
 await expect(page).toHaveURL('/settings/runtimes');
 expect((await(await request.get('/api/config')).json()).config.runtimes).toContain('gemini');
 await page.screenshot({path:testInfo.outputPath('runtime-catalog.png'),fullPage:true});
 await page.goto('/settings/system');
 const title=page.getByRole('region',{name:'自动标题',exact:true});
 await title.getByRole('combobox',{name:'执行端',exact:true}).click();
 await expect(page.getByRole('option',{name:'Gemini CLI',exact:true})).toBeVisible();
});

test('appearance does not load models and Runtime configuration only loads its own catalog', async ({ page, request }) => {
 const {revision}=await (await request.get('/api/config')).json();
 await putRuntimeConfig(request, {version:2,projects:[],agents:[],runtimes:['codex']});
 const requested:string[]=[];
 await page.route('**/api/models?**',route=>{
  requested.push(new URL(route.request().url()).searchParams.get('cli')!);
  return route.fulfill({json:[{id:'enabled-model',label:'Enabled model',isDefault:true}]});
 });
 await page.goto('/settings/general');
 await expect(page.getByRole('heading',{name:'主题与外观',exact:true})).toBeVisible();expect(requested).toEqual([]);
 await page.goto('/settings/runtimes/codex');
 await expect(page.getByRole('combobox',{name:'Codex 模型',exact:true})).toContainText('Enabled model');
 expect([...new Set(requested)]).toEqual(['codex']);
});
