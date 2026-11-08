import {enterModelId} from './helpers/select';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { openTeamDirectory } from './helpers/navigation';
import { waitForAutosave } from './helpers/settings';

async function fixture(request: APIRequestContext) {
 const {config,revision}=await(await request.get('/api/config')).json();
 const suffix=crypto.randomUUID();
 const agents=['Research','Review'].map((name,i)=>({id:`object-agent-${suffix}-${i}`,name:`${name} ${suffix}`,instructions:`${name} responsibilities`,defaultCli:'codex',models:{},mcp:[],skills:[]}));
 const projects=['Product','Data'].map((name,i)=>({id:`object-project-${suffix}-${i}`,name:`${name} ${suffix}`,cwd:'',background:`${name} background`,agentIds:[agents[0].id],resources:[],mcp:[],skills:[]}));
 expect((await request.put('/api/config',{data:{revision,config:{...config,projects,agents}}})).ok()).toBe(true);
 return {agents,projects};
}
async function pick(page:Page,kind:'agent'|'project',id:string,name:string) {
 await expect(page.locator('.settings-autosave')).toBeHidden();
 await openTeamDirectory(page);
 await page.locator('#content-projects').getByRole('searchbox',{name:/^(搜索项目或智能体|Search projects or agents)$/,exact:true}).fill(name);
 const browser=page.locator('#content-projects');
 await browser.locator(`a[href*="${id}"]`).first().click();
 await expect(page).toHaveURL(new RegExp((kind==='agent'?'agent':'project')+'='+id));
 await expect(page.locator('.object-detail-heading h2')).toHaveText(name);
}
async function section(page:Page,label:RegExp) {
 await expect(page.locator('.object-tabs,.object-section-index')).toBeVisible();
 const tab=page.getByRole('tab',{name:label,exact:true});
 if(await tab.count())await tab.click();else await page.locator('.object-section-index').getByRole('link',{name:label,exact:true}).click();
}
for(const language of ['zh-CN','en'])for(const width of [1440,390])for(const theme of ['light','dark'])test.describe(`${language} ${width} ${theme}`,()=>{
 test.use({viewport:{width,height:900}});
 test('selection and configuration persist real shared Agent and project fields',async({page,request})=>{
  const f=await fixture(request);
  await page.addInitScript(({language,theme})=>{localStorage.setItem('mana-language',language);localStorage.setItem('mana-theme',theme);},{language,theme});
  await page.goto('/agents?agent='+f.agents[0].id);
  await expect(page.locator('.object-detail-heading')).toContainText(f.projects[0].name);
  await expect(page.locator('.object-detail-heading')).toContainText(f.projects[1].name);
  const instructions=page.getByRole('textbox',{name:/^(职责与指令|Responsibilities & instructions)$/,exact:true});
  await instructions.fill('Shared real responsibilities');await waitForAutosave(page);
  await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.agents.find((a:{id:string})=>a.id===f.agents[0].id).instructions;}).toBe('Shared real responsibilities');
  await expect(page.locator('.settings-autosave')).toBeHidden();
  await section(page,/^(执行|Execution)$/);
  await enterModelId(page,page.getByRole('combobox',{name:/^(Codex 默认模型|Codex default model)$/,exact:true}),'object-test-model');await waitForAutosave(page);
  await pick(page,'agent',f.agents[1].id,f.agents[1].name);
  await section(page,/^(执行|Execution)$/);
  await expect(page.getByRole('combobox',{name:/^(Codex 默认模型|Codex default model)$/,exact:true})).toHaveAttribute('data-value','');
  await pick(page,'agent',f.agents[0].id,f.agents[0].name);
  await section(page,/^(执行|Execution)$/);
  await expect(page.getByRole('combobox',{name:/^(Codex 默认模型|Codex default model)$/,exact:true})).toHaveAttribute('data-value','object-test-model');
  await page.reload();await expect(page.getByRole('combobox',{name:/^(Codex 默认模型|Codex default model)$/,exact:true})).toHaveAttribute('data-value','object-test-model');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.goto('/projects/manage?project='+f.projects[0].id+'&tab=background');
  await page.getByRole('textbox',{name:/^(项目背景|Project context)$/,exact:true}).fill('Context aligned with the actual project');await waitForAutosave(page);
  await section(page,/^(参与者|Participants)$/);
  await page.getByRole('checkbox',{name:f.agents[1].name,exact:true}).check();await waitForAutosave(page);
  await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.projects.find((p:{id:string})=>p.id===f.projects[0].id).agentIds;}).toEqual(f.agents.map(a=>a.id));
  await pick(page,'project',f.projects[1].id,f.projects[1].name);
  await section(page,/^(参与者|Participants)$/);
  await expect(page.getByRole('checkbox',{name:f.agents[1].name,exact:true})).not.toBeChecked();
  await pick(page,'project',f.projects[0].id,f.projects[0].name);await section(page,/^(参与者|Participants)$/);await page.reload();
  await expect(page.getByRole('checkbox',{name:f.agents[1].name,exact:true})).toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 });
});

test('object history, empty search and creation cancellation retain the actual objects',async({page,request})=>{
 const f=await fixture(request);await page.goto('/agents');
 await pick(page,'agent',f.agents[0].id,f.agents[0].name);
 await pick(page,'agent',f.agents[1].id,f.agents[1].name);
 await page.goBack();await expect(page).toHaveURL(new RegExp('agent='+f.agents[0].id));
 await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue(f.agents[0].name);
 await page.goForward();await expect(page.getByRole('textbox',{name:'智能体 名称',exact:true})).toHaveValue(f.agents[1].name);
 await openTeamDirectory(page);
 await page.locator('#content-projects').getByRole('searchbox',{name:'搜索项目或智能体',exact:true}).fill('No matching object');
 await expect(page.locator('.directory-project-list a')).toHaveCount(0);
 await expect(page.locator('#content-projects')).toContainText('没有匹配选项');
 await page.getByRole('button',{name:'添加智能体',exact:true}).click();
 await page.getByRole('button',{name:'取消新增 智能体',exact:true}).click();
 await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.agents.map((a:{id:string})=>a.id);}).toEqual(f.agents.map(a=>a.id));
 await page.goto('/projects/manage');await expect(page.locator('.directory-overview')).toBeVisible();await page.getByRole('button',{name:'添加项目',exact:true}).click();
 await page.getByRole('region',{name:'新建项目',exact:true}).getByRole('textbox',{name:'项目名称',exact:true}).fill('Uncreated preparation');
 await page.getByRole('region',{name:'新建项目',exact:true}).getByRole('button',{name:'取消新增项目',exact:true}).click();
 await expect.poll(async()=>{const {config}=await(await request.get('/api/config')).json();return config.projects.map((p:{id:string})=>p.id);}).toEqual(f.projects.map(p=>p.id));
});

test('save errors preserve inputs and retry persists without an Apply button',async({page,request})=>{
 const f=await fixture(request);await page.goto('/agents?agent='+f.agents[0].id);
 let fail=true;
 await page.route('**/api/config',route=>route.request().method()==='PUT'&&fail?route.fulfill({status:503,json:{error:'Temporary save failure'}}):route.continue());
 const input=page.getByRole('textbox',{name:'智能体 名称',exact:true});await input.fill('Preserved after failure');
 await expect(page.locator('.settings-save-error')).toBeVisible();await expect(input).toHaveValue('Preserved after failure');
 fail=false;await page.getByRole('button',{name:'重试自动保存',exact:true}).click();await waitForAutosave(page);
 await page.reload();await expect(input).toHaveValue('Preserved after failure');await expect(page.locator('.settings-save-error')).toHaveCount(0);await expect(page.locator('.settings-autosave')).toBeHidden();
});
