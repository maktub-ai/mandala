import {createTaskWithExecutionChats} from './helpers/task-executions';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from './helpers/select';
async function openTaskRule(page:Page){const summary=page.locator('.task-detail details > summary').filter({hasText:/^执行规则$/});if(await summary.locator('..').getAttribute('open')===null)await summary.click();}


test('task goals own optional disabled rules and keep save separate from execution', async ({ page, request }) => {
  const task = await (await request.post('/api/v2/tasks', { headers: { 'Idempotency-Key': 'task-rule-ui' }, data: { goal: 'Review daily report' } })).json();
  await page.goto('/tasks/' + task.id);
  await page.locator('.task-detail summary').filter({hasText:/^执行规则$/}).click();await expect(page.getByRole('heading', { name: '执行规则', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加执行规则', exact: true }).click();
  await expect(page.getByLabel('重复方式', { exact: true })).toBeVisible();
  await chooseOption(page,page.getByRole('form',{name:'新建执行规则',exact:true}).getByRole('combobox',{name:'执行端',exact:true}),'codex');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('.task-detail .automation-plan')).toContainText('已暂停');
  const state = await (await request.get('/api/automations')).json();
  const rule = state.automations.find((item: { taskId?: string }) => item.taskId === task.id);
  expect(rule.enabled).toBe(false);
  expect(rule.agentId).toBe('');await expect(page.locator('.automation-plan').getByRole('button',{name:'运行一次',exact:true})).toBeDisabled();await expect(page.locator('.automation-plan').getByRole('button',{name:'启用定时规则',exact:true})).toBeDisabled();
  expect((await (await request.get('/api/v2/tasks/' + task.id)).json()).runs).toHaveLength(0);
  await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '列表', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '看板', exact: true })).toBeVisible();
});

test('recognition failure preserves an editable plain task draft', async ({ page }) => {
  await page.route('**/api/v2/tasks/draft', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({error:'recognition unavailable'}) }));
  await page.goto('/tasks?action=create');
  await page.getByRole('button',{name:'手动填写',exact:true}).click();
  await page.getByLabel('任务标题', { exact: true }).fill('Tomorrow check source facts');
  await page.getByRole('button', { name: '识别需求', exact: true }).click();
  await expect(page.getByText('识别暂不可用，仍可保存待办。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tomorrow check source facts', exact: true })).toBeVisible();
  await expect(page.getByText('尚未运行', { exact: true }).first()).toBeVisible();
});

test('recognized schedules remain editable and explicit time fields win', async ({ page, request }) => {
  await page.goto('/tasks?action=create');
  await page.getByRole('button',{name:'手动填写',exact:true}).click();
  await page.getByLabel('任务标题', { exact: true }).fill('每天 09:30 检查报告');
  await page.getByRole('button', { name: '识别需求', exact: true }).click();
  await expect(page.getByLabel('执行时间', { exact: true })).toHaveValue('09:30');
  await page.getByLabel('执行时间', { exact: true }).fill('11:10');
  await page.getByRole('button', { name: '识别需求', exact: true }).click();
  await expect(page.getByLabel('执行时间', { exact: true })).toHaveValue('11:10');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/v2/tasks') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const task = await (await saved).json();
  await expect(page.getByRole('heading', { name: '每天 09:30 检查报告', exact: true })).toBeVisible();
  const state = await (await request.get('/api/automations')).json();
  expect(state.automations.find((rule: {taskId:string}) => rule.taskId === task.id)).toMatchObject({ enabled: false, schedule: { kind: 'daily', time: '11:10' } });
  expect((await (await request.get('/api/v2/tasks/' + task.id)).json()).runs).toHaveLength(0);
});

async function executionFixture(request: import('@playwright/test').APIRequestContext, suffix: string) {
 const {config,revision} = await (await request.get('/api/config')).json();
 const {directory} = await (await request.post('/__test__/execution-directory')).json();
 const agentId = 'execution-agent-' + suffix, projectId = 'execution-project-' + suffix;
 expect((await request.put('/api/config', {data:{revision,config:{...config,runtimes:['codex'],agents:[...config.agents,{id:agentId,name:'Execution '+suffix,defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}],projects:[...config.projects,{id:projectId,name:'Execution '+suffix,cwd:directory,agentIds:[agentId],resources:[],mcp:[],skills:[]}]}}})).ok()).toBe(true);
 return {agentId,projectId};
}

test('starting in a busy existing conversation queues a separate run; linking alone is idle', async ({page,request}) => {
 const binding = await executionFixture(request,'queue');
 const chat = await (await request.post('/api/conversations',{data:binding})).json();
 await request.patch('/api/conversations/'+chat.id,{data:{title:'Existing execution discussion'}});
 const create = async (key:string) => (await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':key},data:{goal:'hold',projectId:binding.projectId,assigneeAgentId:binding.agentId}},[chat.id])).json();
 const first = await create('existing-first');
 await page.goto('/tasks/'+first.id);
 await page.locator('.task-execution-options > summary').click();await chooseOption(page,page.getByRole('combobox',{name:'执行会话',exact:true}),chat.id);
 expect((await (await request.get('/api/v2/tasks/'+first.id)).json()).runs).toHaveLength(0);
 await page.getByRole('button',{name:'开始任务',exact:true}).click();
 const detail = async(id:string) => (await request.get('/api/v2/tasks/'+id)).json();
 await expect.poll(async()=>(await detail(first.id)).runs.at(-1)?.state).toBe('running');
 const second = await create('existing-second');
 await page.goto('/tasks/'+second.id);
 await page.locator('.task-execution-options > summary').click();await chooseOption(page,page.getByRole('combobox',{name:'执行会话',exact:true}),chat.id);
 await page.getByRole('button',{name:'开始任务',exact:true}).click();
 await expect.poll(async()=>(await detail(second.id)).runs.at(-1)).toMatchObject({state:'queued',nativeTurnId:null,routing:{mode:'existing',executionConversationId:chat.id}});
 expect((await detail(first.id)).runs[0].state).toBe('running');
 await expect(page.locator('.task-run-record')).toContainText('排队中');
});

test('explicit file-integrity checks complete only after actual published delivery', async ({page,request}) => {
 const binding=await executionFixture(request,'integrity');
 await page.goto('/tasks?action=create');
  await page.getByRole('button',{name:'手动填写',exact:true}).click();
 await page.getByLabel('任务标题',{exact:true}).fill('hold');
 await chooseOption(page,page.getByRole('combobox',{name:'完成确认方式',exact:true}),'checks');
 await chooseOption(page,page.getByRole('combobox',{name:'任务项目',exact:true}),binding.projectId);
 await chooseOption(page,page.getByRole('form',{name:'新建任务',exact:true}).getByRole('combobox',{name:'执行智能体',exact:true}),binding.agentId);
 const saved=page.waitForResponse(response=>response.url().endsWith('/api/v2/tasks')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 const task=await(await saved).json();expect(task.acceptance).toBe('checks');expect(task.criteria[0].checkRef).toBe('artifact:integrity');
 await page.getByRole('button',{name:'开始任务',exact:true}).click();
 const detail=async()=>(await request.get('/api/v2/tasks/'+task.id)).json();
 await expect.poll(async()=>(await detail()).runs.at(-1)?.state).toBe('running');
 expect((await detail()).task.completion).toBeNull();
 expect((await request.post('/__test__/task-output',{data:{taskId:task.id}})).ok()).toBe(true);
 await expect.poll(async()=>(await detail()).task.state).toBe('completed');
 await page.locator('.task-properties-disclosure > summary').click();await page.locator('.task-run-history > summary').click();await expect(page.getByText('机器检查已通过',{exact:false})).toBeVisible();
 await expect(page.locator('.task-run-evidence')).toContainText('完成标准已核验');
 await expect(page.locator('.task-run-evidence')).toContainText('交付文件可读取且完整');
});

test('paused rule repairs bindings from an externally edited task before explicit enable', async ({page,request}) => {
 const original=await executionFixture(request,'rule-original'),current=await executionFixture(request,'rule-current');
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'repair-task'},data:{goal:'Repair schedule binding',projectId:original.projectId,assigneeAgentId:original.agentId}})).json();
 const rule=await(await request.post('/api/automations',{data:{taskId:task.id,name:'Repair schedule binding',instructions:task.goal,projectId:original.projectId,agentId:original.agentId,cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 expect((await request.patch('/api/automations/'+rule.id,{data:{expectedRevision:rule.revision,enabled:true}})).ok()).toBe(true);
 const before=(await(await request.get('/api/v2/tasks/'+task.id)).json()).task;
 expect((await request.patch('/api/v2/tasks/'+task.id,{headers:{'Idempotency-Key':'external-task-binding'},data:{expectedRevision:before.revision,projectId:current.projectId,assigneeAgentId:current.agentId}})).ok()).toBe(true);
 await page.goto('/tasks/'+task.id);
 await openTaskRule(page);await page.locator('.automation-plan').getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByRole('button',{name:'保存规则',exact:true}).click();
 const getRule=async()=> (await(await request.get('/api/automations')).json()).automations.find((item:{id:string})=>item.id===rule.id);
 await expect.poll(getRule).toMatchObject({projectId:current.projectId,agentId:current.agentId,enabled:false});
 await page.getByRole('button',{name:'启用定时规则',exact:true}).click();
 await expect.poll(getRule).toMatchObject({projectId:current.projectId,agentId:current.agentId,enabled:true});
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
});

test('opening a rule editor below the fold focuses and reveals its first editable control', async ({page,request}) => {
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'rule-editor-focus'},data:{goal:'Visible rule editor'}})).json();
 await page.setViewportSize({width:1280,height:720});
 await page.goto('/tasks/'+task.id);
 await openTaskRule(page);const open=page.getByRole('button',{name:'添加执行规则',exact:true});
 await open.click();
 const editor=page.getByRole('form',{name:'新建执行规则',exact:true}),first=editor.getByRole('combobox',{name:'执行端',exact:true});
 await expect(first).toBeFocused();
 await expect(first).toBeInViewport();
 await editor.getByRole('button',{name:'取消',exact:true}).click();
 await expect(open).toBeFocused();
});

test('manual natural-time recognition saves one goal with a disabled editable rule and no run', async ({page,request}) => {
 await page.goto('/tasks');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('任务标题',{exact:true}).fill('每天09:30检查报告');await page.getByRole('button',{name:'识别需求',exact:true}).click();await expect(page.getByRole('button',{name:'识别需求',exact:true})).toBeEnabled();
 const saved=page.waitForResponse(response=>response.url().endsWith('/api/v2/tasks')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 const task=await(await saved).json();
 await expect(page.getByRole('heading',{name:'每天09:30检查报告',exact:true})).toBeVisible();
 const state=await(await request.get('/api/automations')).json();
 expect(state.automations.filter((rule:{taskId:string})=>rule.taskId===task.id)).toHaveLength(1);
 expect(state.automations.find((rule:{taskId:string})=>rule.taskId===task.id)).toMatchObject({enabled:false,schedule:{kind:'daily',time:'09:30'}});
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
 await openTaskRule(page);await page.locator('.automation-plan').getByRole('button',{name:'编辑',exact:true}).click();
 await expect(page.getByRole('form',{name:'编辑执行规则',exact:true}).getByLabel('执行时间',{exact:true})).toHaveValue('09:30');
});

test('manual time-intent recognition still saves the original goal when recognition fails', async ({page,request}) => {
 let recognized=false;await page.route('**/api/v2/tasks/draft',route=>{recognized=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'recognition unavailable'})});});
 await page.goto('/tasks');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('任务标题',{exact:true}).fill('明天检查原始报告');await page.getByRole('button',{name:'识别需求',exact:true}).click();await expect(page.getByRole('button',{name:'识别需求',exact:true})).toBeEnabled();
 const saved=page.waitForResponse(response=>response.url().endsWith('/api/v2/tasks')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 const task=await(await saved).json();
 expect(recognized).toBe(true);expect(task.goal).toBe('明天检查原始报告');
 await expect(page.getByRole('heading',{name:'明天检查原始报告',exact:true})).toBeVisible();
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
 expect((await(await request.get('/api/automations')).json()).automations.filter((rule:{taskId:string})=>rule.taskId===task.id)).toHaveLength(0);
});

for(const lost of ['task','rule'])test(`manual schedule retry after a lost ${lost} response does not duplicate its goal or rule`,async({page,request})=>{
 let aborted=false,recognitions=0;
 await page.route('**/api/v2/tasks/draft',async route=>{recognitions++;await route.continue();});
 await page.route(lost==='task'?'**/api/v2/tasks':'**/api/automations',async route=>{if(route.request().method()!=='POST'||aborted)return route.continue();aborted=true;await route.fetch();await route.abort('failed');});
 const goal='每天09:30检查报告 '+lost+' response';
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('任务标题',{exact:true}).fill(goal);await page.getByRole('button',{name:'识别需求',exact:true}).click();await expect(page.getByRole('button',{name:'识别需求',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:goal,exact:true})).toBeVisible();
 const tasks=(await(await request.get('/api/v2/tasks')).json()).filter((task:{goal:string})=>task.goal===goal);
 expect(tasks).toHaveLength(1);expect(recognitions).toBe(1);
 const rules=(await(await request.get('/api/automations')).json()).automations.filter((rule:{taskId:string})=>rule.taskId===tasks[0].id);
 expect(rules).toHaveLength(1);expect(rules[0].enabled).toBe(false);
 expect((await(await request.get('/api/v2/tasks/'+tasks[0].id)).json()).runs).toHaveLength(0);
});

test('saving task bindings refreshes its rule revision before immediate schedule editing',async({page,request})=>{
 const binding=await executionFixture(request,'fresh-rule');
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'fresh-rule-task'},data:{goal:'Fresh rule revision'}})).json();
 const rule=await(await request.post('/api/automations',{data:{taskId:task.id,name:task.goal,instructions:task.goal,projectId:'',agentId:'',cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 await page.goto('/tasks/'+task.id);await openTaskRule(page);await expect(page.locator('.automation-plan')).toBeVisible();
 await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+100));
 await page.getByRole('button',{name:'编辑任务',exact:true}).click();
 const editor=page.getByRole('form',{name:'编辑任务',exact:true});
 await chooseOption(page,editor.getByRole('combobox',{name:'任务项目',exact:true}),binding.projectId);
 await chooseOption(page,editor.getByRole('combobox',{name:'执行智能体',exact:true}),binding.agentId);
 await editor.getByRole('button',{name:'保存任务',exact:true}).click();await expect(editor).toHaveCount(0);
 await openTaskRule(page);await page.locator('.automation-plan').getByRole('button',{name:'编辑',exact:true}).click();
 await page.getByRole('form',{name:'编辑执行规则',exact:true}).getByLabel('执行时间',{exact:true}).fill('10:15');
 await page.getByRole('button',{name:'保存规则',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/automations')).json()).automations.find((item:{id:string})=>item.id===rule.id)).toMatchObject({agentId:binding.agentId,projectId:binding.projectId,schedule:{time:'10:15'}});
 await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rule revision conflict explains the conflict and preserves unsaved schedule without overwriting',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'conflict-rule-task'},data:{goal:'Preserve rule draft'}})).json();
 const rule=await(await request.post('/api/automations',{data:{taskId:task.id,name:task.goal,instructions:task.goal,projectId:'',agentId:'',cli:'codex',enabled:false,schedule:{kind:'daily',time:'09:00',timeZone:'Asia/Singapore'}}})).json();
 await page.goto('/tasks/'+task.id);await openTaskRule(page);await page.locator('.automation-plan').getByRole('button',{name:'编辑',exact:true}).click();
 const editor=page.getByRole('form',{name:'编辑执行规则',exact:true});await editor.getByLabel('执行时间',{exact:true}).fill('10:15');
 await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+100));
 expect((await request.patch('/api/automations/'+rule.id,{data:{expectedRevision:rule.revision,schedule:{kind:'daily',time:'12:00',timeZone:'Asia/Singapore'}}})).ok()).toBe(true);
 await editor.getByRole('button',{name:'保存规则',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('规则已变化');
 await expect(editor.getByLabel('执行时间',{exact:true})).toHaveValue('10:15');
 expect((await(await request.get('/api/automations')).json()).automations.find((item:{id:string})=>item.id===rule.id).schedule.time).toBe('12:00');
 await editor.getByRole('button',{name:'取消',exact:true}).click();await openTaskRule(page);await page.locator('.automation-plan').getByRole('button',{name:'编辑',exact:true}).click();
 await expect(editor.getByLabel('执行时间',{exact:true})).toHaveValue('12:00');
});

test('a finished run awaiting review does not offer to stop a current execution',async({page,request})=>{
 const binding=await executionFixture(request,'review-stop');
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'review-stop-task'},data:{goal:'hold',projectId:binding.projectId,assigneeAgentId:binding.agentId}})).json();
 expect((await request.post('/api/v2/tasks/'+task.id+'/start',{headers:{'Idempotency-Key':'review-stop-start'},data:{expectedRevision:task.revision}})).ok()).toBe(true);
 const detail=async()=>(await request.get('/api/v2/tasks/'+task.id)).json();
 await expect.poll(async()=>(await detail()).runs[0]?.state).toBe('running');
 await page.goto('/tasks/'+task.id);await expect(page.getByRole('button',{name:'停止本次执行',exact:true})).toBeVisible();
 expect((await request.post('/__test__/task-output',{data:{taskId:task.id}})).ok()).toBe(true);
 await expect.poll(async()=>(await detail()).task.state).toBe('review');
 await expect(page.locator('.task-command-bar')).toContainText('待审阅');
 await expect(page.getByRole('button',{name:'停止本次执行',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认完成',exact:true})).toBeVisible();
});

test('content-denied control still stops a genuinely active run and hides stop after it ends',async({page,request})=>{
 const binding=await executionFixture(request,'denied-stop');
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'denied-stop-task'},data:{goal:'hold',projectId:binding.projectId,assigneeAgentId:binding.agentId}})).json();
 expect((await request.post('/api/v2/tasks/'+task.id+'/start',{headers:{'Idempotency-Key':'denied-stop-start'},data:{expectedRevision:task.revision}})).ok()).toBe(true);
 const control=async()=>(await request.get('/api/v2/tasks/'+task.id+'/control')).json();
 await expect.poll(async()=>(await control()).runs[0]?.state).toBe('running');
 await page.route('**/api/v2/tasks/'+task.id,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'forbidden'})}));
 await page.goto('/tasks/'+task.id);
 await expect(page.getByText('来源权限已变更，正文和交付物不可访问。仍可停止执行或取消目标。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'停止本次执行',exact:true}).click();
 await expect.poll(async()=>(await control()).runs[0]?.state).toBe('interrupted');
 await expect(page.getByRole('button',{name:'停止本次执行',exact:true})).toHaveCount(0);
});
