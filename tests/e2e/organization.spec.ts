import { test, expect } from '@playwright/test';
import { openArea, editAgentProfile } from './helpers/navigation';
import { waitForAutosave } from './helpers/settings';
const fixture = { version: 2, system: { cli: 'codex', memory: { language: 'zh-CN' } },
  projects: ['one', 'two'].map(id => ({ id, name: `Personal ${id}`, cwd: '/tmp', agentIds: ['architect'], resources: [], mcp: [], skills: [] })),
  agents: ['architect', 'unlinked'].map(id => ({ id, name: id === 'architect' ? 'Shared architect' : 'Independent reader',
    instructions: 'Synthetic personal sample only.', defaultCli: 'omp', models: {}, mcp: [], skills: [] })),
};
test.beforeEach(async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { config: fixture, revision } })).ok()).toBe(true);
  await page.route('**/api/models?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/status?**', route => route.fulfill({ json: { status: 'ready', version: null } }));
});

test('navigation exposes the active area without opening its menu', async ({ page }) => {
  await page.goto('/?project=one&agent=architect');
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  await expect(navigation).toHaveAttribute('data-active-area', 'chat');
  for (const [name, area] of [['团队', 'agents'], ['MANA 工作区', 'mana'], ['设置', 'settings']]) {
    await openArea(page, name);
    await expect(navigation).toHaveAttribute('data-active-area', area);
  }
});

test('legacy organization route opens Agents and project details preserve existing relationships',async({page,request})=>{
 const original=(await(await request.get('/api/config')).json()).config;await page.goto('/mana?tab=organization');await expect(page).toHaveURL(/\/agents$/);await expect(page.locator('.workspace-directory').getByRole('heading',{level:1})).toHaveText('智能体');await expect(page.locator('.workspace-directory-row')).toHaveCount(2);
 await page.goto('/projects');await page.locator('.workspace-directory-row[href="/projects/two/overview"]').click();await page.getByRole('button',{name:'项目设置',exact:true}).click();await expect(page.getByRole('textbox',{name:'项目名称',exact:true})).toHaveValue('Personal two');await page.getByRole('tab',{name:'参与者',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Shared architect',exact:true})).toBeChecked();expect((await(await request.get('/api/config')).json()).config).toEqual(original);
});
test('shared agents remain unique and keyboard directory selection exposes explicit editing and relationships',async({page})=>{
 await page.goto('/agents');const row=page.locator('.workspace-directory-row[href="/agents/architect"]');await expect(row).toHaveCount(1);await expect(page.locator('.workspace-directory-row')).toHaveCount(2);await row.focus();await row.press('Enter');await expect(page).toHaveURL(/\/agents\/architect$/);await expect(page.locator('.agent-overview')).toContainText('Personal one');await expect(page.locator('.agent-overview')).toContainText('Personal two');await editAgentProfile(page);await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue('Shared architect');await page.getByRole('tab',{name:'执行',exact:true}).click();await expect(page.getByRole('combobox',{name:'默认执行端',exact:true})).toHaveAttribute('data-value','omp');await expect(page.getByRole('combobox',{name:'OMP 默认模型',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'Codex 默认模型',exact:true})).toHaveCount(0);
});
test('project membership editing preserves shared identity and updates readable associations',async({page,request})=>{
 await page.goto('/projects/manage?project=two&tab=members');await page.getByRole('checkbox',{name:'Shared architect',exact:true}).uncheck();await waitForAutosave(page);const {config}=await(await request.get('/api/config')).json();expect(config.projects[1].agentIds).toEqual([]);expect(config.projects[0].agentIds).toEqual(['architect']);expect(config.agents).toEqual(fixture.agents);await page.getByRole('link',{name:'返回项目',exact:true}).click();await expect(page.locator('.workspace-directory-row')).toHaveCount(2);await page.goto('/agents');await expect(page.locator('.workspace-directory-row[href="/agents/architect"]')).toHaveCount(1);await page.locator('.workspace-directory-row[href="/agents/architect"]').click();await expect(page.locator('.agent-overview')).toContainText('Personal one');await expect(page.locator('.agent-overview')).not.toContainText('Personal two');await editAgentProfile(page);await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue('Shared architect');
});
test('concurrent relationship edits preserve the external version and retain the local draft for review', async ({ page, request }) => {
  await page.goto('/projects/manage?project=two&tab=members');
  await expect(page.getByRole('checkbox', { name: 'Shared architect', exact: true })).toBeChecked();
  const fresh = await (await request.get('/api/config')).json();
  fresh.config.projects[0].agentIds = [];
  expect((await request.put('/api/config', { data: fresh })).ok()).toBe(true);
  await page.getByRole('checkbox', { name: 'Shared architect', exact: true }).uncheck();
  await expect(page.locator('.settings-save-error')).toBeVisible();
  const { config } = await (await request.get('/api/config')).json();
  expect(config.projects[0].agentIds).toEqual([]);
  expect(config.projects[1].agentIds).toEqual(['architect']);
  await expect(page.getByRole('checkbox', { name: 'Shared architect', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Shared architect', exact: true })).toBeChecked();
});

test('English narrow layout supports independent directory search and explicit Agent configuration',async({page})=>{
 await page.setViewportSize({width:390,height:850});await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.goto('/mana?tab=organization');await expect(page.locator('.workspace-directory').getByRole('heading',{level:1})).toHaveText('Agents');await page.getByRole('searchbox',{name:'Agents',exact:true}).fill('Independent');await expect(page.locator('.workspace-directory-row')).toHaveCount(1);await page.locator('.workspace-directory-row[href="/agents/unlinked"]').click();await editAgentProfile(page);await expect(page.getByRole('textbox',{name:'Agent name',exact:true})).toHaveValue('Independent reader');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
