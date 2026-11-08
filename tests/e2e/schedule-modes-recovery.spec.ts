import {expect,test,type APIRequestContext} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
import {chooseOption} from './helpers/select';

test.use({storageState:storedUiState('en')});
async function setup(request:APIRequestContext){
 const {config,revision}=await(await request.get('/api/config')).json();
 const agent={id:'mode-scheduler',name:'Schedule executor',instructions:'Synthetic fixture',defaultCli:'codex',models:{},mcp:[],skills:[]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents.filter((a:{id:string})=>a.id!==agent.id),agent]}}})).ok()).toBe(true);
 return await(await request.post('/api/automations',{data:{name:'Mode review',instructions:'hold',projectId:'',agentId:agent.id,cli:'codex',workspaceId:null,enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
}
test('workdays save one independent rule and continuous can create its chat automatically',async({page,request})=>{
 await setup(request);await page.goto('/schedules');await page.getByRole('button',{name:'New schedule',exact:true}).click();const form=page.locator('.automation-editor');
 await form.getByLabel('Schedule name',{exact:true}).fill('Workday report');await form.getByLabel('Work instructions',{exact:true}).fill('Synthetic workday report');await chooseOption(page,form.getByRole('combobox',{name:'Agent',exact:true}),'mode-scheduler');
 await expect(form.getByRole('combobox',{name:'Execution mode',exact:true})).toHaveAttribute('data-value','independent');
 await chooseOption(page,form.getByRole('combobox',{name:'Repeat',exact:true}),'workdays');
 await form.getByRole('button',{name:'Save schedule',exact:true}).click();await expect(form).toHaveCount(0);
 let data=await(await request.get('/api/automations')).json(),saved=data.automations.find((a:{name:string})=>a.name==='Workday report');expect(saved.executionMode).toBe('independent');expect(saved.schedule.weekdays).toEqual([1,2,3,4,5]);expect(saved.enabled).toBe(false);expect(data.runs.filter((r:{automationId:string})=>r.automationId===saved.id)).toHaveLength(0);
 await page.getByRole('article',{name:'Workday report',exact:true}).getByRole('button',{name:'Edit',exact:true}).click();await chooseOption(page,form.getByRole('combobox',{name:'Execution mode',exact:true}),'continuous');await expect(form.getByRole('combobox',{name:'Execution conversation',exact:true})).toHaveAttribute('data-value','');await form.getByRole('button',{name:'Save schedule',exact:true}).click();await expect(form).toHaveCount(0);
 data=await(await request.get('/api/automations')).json();saved=data.automations.find((a:{id:string})=>a.id===saved.id);expect(saved.executionMode).toBe('continuous');expect(saved.conversationId??null).toBeNull();
});
test('accepted run stays acknowledged when the refresh fails',async({page,request})=>{
 const saved=await setup(request);await page.goto('/schedules?schedule='+saved.id);let refreshFails=false;
 await page.route('**/api/automations',route=>refreshFails?route.fulfill({status:503,json:{error:'Synthetic refresh failure'}}):route.continue());
 await page.route('**/api/automations/'+saved.id+'/run',async route=>{const response=await route.fetch();refreshFails=true;await route.fulfill({response});});
 const plan=page.getByRole('article',{name:'Mode review',exact:true});await plan.getByRole('button',{name:'Run once',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Refresh failed');await expect(plan.getByRole('button',{name:'Run once',exact:true})).toBeEnabled();await expect(plan.getByRole('button',{name:'Check previous run',exact:true})).toHaveCount(0);await expect(page.locator('.schedule-detail-history .automation-run')).toHaveCount(1);
 expect(await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('mandala-schedule-commands:')).map(([,value])=>value))).toEqual(['{}']);
});
test('page render recovery keeps schedule input and can navigate to another page',async({page,request})=>{
 const saved=await setup(request);await page.goto('/schedules');await page.getByRole('button',{name:'New schedule',exact:true}).click();await page.getByLabel('Schedule name',{exact:true}).fill('Retained recovery draft');
 await page.route('**/api/automations',async route=>{const response=await route.fetch();const body=await response.json();body.automations.find((rule:{id:string})=>rule.id===saved.id).schedule={kind:'once',at:'not-a-date'};await route.fulfill({json:body});});
 await expect(page.getByRole('heading',{name:'This page could not be displayed',exact:true})).toBeVisible({timeout:10000});await page.getByRole('button',{name:'Open Projects',exact:true}).click();await expect(page.getByRole('heading',{name:'Projects',exact:true})).toBeVisible();await page.unroute('**/api/automations');await page.evaluate(()=>{history.pushState(null,'','/schedules');dispatchEvent(new PopStateEvent('popstate'));});await expect(page.getByLabel('Schedule name',{exact:true})).toHaveValue('Retained recovery draft');
});
test('a slow schedule read leaves other pages reachable',async({page,request})=>{
 await setup(request);await page.route('**/api/automations',async route=>{await new Promise<void>(resolve=>page.once('close',()=>resolve()));await route.abort().catch(()=>{});});await page.goto('/schedules');await expect(page.getByText('Loading schedules…',{exact:true})).toBeVisible();await page.locator('.sidebar-start .new-chat').click();await expect(page.locator('.composer')).toBeVisible();
});
test('legacy temporary executor and all legacy modes survive a time-only edit',async({page,request})=>{
 const base=await setup(request),{config,revision}=await(await request.get('/api/config')).json();
 const temporary={...config.agents.find((a:{id:string})=>a.id==='mode-scheduler'),id:'temporary-scheduler',name:'Temporary report executor',temporary:true};
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,temporary]}}})).ok()).toBe(true);
 const rules=[{...base,id:'legacy-goal',goalId:'synthetic-goal',agentId:temporary.id},{...base,id:'legacy-task',taskId:'synthetic-task'},{...base,id:'legacy-bound',taskId:'synthetic-task',conversationId:'synthetic-chat'}].map(({executionMode,...rule})=>rule);
 let submitted:any;
 await page.route('**/api/automations',route=>route.fulfill({json:{version:1,automations:rules,runs:[]}}));
 await page.route('**/api/automations/legacy-goal',async route=>{submitted=route.request().postDataJSON();await route.fulfill({json:{...rules[0],...submitted,revision:2}});});
 await page.goto('/schedules?schedule=legacy-goal');const plan=page.getByRole('article',{name:'Mode review',exact:true});await expect(plan).toContainText('New child Task each run');await plan.getByRole('button',{name:'Edit',exact:true}).click();const form=page.locator('.automation-editor');await expect(form.getByRole('combobox',{name:'Agent',exact:true})).toContainText('Temporary report executor');await expect(form.getByRole('combobox',{name:'Execution mode',exact:true})).toHaveAttribute('data-value','legacy');await form.getByLabel('Run time',{exact:true}).fill('10:30');await form.getByRole('button',{name:'Save schedule',exact:true}).click();await expect.poll(()=>submitted?.schedule.time).toBe('10:30');expect(submitted.agentId).toBe(temporary.id);expect(submitted.cli).toBe('codex');expect(submitted).not.toHaveProperty('executionMode');expect(submitted).not.toHaveProperty('bindingGeneration');
 await page.goto('/schedules?schedule=legacy-task');await expect(plan).toContainText('Shared Task · fresh Chat each run');await page.goto('/schedules?schedule=legacy-bound');await expect(plan).toContainText('Shared Task · bound Chat');
});
test('an App render error has an outer recovery action and restores a persisted chat draft',async({page,request})=>{
 await setup(request);await page.goto('/mandala');const composer=page.locator('.composer textarea');await expect(composer).toBeEnabled();const saved=page.waitForResponse(response=>response.url().endsWith('/api/drafts/entry')&&response.request().method()==='PUT'&&response.request().postDataJSON()?.draft?.text==='Persisted chat recovery draft');await composer.fill('Persisted chat recovery draft');await saved;
 let sends=0;page.on('request',request=>{if(request.method()==='POST'&&/\/inputs$/.test(new URL(request.url()).pathname))sends++;});
 await page.route('**/api/config',async route=>{const response=await route.fetch();const data=await response.json();data.revision='synthetic-render-failure';data.config.agents=null;await route.fulfill({json:data});});
 await expect(page.getByRole('heading',{name:'This page could not be displayed',exact:true})).toBeVisible({timeout:10000});await page.unroute('**/api/config');await page.getByRole('button',{name:'Retry page',exact:true}).click();await expect(composer).toHaveValue('Persisted chat recovery draft');expect(sends).toBe(0);
});
test('failed schedule reads offer an explicit retry without discarding the page',async({page,request})=>{
 await setup(request);let fail=true;await page.route('**/api/automations',route=>fail?route.fulfill({status:503,json:{error:'Synthetic read outage'}}):route.continue());await page.goto('/schedules');await expect(page.getByRole('alert')).toContainText('Synthetic read outage');fail=false;await page.getByRole('button',{name:'Retry schedules',exact:true}).click();await expect(page.locator('.schedule-row').first()).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});
test('system Agent has ordinary chat choices while its primary chat is excluded',async({page,request})=>{
 await setup(request);const {config}=await(await request.get('/api/config')).json(),systemId=config.mandala.agentId;
 const {conversation:primary}=await(await request.get('/api/mandala')).json();const ordinary=await(await request.post('/api/conversations',{data:{projectId:'',agentId:systemId,cli:'codex',workspaceId:null}})).json();
 await page.goto('/schedules');await page.getByRole('button',{name:'New schedule',exact:true}).click();const form=page.locator('.automation-editor');await form.getByRole('combobox',{name:'Agent',exact:true}).click();await expect(page.getByRole('listbox').getByText('System Agent',{exact:true})).toBeVisible();await page.locator('[role=option][data-value="'+systemId+'"]').click();await chooseOption(page,form.getByRole('combobox',{name:'Execution mode',exact:true}),'continuous');await form.getByRole('combobox',{name:'Execution conversation',exact:true}).click();await expect(page.locator('[role=option][data-value="'+primary.id+'"]')).toHaveCount(0);await expect(page.locator('[role=option][data-value="'+ordinary.id+'"]')).toBeVisible();
});
