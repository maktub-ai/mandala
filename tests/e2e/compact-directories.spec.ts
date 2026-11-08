import { expect, test } from '@playwright/test';
import { storedUiState } from './helpers/preferences';

for (const width of [1440, 1024, 768, 390]) for (const mode of ['light', 'dark']) {
 test.describe(`${width} ${mode}`, () => {
  test.use({viewport:{width,height:900},storageState:storedUiState('en')});
  test('independent directories, canonical detail routes and shared identity survive reload', async ({page,request}) => {
   const snapshot = await (await request.get('/api/config')).json();
   const agent={id:'compact-shared-agent',name:'Shared engineer · 跨项目协作',instructions:'Keep the original durable identity and inspect evidence.',defaultCli:'codex',models:{},mcp:[],skills:[]};
   const projects=['compact-first','compact-second'].map((id,index)=>({id,name:index?'Second project · 第二个项目':'First project',background:'Real project background',cwd:'/tmp',agentIds:[agent.id],resources:[],mcp:[],skills:[]}));
   expect((await request.put('/api/config',{data:{revision:snapshot.revision,config:{version:2,projects,agents:[agent]}}})).ok()).toBe(true);
   await page.goto('/projects');
   await page.evaluate(value=>{ const key='mandala-appearance-v1'; const saved=localStorage.getItem(key); if(saved) { const preferences=JSON.parse(saved);preferences.mode=value;localStorage.setItem(key,JSON.stringify(preferences)); } else localStorage.setItem('mana-theme',value); },mode);
   await page.reload();
   await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
   await expect(page.locator('.workspace-directory-row')).toHaveCount(2);
   if(width>600) {
    await expect(page.locator('.sidebar-destination[data-area=projects]')).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('button',{name:'User menu',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'User menu',exact:true}).click();
    await expect(page.getByRole('menuitem',{name:'Library',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
   }
   await page.locator('.workspace-directory-row').first().click();
   await expect(page).toHaveURL(/\/projects\/compact-first\/overview$/);
   const projectNav=page.getByRole('navigation',{name:'Project navigation',exact:true});
   await expect(projectNav.getByRole('link')).toHaveCount(3);
   await page.getByRole('region',{name:'Work overview'}).getByRole('link',{name:/Associated tasks/}).click();
   await expect(page).toHaveURL(url=>url.pathname==='/tasks'&&url.searchParams.get('project')==='compact-first');
   await expect(page.locator('main')).toContainText('No matching work');
   await page.reload(); await expect(page.locator('main')).toContainText('No matching work');
   await page.goto('/agents/'+agent.id);
   await expect(page.locator('.agent-overview')).toContainText(agent.instructions);
   await expect(page.locator('.agent-overview')).toContainText('Second project');
   await expect(page.locator('.instructions-card textarea')).toHaveCount(0);
   await page.getByRole('region',{name:'Work and memory'}).getByRole('link',{name:/Active memories/}).click();
   await expect(page).toHaveURL(url=>url.pathname==='/mana'&&url.searchParams.get('agent')===agent.id);
   await expect(page.getByRole('region',{name:'Memory index',exact:true})).toBeVisible();
   await page.reload(); await expect(page.getByRole('region',{name:'Memory index',exact:true})).toBeVisible();
   await page.goBack();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const finalConfig=(await(await request.get('/api/config')).json()).config;
   expect(finalConfig.agents).toHaveLength(1);
   expect(finalConfig.projects.map((project:any)=>project.agentIds)).toEqual([[agent.id],[agent.id]]);
   await page.screenshot({path:`/tmp/compact-directories-${width}-${mode}.png`});
  });
 });
}

test.describe('Agent configuration and memory boundaries',()=>{
 test.use({storageState:storedUiState('en')});
 test.beforeEach(async({request})=>{
  const snapshot=await(await request.get('/api/config')).json();
  const agent={id:'configuration-agent',name:'Shared Agent',instructions:'Inspect real evidence',defaultCli:'codex',models:{},mcp:[],skills:[]};
  const projects=['first','second'].map(id=>({id,name:id,cwd:'/tmp',agentIds:[agent.id],resources:[],mcp:[],skills:[]}));
  expect((await request.put('/api/config',{data:{revision:snapshot.revision,config:{version:2,projects,agents:[agent]}}})).ok()).toBe(true);
 });
 test('cancelling Agent creation returns to its directory without creating an identity',async({page,request})=>{
  const before=await(await request.get('/api/config')).json();
  await page.goto('/agents');await page.getByRole('button',{name:'Add agent',exact:true}).click();
  await page.getByRole('button',{name:'Cancel new agent',exact:true}).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.locator('.workspace-directory')).toBeVisible();
  expect((await(await request.get('/api/config')).json()).config).toEqual(before.config);
 });
 test('read-first profile editing autosaves the same identity',async({page,request})=>{
  const snapshot=await(await request.get('/api/config')).json();
  const agent=snapshot.config.agents[0];
  await page.goto('/agents/'+agent.id);
  await page.getByRole('button',{name:'Object actions'}).click();await page.getByRole('menuitem',{name:'Edit name and appearance'}).click();
  await page.getByRole('textbox',{name:'Name',exact:true}).fill('Renamed shared Agent');
  await expect.poll(async()=>{const value=await(await request.get('/api/config')).json();return value.config.agents.find((item:any)=>item.id===agent.id)?.name;}).toBe('Renamed shared Agent');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await expect(page.locator('.object-header')).toContainText('Renamed shared Agent');
  const value=await(await request.get('/api/config')).json();
  expect(value.config.agents).toHaveLength(1);
  expect(value.config.projects.every((project:any)=>project.agentIds.includes(agent.id))).toBe(true);
  await page.getByRole('button',{name:'Object actions'}).click();await page.getByRole('menuitem',{name:'Edit name and appearance'}).click();
  expect((await request.put('/api/config',{data:{revision:value.revision,config:{...value.config,agents:value.config.agents.map((item:any)=>({...item,instructions:'Changed by another editor'}))}}})).ok()).toBe(true);
  await page.getByRole('textbox',{name:'Name',exact:true}).fill('Unsaved conflict input');
  await expect(page.locator('.settings-save-error')).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Unsaved conflict input');
  const external=await(await request.get('/api/config')).json();
  expect(external.config.agents[0].name).toBe('Renamed shared Agent');
  await page.reload();
  await expect(page.getByRole('region',{name:'Role and instructions',exact:true})).toContainText('Changed by another editor');
 });
 test('Agent memory exact lookup retains scope and correction locks navigation',async({page,request})=>{
  const snapshot=await(await request.get('/api/config')).json();const agent=snapshot.config.agents[0];
  const common={revision:1,layer:'L1',contentType:'fact',status:'active',verification:'evidence_extract',evidence:[],extractedAt:'2026-10-29T00:00:00Z'};
  await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[{...common,recordId:'own-record',collectionId:'own',text:'Scoped Agent fact'},{...common,recordId:'other-record',collectionId:'other',text:'Other Agent fact'}],collections:[{id:'own',projectId:null,agentId:agent.id},{id:'other',projectId:null,agentId:'another-agent'}]}}));
  await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
  await page.goto('/agents/'+agent.id+'/memory?recordId=other-record');
  await expect(page.getByText('Other Agent fact',{exact:true})).toHaveCount(0);
  await page.goto('/agents/'+agent.id+'/memory');
  await expect(page.getByText('Scoped Agent fact',{exact:true})).toBeVisible();
  const projectScope=page.getByRole('combobox',{name:'Project scope',exact:true});
  await projectScope.click();await page.getByRole('option',{name:'first',exact:true}).click();
  await expect(page).toHaveURL(url=>url.pathname==='/mana'&&url.searchParams.get('agent')===agent.id&&url.searchParams.get('project')==='first');
  await expect(page.getByText('Other Agent fact',{exact:true})).toHaveCount(0);
  await projectScope.click();await page.getByRole('option',{name:'All projects and personal',exact:true}).click();
  await expect(page.getByText('Scoped Agent fact',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Correct',exact:true}).click();
  await expect(projectScope).toBeDisabled();
  await expect(page.locator('.sidebar-start button')).toBeDisabled();
  await page.keyboard.press('Meta+n');await expect(page).toHaveURL(url=>url.pathname==='/mana'&&url.searchParams.get('agent')===agent.id);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(projectScope).toBeEnabled();
 });
});
