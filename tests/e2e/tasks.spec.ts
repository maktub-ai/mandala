import { chooseOption } from "./helpers/select";
import { openArea } from './helpers/navigation';
import { expect,test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
async function openTaskProperties(page:Page){const summary=page.locator('.task-properties-disclosure > summary');if(await summary.locator('..').getAttribute('open')===null)await summary.click();}
const screenshots='/tmp/mandala-task-compat/audit/2026-10-20-rework/tasks';
async function openReferences(page:Page){
 // Reopen the chat's context popover so it reads the current references.
 const popover=page.getByRole('dialog',{name:'对话上下文',exact:true});if(await popover.isVisible())await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'对话上下文',exact:true}).click();await expect(popover).toBeVisible();return popover;
}
test('manual todo works without a project or Agent; mobile and English stay usable',async({page})=>{
 await page.goto('/?project=&agent=');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Keep this draft');
 await openArea(page,'任务');
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('任务标题',{exact:true}).fill('Renew library books');await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Renew library books'})).toBeVisible();await page.getByRole('button',{name:'提交验收',exact:true}).click();await expect(page.locator('.task-command-bar')).toContainText('待审阅');await page.getByRole('button',{name:'确认完成',exact:true}).click();await page.locator('.task-properties-disclosure > summary').click();await expect(page.getByText('用户已确认完成',{exact:false})).toBeVisible();
 mkdirSync(screenshots,{recursive:true});await page.screenshot({path:screenshots+'/tasks-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:screenshots+'/tasks-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.setViewportSize({width:1280,height:850});await openArea(page,'对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep this draft');
 await page.evaluate(()=>localStorage.setItem('mana-language','en'));await page.reload();await openArea(page,'Tasks');await expect(page.getByRole('heading',{name:'Tasks',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Renew library books',exact:false})).toBeVisible();await page.screenshot({path:screenshots+'/tasks-english.png',fullPage:true});
});
async function projectFixture(request:any,suffix:string,cwd='/tmp'){
 const {config,revision}=await(await request.get('/api/config')).json(),agentId='task-agent-'+suffix,projectId='task-project-'+suffix;
 const agent={id:agentId,name:'Research Agent '+suffix,defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]};
 const project={id:projectId,name:'Research Project '+suffix,cwd,agentIds:[agentId],resources:[],mcp:[],skills:[]};
 const saved=await request.put('/api/config',{data:{revision,config:{...config,runtimes:['codex','omp'],agents:[...config.agents,agent],projects:[...config.projects,project]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
 return {agentId,projectId};
}
async function linkSource(request:any,taskId:string,conversationId:string){
 const task=(await(await request.get('/api/v2/tasks/'+taskId)).json()).task;
 if(task.conversationIds.includes(conversationId))return;
 const response=await request.post('/api/v2/tasks/'+taskId+'/executions',{headers:{'Idempotency-Key':'explicit-link:'+taskId+':'+conversationId},data:{conversationId,expectedRevision:task.revision}});expect(response.ok(),await response.text()).toBe(true);
}
test('successful human-reviewed Run requires explicit changes before a new attempt',async({page,request})=>{
 const {directory}=await(await request.post('/__test__/execution-directory')).json();const {agentId,projectId}=await projectFixture(request,'continue-success',directory);
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'continue-success-create'},data:{goal:'hold',projectId,assigneeAgentId:agentId}})).json();
 const start=await request.post('/api/v2/tasks/'+task.id+'/start',{headers:{'Idempotency-Key':'continue-success-start'},data:{expectedRevision:task.revision}});expect(start.ok(),await start.text()).toBe(true);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id+'/control')).json()).runs.at(-1).state).toBe('running');
 await page.goto('/tasks/'+task.id);await expect(page.getByRole('heading',{name:'hold',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toHaveCount(0);
 const output=await request.post('/__test__/task-output',{data:{taskId:task.id}});expect(output.ok(),await output.text()).toBe(true);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id+'/control')).json()).runs.at(-1).state).toBe('succeeded');
 const first=(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs[0];
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).task.state).toBe('review');
 await page.getByRole('button',{name:'要求修改',exact:true}).click();await page.getByLabel('原因',{exact:true}).fill('Review requires a new attempt');await page.getByRole('button',{name:'保存并重新打开',exact:true}).click();
 await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toBeVisible();await page.getByRole('button',{name:'继续新尝试',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id+'/control')).json()).runs.at(-1).state).toBe('running');
 const continued=await(await request.get('/api/v2/tasks/'+task.id)).json();expect(continued.task.state).toBe('running');expect(continued.runs).toHaveLength(2);expect(continued.runs[0]).toMatchObject({id:first.id,state:'succeeded',attempt:1});expect(continued.runs[1]).toMatchObject({state:'running',attempt:2});expect(continued.runs[1].id).not.toBe(first.id);
 await page.getByRole('tab',{name:'交付',exact:true}).click();await expect(page.locator('.task-deliveries').getByRole('link',{name:/Task research report/})).toBeVisible();await page.getByRole('tab',{name:'动态',exact:true}).click();
 const records=page.locator('.task-run-record');await expect(records).toHaveCount(2);await expect(records.first()).toHaveAttribute('open','');await expect(records.last()).not.toHaveAttribute('open','');
 await page.getByRole('tab',{name:'动态',exact:true}).click();await page.locator('.task-run-history > summary').click();await records.last().locator(':scope > summary').click();await expect(records.last().getByRole('link',{name:'打开执行记录',exact:true})).toBeVisible();
 await page.screenshot({path:'/tmp/mandala-task-compat/audit/2026-10-20-rework/tasks/task-run-history.png',fullPage:true});
 await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toHaveCount(0);
});
test('latest unknown Run warns before explicit continuation with a fresh attempt',async({page,request})=>{
 const {directory}=await(await request.post('/__test__/execution-directory')).json();const {agentId,projectId}=await projectFixture(request,'continue-unknown',directory);
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'continue-unknown-create'},data:{goal:'hold',projectId,assigneeAgentId:agentId}})).json();
 const started=await request.post('/api/v2/tasks/'+task.id+'/start',{headers:{'Idempotency-Key':'continue-unknown-start'},data:{expectedRevision:task.revision}});expect(started.ok(),await started.text()).toBe(true);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id+'/control')).json()).runs.at(-1).state).toBe('running');
 const first=(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs[0];
 const uncertain=await request.post('/__test__/task-unknown',{data:{taskId:task.id}});expect(uncertain.ok(),await uncertain.text()).toBe(true);
 await page.goto('/tasks/'+task.id);await expect(page.getByRole('alert')).toContainText('继续会创建独立的新尝试');await expect(page.getByRole('alert')).toContainText('旧资源占用不会因此释放');
 await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toBeVisible();await page.getByRole('button',{name:'继续新尝试',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+task.id+'/control')).json()).runs.at(-1)).toMatchObject({state:'queued',attempt:2,waitingForDirectory:true});
 const continued=await(await request.get('/api/v2/tasks/'+task.id)).json();expect(continued.runs).toHaveLength(2);expect(continued.runs[0]).toMatchObject({id:first.id,state:'interrupted',attempt:1});expect(continued.runs[1]).toMatchObject({state:'queued',attempt:2,nativeSessionId:null});expect(continued.runs[1].id).not.toBe(first.id);expect(continued.runs[1].routing.executionConversationId).not.toBe(first.routing.executionConversationId);
 await expect(page.getByRole('button',{name:'继续新尝试',exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
});
test('manual creation can explicitly clear project scope and awaits explicit acceptance',async({page,request})=>{
 const {agentId,projectId}=await projectFixture(request,'independent');await page.goto('/tasks?project='+projectId+'&agent='+agentId);
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();await page.getByLabel('任务标题',{exact:true}).fill('Independent long-term objective');await chooseOption(page,'任务项目','');
 const savedResponse=page.waitForResponse(response=>response.url().endsWith('/api/v2/tasks')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'创建任务',exact:true}).click();const response=await savedResponse;expect(response.ok(),await response.text()).toBe(true);const task=await response.json();
 expect(task).toMatchObject({projectId:null,assigneeAgentId:null,participantAgentIds:[],conversationIds:[],criteria:[],acceptance:'human',state:'todo'});
 await page.getByRole('button',{name:'提交验收',exact:true}).click();await expect(page.locator('.task-command-bar')).toContainText('待审阅');
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).runs).toHaveLength(0);
 await page.getByRole('button',{name:'确认完成',exact:true}).click();await page.locator('.task-properties-disclosure > summary').click();await expect(page.getByText('用户已确认完成',{exact:false})).toBeVisible();
});
test('tasks edit criteria, participants, project and linked chats without hierarchy fields',async({page,request})=>{
 const {agentId,projectId}=await projectFixture(request,'editing');
 const {config,revision}=await(await request.get('/api/config')).json(),peerId='task-peer-editing';
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,{id:peerId,name:'Peer Agent editing',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]}}})).ok()).toBe(true);
 const chat=await(await request.post('/api/conversations',{data:{projectId,agentId}})).json();await request.patch('/api/conversations/'+chat.id,{data:{title:'Explicitly linked discussion'}});
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();const editor=page.getByRole('form',{name:'新建任务',exact:true});
 await editor.getByLabel('任务标题',{exact:true}).fill('Editable objective');await expect(editor.getByText('选填，有助于判断目标是否达成。',{exact:true})).toBeVisible();
 await editor.getByLabel('完成要求',{exact:true}).fill('A clear conclusion\nSources are available');
 await chooseOption(page,editor.getByRole('combobox',{name:'任务项目',exact:true}),projectId);
 await editor.locator('summary').filter({hasText:'参与者（选填）'}).click();await editor.getByRole('checkbox',{name:'Research Agent editing',exact:true}).check();await editor.getByRole('checkbox',{name:'Peer Agent editing',exact:true}).check();
 await chooseOption(page,editor.getByRole('combobox',{name:'执行智能体',exact:true}),agentId);
 await expect(editor.getByRole('combobox',{name:'父任务',exact:true})).toHaveCount(0);
 await expect(editor.getByRole('group',{name:'关联对话（选填）',exact:true})).toHaveCount(0);
 await expect(editor.getByRole('combobox',{name:'验收方式',exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:850});
 const savedResponse=page.waitForResponse(response=>response.url().endsWith('/api/v2/tasks')&&response.request().method()==='POST');
 await editor.getByRole('button',{name:'创建任务',exact:true}).click();const created=await(await savedResponse).json();
 expect(created).toMatchObject({projectId,participantAgentIds:[agentId,peerId],assigneeAgentId:agentId,conversationIds:[],acceptance:'human'});expect(created.criteria.map((item:any)=>item.text)).toEqual(['A clear conclusion','Sources are available']);
 await expect(page.getByRole('heading',{name:'Editable objective',exact:true})).toBeVisible();const reply=page.locator('.task-reply');await reply.getByRole('button',{name:'设为执行对话 / 新开执行对话',exact:true}).click();await chooseOption(page,reply.getByRole('combobox',{name:'已有对话',exact:true}),chat.id);await reply.getByRole('button',{name:'设为执行对话',exact:true}).click();await expect(reply.getByRole('combobox',{name:'目标对话',exact:true})).toHaveAttribute('data-value',chat.id);
 await page.getByRole('button',{name:'更多任务操作',exact:true}).click();await page.getByRole('menuitem',{name:'编辑任务',exact:true}).click();const edit=page.getByRole('form',{name:'编辑任务',exact:true});
 await edit.getByLabel('任务标题',{exact:true}).fill('Edited independent objective');await edit.getByLabel('完成要求',{exact:true}).fill('');
 await chooseOption(page,edit.getByRole('combobox',{name:'任务项目',exact:true}),'');await chooseOption(page,edit.getByRole('combobox',{name:'执行智能体',exact:true}),'');
 await edit.locator('summary').filter({hasText:'参与者（选填）'}).click();await edit.getByRole('checkbox',{name:'Peer Agent editing',exact:true}).uncheck();await edit.getByRole('button',{name:'保存任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Edited independent objective',exact:true})).toBeVisible();const updated=(await(await request.get('/api/v2/tasks/'+created.id)).json()).task;
 expect(updated).toMatchObject({projectId:null,criteria:[],assigneeAgentId:null,participantAgentIds:[agentId],conversationIds:[chat.id]});
 expect(updated.executions).toMatchObject([{conversationId:chat.id}]);
 await page.goto('/?conversation='+chat.id+'&project='+projectId);await expect(page.locator('.conversation-tasks')).toHaveCount(0);await openReferences(page);await expect(page.getByRole('dialog',{name:'对话上下文',exact:true}).getByRole('region',{name:'任务',exact:true})).toContainText('Edited independent objective');
 await page.goto('/tasks/'+created.id);await page.locator('.task-reply').getByRole('button',{name:'移除执行对话',exact:true}).click();
 await expect.poll(async()=>((await(await request.get('/api/v2/tasks/'+created.id)).json()).task.conversationIds)).toEqual([]);
 await page.goto('/?conversation='+chat.id+'&project='+projectId);await openReferences(page);await expect(page.getByRole('dialog',{name:'对话上下文',exact:true}).getByText('Edited independent objective',{exact:true})).toHaveCount(0);
});
test('task editor preserves its revision while polling and never overwrites an external edit',async({page,request})=>{
 const task=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'editor-conflict-create'},data:{goal:'Before external edit'}})).json();
 await page.goto('/tasks/'+task.id);await page.getByRole('button',{name:'编辑任务',exact:true}).click();const editor=page.getByRole('form',{name:'编辑任务',exact:true});await editor.getByLabel('任务标题',{exact:true}).fill('My pending edit');
 expect((await request.patch('/api/v2/tasks/'+task.id,{headers:{'Idempotency-Key':'editor-conflict-external'},data:{expectedRevision:task.revision,goal:'External edit'}})).ok()).toBe(true);
 await expect(page.getByRole('heading',{name:'External edit',exact:true})).toBeVisible();await expect(editor.getByLabel('任务标题',{exact:true})).toHaveValue('My pending edit');await editor.getByRole('button',{name:'保存任务',exact:true}).click();
 await expect(editor.getByRole('alert')).toContainText('任务已变化');expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).task.goal).toBe('External edit');
});
test('manual retry of task creation keeps criterion IDs and avoids duplicate goals after a lost response',async({page,request})=>{
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();const editor=page.getByRole('form',{name:'新建任务',exact:true});await editor.getByLabel('任务标题',{exact:true}).fill('Task with lost creation response');await editor.getByLabel('完成要求',{exact:true}).fill('A stable criterion');
 const requests:any[]=[];await page.route('**/api/v2/tasks',async route=>{
  if(route.request().method()!=='POST'){await route.continue();return;}
  requests.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
  if(requests.length===1){const saved=await route.fetch();expect(saved.ok()).toBe(true);await route.fulfill({status:503,json:{error:'Synthetic lost task response'}});}else await route.continue();
 });
 await editor.getByRole('button',{name:'创建任务',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('Synthetic lost task response');await editor.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Task with lost creation response',exact:true})).toBeVisible();expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect((await(await request.get('/api/v2/tasks')).json()).filter((task:any)=>task.goal==='Task with lost creation response')).toHaveLength(1);
});
test('existing chat delegates, continues a topic, receives actual fixed output, and preserves draft through task/project/assets',async({page,request})=>{
 const {agentId,projectId}=await projectFixture(request,'connected');
 await page.goto('/?project='+projectId+'&agent='+agentId+'&workspace=');await page.getByRole('textbox',{name:'消息',exact:true}).fill('fixture-delegate:'+agentId);await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await expect(page.getByRole('button',{name:'派发任务',exact:true})).toHaveCount(0);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks?projectId='+projectId)).json()).length).toBe(1);
 const tasks=await(await request.get('/api/v2/tasks?projectId='+projectId)).json();const taskId=tasks[0].id;expect(tasks[0].creatorAgentId).toBe(agentId);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+taskId+'/control')).json()).runs[0].state).toBe('running');
 const sourceId=new URL(page.url()).searchParams.get('conversation')!;const {conversation:source}=await(await request.get('/api/conversations/'+sourceId)).json();await linkSource(request,taskId,source.id);
 await openReferences(page);const card=page.getByRole('dialog',{name:'对话上下文',exact:true}).getByRole('region',{name:'任务',exact:true});const taskLink=card.locator('a[href="/tasks/'+taskId+'"]');await expect(taskLink).toContainText('hold');await expect(page.locator('.conversation-tasks')).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();await page.getByRole('textbox',{name:'消息',exact:true}).fill('A different topic');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByText('A different topic',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();
 const sourceUrl=page.url(),chats=await(await request.get('/api/conversations')).json();expect(chats.filter((c:any)=>c.projectId===projectId)).toHaveLength(1);
 const outputResponse=await request.post('/__test__/task-output',{data:{taskId}});expect(outputResponse.ok(),await outputResponse.text()).toBe(true);const output=await outputResponse.json();
 await expect(async()=>{const context=await openReferences(page);await expect(context.getByRole('button',{name:/Task research report/})).toBeVisible({timeout:1000});}).toPass();
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Keep connected journey draft');
 await taskLink.scrollIntoViewIfNeeded();await page.screenshot({path:screenshots+'/connected-chat.png',fullPage:true});
 await taskLink.click();await expect(page.getByRole('heading',{name:'回执与交付'})).toBeVisible();await page.screenshot({path:screenshots+'/connected-task.png',fullPage:true});
 await page.getByRole('tab',{name:'动态',exact:true}).click();await page.locator('.task-run-history > summary').click();await page.getByRole('link',{name:/Task research report\s*v1/}).click();await expect(page).toHaveURL(new RegExp('/assets/'+output.asset.id+'\\?version='+output.version.id));await expect(page.getByRole('heading',{name:'Task research report',exact:true})).toBeVisible();
 const download=await request.get('/api/v2/assets/'+output.asset.id+'/versions/'+output.version.id+'/files/0');expect(await download.text()).toBe('Synthetic research report\nSources checked in the fixture.\n');
 await page.getByRole('button',{name:'文件设置',exact:true}).click();await chooseOption(page, page.getByLabel('关联项目'), projectId);await page.getByRole('button',{name:'关联项目',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已关联项目');
 await openArea(page,'对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep connected journey draft');expect(page.url()).toBe(sourceUrl);
 await openReferences(page);await taskLink.click();await expect(page.locator('.task-deliveries')).toContainText('智能体输出');await page.screenshot({path:'/tmp/mandala-task-compat/superpowers/preview/task-delivery-workbench.png',fullPage:true});await openTaskProperties(page);await page.locator('main').getByRole('link',{name:'Research Project connected',exact:true}).click();await expect(page.getByRole('heading',{name:'项目任务',exact:true})).toBeVisible();await expect(page.locator('.task-row')).toHaveCount(1);await page.locator('.project-chat-row').filter({hasText:'fixture-delegate:'+agentId}).click();await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep connected journey draft');expect(page.url()).toBe(sourceUrl);await openReferences(page);await taskLink.click();await openTaskProperties(page);await page.locator('main').getByRole('link',{name:'Research Project connected',exact:true}).click();await page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'资料库',exact:true}).click();await page.getByRole('link',{name:'Task research report',exact:true}).click();await expect(page).toHaveURL(new RegExp('/library/'+output.asset.id));
 await openArea(page,'对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep connected journey draft');
 await openArea(page,'资产库');await expect(page.getByLabel('文件名称')).not.toBeVisible();await expect(page.locator('a[href="/library/'+output.asset.id+'"]')).toBeVisible();await page.screenshot({path:screenshots+'/assets-browse.png',fullPage:true});
 expect((await request.put('/api/v2/assets/'+output.asset.id+'/lifecycle',{data:{lifecycle:'retracted',expectedRevision:output.asset.revision}})).ok()).toBe(true);
 expect((await request.get('/api/v2/tasks/'+taskId)).status()).toBe(403);
 await page.goto(sourceUrl);await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeEnabled();await openReferences(page);await expect(taskLink).toBeVisible();
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Still usable after withdrawal');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('Still usable after withdrawal',{exact:true})).toBeVisible();

});
test('cancelling source collaboration wait preserves a late execution receipt without waking source work',async({page,request})=>{
 const {agentId,projectId}=await projectFixture(request,'late');
 // Managed per-conversation directories let source and child hold independently.
 const source=await(await request.post('/api/conversations',{data:{projectId,agentId,workspaceId:null}})).json();
 await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'Actual user goal'}});
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id)).json()).conversation.status).toBe('idle');
 const child=await(await request.post('/api/tasks',{data:{sourceConversationId:source.id,targetAgentId:agentId,request:'hold',policy:'resume',commandKey:'late-child'}})).json();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+child.id+'/control')).json()).runs[0].state).toBe('running');
 const detail=await(await request.get('/api/v2/tasks/'+child.id)).json(),taskId=detail.task.id;
 expect(detail.task.originConversationId).toBe(source.id);expect(detail.executions).toHaveLength(1);
 expect((await(await request.get('/api/tasks?view=control')).json()).find((task:{id:string})=>task.id===child.id)).toMatchObject({autoResume:true});
 await page.goto('/?project='+projectId+'&conversation='+source.id);await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'取消等待协作',exact:true})).toBeVisible();
 await linkSource(request,child.id,source.id);
 await page.getByRole('button',{name:'取消等待协作',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+taskId)).json()).task.futureAutoResume).toBe(false);
 expect((await(await request.get('/api/v2/tasks/'+taskId)).json()).runs[0].state).toBe('running');
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id)).json()).conversation.status).toBe('idle');
 expect((await request.post('/__test__/task-output',{data:{taskId:child.id}})).ok()).toBe(true);
 await page.goto('/?project='+projectId+'&conversation='+source.id);await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'取消等待协作',exact:true})).toHaveCount(0);await openReferences(page);await page.locator('#chat-environment-panel a[href="/tasks/'+child.id+'"]').click();await expect(page.locator('.task-receipt')).toContainText('已保留');await page.locator('.task-execution-process > summary').click();await page.locator('.task-run-history > summary').click();await expect(page.locator('.task-run-history').getByRole('link',{name:/Task research report\s*v1/})).toBeVisible();
 const stopped=await(await request.get('/api/v2/tasks/'+taskId)).json();expect(stopped.task.futureAutoResume).toBe(false);expect(stopped.runs).toHaveLength(1);
});

test('task opened from references stops only its own execution and keeps source work active',async({page,request})=>{
 // No shared project directory: each dedicated child and the source own their managed cwd.
 const {agentId,projectId}=await projectFixture(request,'card-stop');await page.goto('/?project='+projectId+'&agent='+agentId+'&workspace=');
 const composer=page.getByRole('textbox',{name:'消息',exact:true});
 await composer.fill('fixture-delegate:'+agentId);await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByTestId('chat-status')).toHaveText('就绪');const sourceId=new URL(page.url()).searchParams.get('conversation')!;
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks?projectId='+projectId)).json()).length).toBe(1);const task=(await(await request.get('/api/v2/tasks?projectId='+projectId)).json())[0],taskId=task.id;await linkSource(request,taskId,sourceId);
 // The other Task has its own execution Chat; one source cannot execute both Tasks.
 const other=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'hold',projectId,assigneeAgentId:agentId}})).json(),otherId=other.id;
 const started=await request.post('/api/v2/tasks/'+otherId+'/start',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:other.revision}});expect(started.ok(),await started.text()).toBe(true);await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+otherId+'/control')).json()).runs[0]?.state).toBe('running');
 await openReferences(page);const cards=page.getByRole('dialog',{name:'对话上下文',exact:true}).getByRole('region',{name:'任务',exact:true}).getByRole('link');await expect(cards).toHaveCount(1);await expect(cards.first()).toHaveAttribute('href','/tasks/'+taskId);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+taskId+'/control')).json()).runs[0].state).toBe('running');
 await composer.fill('hold');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByTestId('chat-status')).toHaveText('执行中');
 await cards.first().click();const first=page.locator('.task-detail');let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 await page.route('**/api/v2/tasks/'+taskId+'/stop',async route=>{entered();await gate;await route.continue();},{times:1});
 await first.getByRole('button',{name:'停止本次执行',exact:true}).click();await waiting;await expect(first.getByRole('button',{name:'停止本次执行',exact:true})).toBeDisabled();
 const stage=await(await request.post('/api/v2/assets/uploads?name=stop-plan.md',{data:'Additional current task context'})).json();
 const publication=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'stop-plan'},data:{kind:'document',title:'Stop race plan',submissionId:stage.submissionId}})).json();
 const adopted=await request.post('/api/v2/tasks/adopt-plan',{headers:{'Idempotency-Key':'stop-plan-adopt'},data:{plan:{assetId:publication.asset.id,versionId:publication.version.id},steps:[{key:'hold',taskId,goal:'hold',}]}});expect(adopted.ok(),await adopted.text()).toBe(true);
 release();await expect(first.getByRole('alert')).toContainText('任务已变化，已刷新');
 expect((await(await request.get('/api/v2/tasks/'+taskId+'/control')).json()).runs[0].state).toBe('running');
 await first.getByRole('button',{name:'停止本次执行',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+taskId+'/control')).json()).runs[0].state).toBe('interrupted');
 expect((await(await request.get('/api/v2/tasks/'+otherId+'/control')).json()).runs[0].state).toBe('running');await expect.poll(async()=>(await(await request.get('/api/conversations/'+sourceId)).json()).conversation.status).toBe('running');
 await expect(first.getByText('已停止',{exact:true}).first()).toBeVisible();await first.scrollIntoViewIfNeeded();await page.screenshot({path:screenshots+'/card-stop.png',fullPage:true});
});
