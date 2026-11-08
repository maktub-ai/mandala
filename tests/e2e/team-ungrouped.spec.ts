import { test, expect } from '@playwright/test';
import { editAgentProfile } from './helpers/navigation';
import { waitForAutosave } from './helpers/settings';

const fixture = { version: 2, system: { cli: 'codex', memory: { language: 'zh-CN' } },
  projects: [{ id: 'project', name: 'Product', cwd: '/tmp', agentIds: ['member'], resources: [], mcp: [], skills: [] }],
  agents: ['member', 'reader'].map(id => ({ id, name: id === 'member' ? 'Project member' : 'Independent reader',
    instructions: '', defaultCli: 'omp', models: {}, mcp: [], skills: [] })),
};
test.beforeEach(async ({ page, request }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { config: fixture, revision } })).ok()).toBe(true);
  await page.route('**/api/models?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/status?**', route => route.fulfill({ json: { status: 'ready', version: null } }));
});

test('independent directory selection reveals the same Agent without creating a Project',async({page,request})=>{
 const original=(await(await request.get('/api/config')).json()).config;await page.goto('/agents');await expect(page.locator('.workspace-directory-row')).toHaveCount(2);const reader=page.locator('.workspace-directory-row[href="/agents/reader"]');await expect(reader).toBeVisible();await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('member');await expect(reader).toHaveCount(0);await page.getByRole('searchbox',{name:'智能体',exact:true}).fill('reader');await reader.click();await expect(page.locator('.agent-overview')).toContainText('尚未关联项目');await editAgentProfile(page);await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue('Independent reader');await page.reload();await expect(page.locator('.agent-overview')).toContainText('尚未关联项目');expect((await(await request.get('/api/config')).json()).config).toEqual(original);
});
test('narrow English search reveals independent Agents and membership updates preserve their identity',async({page,request})=>{
 await page.setViewportSize({width:390,height:850});await page.addInitScript(()=>localStorage.setItem('mana-language','en'));await page.goto('/agents');await page.getByRole('searchbox',{name:'Agents',exact:true}).fill('reader');await page.locator('.workspace-directory-row[href="/agents/reader"]').click();await editAgentProfile(page);await expect(page.getByRole('textbox',{name:'Agent name',exact:true})).toHaveValue('Independent reader');await page.goto('/projects/manage?project=project&tab=members');await page.getByRole('checkbox',{name:'Independent reader',exact:true}).check();await waitForAutosave(page);await page.goto('/projects/project/agents');await expect(page.getByRole('button',{name:/Independent reader/})).toBeVisible();const {config}=await(await request.get('/api/config')).json();expect(config.projects).toHaveLength(1);expect(config.projects[0].agentIds).toEqual(['member','reader']);expect(config.agents).toEqual(fixture.agents);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
