import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
const screenshots='.superpowers/sdd/2026-10-03-project-workspace-layout/screenshots';
mkdirSync(screenshots,{recursive:true});
async function fixture(request:APIRequestContext){
 const suffix=crypto.randomUUID(),agentId='layout-agent-'+suffix,projectId='layout-project-'+suffix,otherId='layout-other-'+suffix;
 const {config,revision}=await(await request.get('/api/config')).json();
 const agent={id:agentId,name:'Layout Agent',defaultCli:'codex',models:{},instructions:'Shared instructions',mcp:[],skills:[]};
 const project=(id:string,name:string)=>({id,name,cwd:'/tmp',background:'Review a fixed research report',agentIds:[agentId],resources:[],mcp:[],skills:[]});
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,agent],projects:[...config.projects,project(projectId,'Layout Project'),project(otherId,'Other Layout Project')]}}})).ok()).toBe(true);
 // A managed conversation directory keeps source and child executions independent.
 const source=await(await request.post('/api/conversations',{data:{projectId,agentId,workspaceId:null}})).json();
 expect((await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'fixture-delegate:'+agentId}})).ok()).toBe(true);
 const delegated=async()=>(await(await request.get('/api/v2/tasks?projectId='+projectId)).json()).filter((task:{creatorAgentId:string|null;goal:string})=>task.creatorAgentId===agentId&&task.goal==='hold');
 await expect.poll(async()=>(await delegated()).length).toBe(1);
 const task=(await delegated())[0];
 await expect.poll(async()=>{const run=(await(await request.get('/api/v2/tasks/'+task.id)).json()).runs[0];return run?.state==='running'&&!!run.nativeSessionId&&!!run.nativeTurnId;}).toBe(true);
 const current=(await(await request.get('/api/v2/tasks/'+task.id)).json()).task;expect(current.conversationIds).toHaveLength(1);
 expect((await request.post('/api/v2/tasks/'+task.id+'/executions',{headers:{'Idempotency-Key':'link-source-'+task.id},data:{expectedRevision:current.revision,conversationId:source.id}})).ok()).toBe(true);
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks?conversationId='+source.id)).json()).map((task:{id:string})=>task.id)).toEqual([task.id]);
 return {projectId,otherId,agentId,source,task};
}
async function acceptTask(request:APIRequestContext,taskId:string){
 const detail=()=>request.get('/api/v2/tasks/'+taskId).then(response=>response.json());
 await expect.poll(async()=>(await detail()).runs.at(-1)?.state).toBe('succeeded');
 const review=(await detail()).task;expect(review.state).toBe('review');expect(review.completion).toBeNull();
 const accepted=await request.post('/api/v2/tasks/'+taskId+'/accept',{data:{expectedRevision:review.revision}});expect(accepted.ok()).toBe(true);expect(await accepted.json()).toMatchObject({state:'completed',completion:{completedBy:'user'}});
}
test('project task opens a readable fixed native file and verified source task/chat',async({page,request})=>{
 const f=await fixture(request);
 const response=await request.post('/__test__/task-output',{data:{taskId:f.task.id}});expect(response.ok(),await response.text()).toBe(true);const output=await response.json();expect(output.version).toBeTruthy();
 for(const ownerId of [f.projectId,f.otherId])expect((await request.post('/api/v2/assets/'+output.asset.id+'/bindings',{data:{ownerType:'project',ownerId,versionPolicy:'pinned',versionId:output.version.id}})).ok()).toBe(true);
 const stage=await(await request.post('/api/v2/assets/uploads?name=later.md',{data:'Later HEAD content'})).json();
 const v2=await(await request.post('/api/v2/assets/'+output.asset.id+'/versions',{headers:{'Idempotency-Key':'layout-head-'+f.projectId},data:{expectedHeadVersionId:output.version.id,submissionId:stage.submissionId,provenance:{sourceVersions:[]}}})).json();expect(v2.ordinal).toBe(2);
 await page.goto('/projects/'+f.projectId+'/workbench');
 const primary=page.locator('.workspace-primary');await expect(primary.getByRole('heading',{name:'项目任务',exact:true})).toBeVisible();await expect(primary.getByRole('region',{name:'项目协作者',exact:true})).toContainText('Shared instructions');await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));await page.screenshot({path:screenshots+'/project-light.png',fullPage:true});await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));await page.screenshot({path:screenshots+'/project-dark.png',fullPage:true});
 await primary.locator('.task-row').click();await expect(page.locator('.workspace-primary')).toContainText('回执与交付');
 await page.getByRole('link',{name:/Task research report\s*v1/}).click();
 await expect(page).toHaveURL(new RegExp('version='+output.version.id));await expect(page.locator('.asset-content')).toContainText('Synthetic research report');await expect(page.locator('.asset-content')).not.toContainText('Later HEAD content');
 const inspector=page.locator('.workspace-inspector');await expect(inspector).toContainText('本地可用');await page.screenshot({path:screenshots+'/report-desktop.png',fullPage:true});await inspector.getByRole('link',{name:'来源任务',exact:true}).click();await expect(page).toHaveURL(new RegExp('/tasks/'+f.task.id));await page.getByRole('link',{name:'返回源对话',exact:true}).click();await expect(page).toHaveURL(new RegExp('conversation='+f.source.id));
 await page.goto('/assets?project='+f.projectId);await expect(page.locator('.asset-row-content')).toContainText('固定版本 v1');await expect(page.locator('.asset-row-content')).not.toContainText('v2');
 await page.goto('/projects/'+f.projectId+'/workbench');await page.getByRole('button',{name:'移除关联',exact:true}).click();await expect(page.getByText('尚无关联文件')).toBeVisible();
 await page.goto('/projects/'+f.otherId+'/workbench');await page.getByRole('link',{name:'Task research report',exact:true}).click();await expect(page.locator('.asset-content')).toContainText('Synthetic research report');expect((await request.get('/api/v2/assets/'+output.asset.id)).ok()).toBe(true);
});
test('long chat scrolls independently and a different topic sends while child is running',async({page,request})=>{
 const f=await fixture(request);await page.goto('/?conversation='+f.source.id+'&project='+f.projectId);
 const composer=page.getByRole('textbox',{name:'消息',exact:true});await expect(composer).toBeEnabled();await composer.fill('Long topic '+('A line of discussion\n'.repeat(90)));await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await page.locator('.conversation').evaluate(el=>{el.scrollTop=0;});await expect(composer).toBeInViewport();await composer.fill('Independent new topic');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('Independent new topic',{exact:true})).toBeVisible();expect((await(await request.get('/api/v2/tasks/'+f.task.id+'/control')).json()).runs[0].state).toBe('running');
});
test('390px inspector traps focus, closes with Escape and restores trigger',async({page,request})=>{
 const f=await fixture(request);await page.setViewportSize({width:390,height:844});await page.goto('/tasks/'+f.task.id);
 const trigger=page.getByRole('button',{name:'查看任务上下文',exact:true});await trigger.click();const panel=page.getByRole('dialog',{name:'任务上下文',exact:true});await expect(panel).toBeVisible();await page.screenshot({path:screenshots+'/task-mobile-inspector.png'});const close=panel.getByRole('button',{name:'收起信息',exact:true});await expect(close).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(close).not.toBeFocused();await page.keyboard.press('Tab');await expect(close).toBeFocused();await page.locator('.inspector-backdrop').click({position:{x:10,y:400}});await expect(panel).not.toBeVisible();await expect(trigger).toBeFocused();await trigger.click();await expect(panel).toBeVisible();await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();await expect(trigger).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('missing bytes or revoked content cannot offer download or actionable source feedback',async({page,request})=>{
 const f=await fixture(request);const output=await(await request.post('/__test__/task-output',{data:{taskId:f.task.id}})).json();
 await page.route('**/api/v2/assets/'+output.asset.id+'/versions/'+output.version.id,async route=>{const r=await route.fetch(),data=await r.json();await route.fulfill({json:{...data,downloads:data.downloads.map((d:any)=>({...d,availability:'missing'}))}});});
 await page.goto('/assets/'+output.asset.id+'?version='+output.version.id);await expect(page.locator('.workspace-inspector')).toContainText('内容缺失');await expect(page.getByRole('link',{name:'下载固定版本'})).toHaveCount(0);await expect(page.getByRole('button',{name:'提交版本反馈'})).toHaveCount(0);
 await page.unrouteAll();expect((await request.put('/api/v2/assets/'+output.asset.id+'/lifecycle',{data:{lifecycle:'retracted',expectedRevision:output.asset.revision}})).ok()).toBe(true);await page.reload();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'提交版本反馈'})).toHaveCount(0);await expect(page.getByRole('link',{name:'下载固定版本'})).toHaveCount(0);
});

test('verified current report feedback reopens its canonical Task with fixed version identity',async({page,request})=>{
 const f=await fixture(request),output=await(await request.post('/__test__/task-output',{data:{taskId:f.task.id}})).json();
 await acceptTask(request,f.task.id);
 await page.goto('/assets/'+output.asset.id+'?version='+output.version.id);await page.getByLabel('原因', {exact:true}).fill('Add the missing comparison');const posted=page.waitForRequest(r=>r.url().endsWith('/api/v2/tasks/'+f.task.id+'/reopen'));await page.getByRole('button',{name:'提交版本反馈',exact:true}).click();const feedbackRequest=await posted;expect(feedbackRequest.postDataJSON().expectedOutput).toEqual({assetId:output.asset.id,versionId:output.version.id,runId:output.version.provenance.runId});expect(feedbackRequest.postDataJSON().reason).toContain(output.version.id);expect(feedbackRequest.postDataJSON().reason).toContain('Add the missing comparison');await expect(page.getByRole('status')).toHaveText('已提交版本反馈');
 const result=await(await request.get('/api/v2/tasks/'+f.task.id)).json();expect(result.task.state).toBe('todo');
});

test('feedback preflight detects a newly published head and keeps old Task completed',async({page,request})=>{
 const f=await fixture(request),output=await(await request.post('/__test__/task-output',{data:{taskId:f.task.id}})).json();
 await acceptTask(request,f.task.id);
 await page.goto('/assets/'+output.asset.id+'?version='+output.version.id);await page.getByLabel('原因',{exact:true}).fill('Do not submit against old content');
 const stage=await(await request.post('/api/v2/assets/uploads?name=new-head.md',{data:'A newer document'})).json();
 const newer=await request.post('/api/v2/assets/'+output.asset.id+'/versions',{headers:{'Idempotency-Key':'later-head-'+f.projectId},data:{expectedHeadVersionId:output.version.id,submissionId:stage.submissionId,provenance:{sourceVersions:[]}}});expect(newer.ok()).toBe(true);
 await page.getByRole('button',{name:'提交版本反馈',exact:true}).click();await expect(page.getByRole('alert')).toContainText('当前版本来源未能验证');
 expect((await(await request.get('/api/v2/tasks/'+f.task.id)).json()).task.state).toBe('completed');
});
test('PDF asset uses a media preview and keeps a pinned download',async({page,request},testInfo)=>{
 await page.setContent('<h1>Fixed PDF preview</h1><p>Synthetic local report</p><div style="break-before:page"><h1>Second PDF page</h1></div>');const bytes=await page.pdf();
 const stage=await(await request.post('/api/v2/assets/uploads?name=sample.pdf',{data:bytes})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'binary-layout-'+crypto.randomUUID()},data:{kind:'file',title:'Binary report',submissionId:stage.submissionId}})).json();
 await page.goto('/assets/'+saved.asset.id+'?version='+saved.version.id);await expect(page.getByRole('img',{name:'PDF 预览'})).toBeVisible();await expect(page.locator('.asset-content')).toContainText('Fixed PDF preview');await expect(page.getByRole('link',{name:'下载固定版本',exact:true})).toBeVisible();await expect(page.locator('.asset-content')).not.toContainText('%PDF');
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.asset-content')).toContainText('Second PDF page');await page.getByRole('button',{name:'上一页',exact:true}).click();await expect(page.locator('.asset-content')).toContainText('Fixed PDF preview');
 await page.screenshot({path:testInfo.outputPath('pdf-preview.png'),fullPage:true});
});

test('pinned external reference preserves host boundary while downloaded copy has real local bytes',async({page,request})=>{
 const f=await fixture(request),text='A real staged local copy';
 const stage=await(await request.post('/api/v2/assets/uploads?name=host-reference.md',{data:text})).json();
 const output=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'external-'+f.projectId},data:{kind:'external_reference',title:'Host reference',submissionId:stage.submissionId}})).json();
 expect((await request.post('/api/v2/assets/'+output.asset.id+'/bindings',{data:{ownerType:'project',ownerId:f.projectId,versionPolicy:'pinned',versionId:output.version.id}})).ok()).toBe(true);
 await page.goto('/assets?project='+f.projectId);const row=page.locator('.asset-list article').filter({hasText:'Host reference'});await expect(row).toContainText('需要执行主机在线');await expect(row).not.toContainText('本地可用');
 const selected=await(await request.get('/api/v2/assets/'+output.asset.id+'/versions/'+output.version.id)).json();expect(selected.downloads[0].availability).toBe('managed_local');expect(await(await request.get('/api/v2/assets/'+output.asset.id+'/versions/'+output.version.id+'/files/0')).text()).toBe(text);
});
