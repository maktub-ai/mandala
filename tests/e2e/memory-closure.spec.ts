import { test as isolatedTest } from './helpers/isolated-authority';
import { test, expect } from './helpers/execution-fixture';
import { chooseOption } from './helpers/select';
import { normalizeMemorySettings } from '../../server/memory-runtime';
test('automatic closure index opens completed source without reactivation; correction and withdrawal affect next context',async({page,request,executionDirectory})=>{
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],system:{cli:'codex'}}}});
 await page.goto('/?cwd='+encodeURIComponent(executionDirectory));await page.getByLabel('消息',{exact:true}).fill('请记住：以后用中文回答');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page).toHaveURL(/conversation=[^&]+/);await expect(page.getByText('Fixture reply: 请记住：以后用中文回答',{exact:true})).toBeVisible();await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 const id=new URL(page.url()).searchParams.get('conversation')!;
 // Closing during extraction is a separate scheduling scenario; this test starts from a published first turn.
 await expect.poll(async()=>(await(await request.get('/api/v2/memory/jobs')).json()).filter((job:any)=>job.conversationId===id).map((job:any)=>({state:job.state,error:job.error}))).toEqual([{state:'completed',error:null}]);
 expect((await request.post('/api/conversations/'+id+'/completion',{data:{completed:true}})).ok()).toBe(true);
 await page.goto('/mana?tab=memory&conversationId='+id);
 await expect.poll(async()=>(await(await request.get('/api/v2/memory/records?conversationId='+id)).json()).records.some((r:any)=>r.layer==='L3'&&r.status==='active'&&r.text.includes('以后用中文回答'))).toBe(true);
 const originalData=await(await request.get('/api/v2/memory/records?conversationId='+id)).json(),originalRecords=originalData.records;
 const original=originalRecords.find((r:any)=>r.layer==='L3'&&r.text.includes('以后用中文回答'));expect(original).toBeTruthy();
 const memory=page.locator('[data-record-id="'+original.recordId+'"]');await expect(memory).toContainText('以后用中文回答');await expect(page.getByRole('button',{name:'确认采用',exact:true})).toHaveCount(0);
 await memory.locator('.memory-sources > summary').click();const snippetIndex=Math.max(0,original.evidence.findIndex((ref:any)=>originalData.sources.find((source:any)=>source.id===ref.sourceId)?.conversationId===id));await memory.getByRole('button',{name:/^查看片段：/}).nth(snippetIndex).click();await page.getByRole('region',{name:'来源详情',exact:true}).getByRole('button',{name:'查看来源对话',exact:true}).click();await expect(page).toHaveURL(new RegExp('conversation='+id));
 expect((await(await request.get('/api/conversations/'+id)).json()).conversation.completedAt).toBeTruthy();await expect(page.getByRole('combobox',{name:'会话视图',exact:true})).toHaveText('最近对话');
 await page.getByLabel('消息',{exact:true}).fill('继续');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('Fixture reply: 继续',{exact:true})).toBeVisible();await expect(page.getByTestId('chat-status')).toHaveText('就绪');expect((await(await request.get('/api/conversations/'+id)).json()).conversation.completedAt).toBeNull();
 await expect.poll(async()=>(await(await request.get('/api/v2/memory/jobs')).json()).filter((job:any)=>job.conversationId===id).map((job:any)=>({state:job.state,error:job.error}))).toEqual([{state:'completed',error:null},{state:'completed',error:null}]);
 await page.goto('/mana?tab=memory&conversationId='+id);await memory.getByRole('button',{name:'纠正',exact:true}).click();await page.getByLabel('纠正内容',{exact:true}).fill('以后用英文回答');await page.getByRole('button',{name:'保存纠正',exact:true}).click();await expect(memory).toContainText('以后用英文回答');
 await memory.getByRole('button',{name:'撤回',exact:true}).click();await memory.getByRole('button',{name:'确认撤回',exact:true}).click();
 await page.locator('summary').filter({hasText:'高级筛选'}).click();await chooseOption(page,'状态','all');await expect(memory).toContainText('已撤回');
 const records=(await(await request.get('/api/v2/memory/records?conversationId='+id)).json()).records;expect(records.find((r:any)=>r.recordId===original.recordId).status).toBe('retracted');
});

isolatedTest('Task source and view-all navigation preserve a correction draft for mouse and keyboard',async({page,isolatedAuthority})=>{
 isolatedTest.setTimeout(30000);
 const {request,baseURL}=isolatedAuthority;
 // This authority has a new origin, so the main server's stored language does not apply.
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],system:{cli:'codex'}}}});
 const captureStartedAt=new Date().toISOString();
 const created=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'memory-lock-task'},data:{goal:'Synthetic task memory draft',criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null}});expect(created.ok()).toBe(true);const task=await created.json();expect((await request.post('/api/v2/tasks/'+task.id+'/complete',{data:{expectedRevision:task.revision}})).ok()).toBe(true);
 try { await expect.poll(async()=>(await(await request.get('/api/v2/memory/records?taskId='+task.id)).json()).records.filter((record:any)=>record.status==='active').length,{timeout:15000}).toBeGreaterThan(0); }
 catch(error) {
  try {
   const paths=['/api/config','/api/v2/memory/jobs','/api/v2/tasks/'+task.id];
   const readings=await Promise.allSettled(paths.map(async path=>{const response=await request.get(path,{timeout:2000});if(!response.ok())throw new Error('HTTP '+response.status());return response.json();}));
   const settings=readings[0].status==='fulfilled'?normalizeMemorySettings(readings[0].value.config):undefined,taskState=readings[2].status==='fulfilled'?readings[2].value.task:undefined;
   const allJobs=readings[1].status==='fulfilled'?readings[1].value:[],recent=allJobs.filter((job:any)=>job.createdAt>=captureStartedAt);
   const sourceIds=[...new Set<string>(recent.flatMap((job:any)=>job.sourceRefs.map((ref:any)=>ref.sourceId)))];
   const sources=await Promise.allSettled(sourceIds.map(async id=>{const response=await request.get('/api/v2/memory/sources/'+id,{timeout:2000});if(!response.ok())throw new Error('HTTP '+response.status());return response.json();}));
   const targetSources=sourceIds.filter((_id,index)=>sources[index].status==='fulfilled'&&sources[index].value.taskId===task.id);
   console.info('Task memory publication diagnostics',JSON.stringify({taskId:task.id,captureStartedAt,memory:settings,queue:Object.fromEntries(['pending','queued','running'].map(state=>[state,allJobs.filter((job:any)=>job.state===state).length])),taskState:taskState?.state,taskRevision:taskState?.revision,endpoints:readings.map((result,index)=>({path:paths[index],error:result.status==='rejected'?String(result.reason):null})),sources:sources.map((result,index)=>({id:sourceIds[index],taskId:result.status==='fulfilled'?result.value.taskId:undefined,status:result.status==='fulfilled'?result.value.status:undefined,revision:result.status==='fulfilled'?result.value.revision:undefined,error:result.status==='rejected'?String(result.reason):null})),jobs:recent,targetJobs:recent.filter((job:any)=>job.sourceRefs.some((ref:any)=>targetSources.includes(ref.sourceId))).map((job:any)=>({...job,ageMs:Date.now()-Date.parse(job.createdAt),queuedForMs:job.state==='queued'?Math.max(0,Date.now()-Date.parse(job.availableAt)):null,runningForMs:job.state==='running'&&job.leaseUntil?Math.max(0,Date.now()-(Date.parse(job.leaseUntil)-600000)):null}))}));
  } finally {throw error;}
 }
 await page.goto(baseURL+'/mana?tab=memory&taskId='+task.id);const taskHref='.memory-sources a[href="/tasks/'+task.id+'"]',memory=page.locator('.memory-records [data-record-id]').filter({has:page.locator(taskHref)}).first(),taskLink=memory.locator(taskHref);await expect(memory).toBeVisible();await memory.getByRole('button',{name:'纠正',exact:true}).click();const draft=page.getByLabel('纠正内容',{exact:true});await draft.fill('Unsaved task memory correction');
 const original=page.url();// While correcting, the card hides its sources; view-all stays guarded.
 for(const link of [page.getByRole('link',{name:'查看全部记忆',exact:true})]){
  // Force exercises the anchor's own click guard rather than Playwright's aria-disabled waiting.
  await link.click({force:true});await expect(page).toHaveURL(original);await expect(draft).toHaveValue('Unsaved task memory correction');await link.focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(original);await expect(draft).toHaveValue('Unsaved task memory correction');
 }
 await page.getByRole('button',{name:'取消',exact:true}).click();await memory.locator('.memory-sources > summary').click();await taskLink.click();await expect(page).toHaveURL(new RegExp('/tasks/'+task.id));
});


test('migrated candidates stay in read-only history and retired writes cannot reactivate them or change legacy bytes',async({page})=>{
 const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {openStore}=await import('../../server/store'),{readConfig}=await import('../../server/config'),{createMemoryRuntime}=await import('../../server/memory-runtime'),{createSessionManager}=await import('../../server/sessions'),{createHttpServer}=await import('../../server/http');
 const home=mkdtempSync(join(tmpdir(),'memory-legacy-ui-')),file=join(home,'knowledge.json');
 const bytes=JSON.stringify(['Edit candidate','Withdraw candidate'].map((title,index)=>({id:'legacy-ui-'+index,kind:'memory',title,content:'Synthetic retained candidate '+index,scope:'global',status:'candidate',level:'L2',createdAt:'2020-01-01',updatedAt:'2020-01-01'})),null,2)+'\n';writeFileSync(file,bytes);
 const store=openStore(home),config=(await readConfig(home)).config,runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,generate:async()=> '[]'});await runtime.initialize();
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home,undefined,undefined,runtime),server=createHttpServer({requireIdentity:false,home,store,manager,memoryRuntime:runtime});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 // Only redirect the memory API to an isolated real migrated authority; the product UI and HTTP handlers are unchanged.
 await page.route('**/api/v2/memory/**',async route=>{const response=await route.fetch({url:base+new URL(route.request().url()).pathname+new URL(route.request().url()).search,headers:{...route.request().headers(),origin:base}});await route.fulfill({response});});
 try{
  await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
  await page.goto('/mana?tab=memory');await page.locator('summary').filter({hasText:'高级筛选'}).click();await chooseOption(page,'状态','all');
  const root={userId:'local'},before=runtime.memory.listAll(root);
  expect(before).toHaveLength(2);expect(before.every(r=>r.status==='proposed'&&r.verification==='legacy_user_managed')).toBe(true);
  const retained=before.find(r=>r.legacyId==='legacy-ui-0')!,withdrawn=before.find(r=>r.legacyId==='legacy-ui-1')!;
  await expect(page.locator('.memory-records [data-record-id]')).toHaveCount(0);
  const history=page.locator('.memory-history');await history.locator(':scope > summary').click();
  for(const record of before){
   const card=history.locator('[data-record-id="'+record.recordId+'"]');
   await expect(card).toContainText('旧版候选');await expect(card).toContainText(record.text);
   await expect(card.getByRole('button',{name:/确认|纠正|撤回/})).toHaveCount(0);
  }
  expect(runtime.recall.summary(root,{projectId:null}).items).toEqual([]);
  for(const action of ['confirm','correct']){
   const response=await page.request.post(base+'/api/v2/memory/records/'+retained.recordId+'/'+action,{data:{expectedRevision:1,...action==='correct'?{text:'Forbidden candidate rewrite'}:{}}});
   expect(response.status()).toBe(410);expect(await response.json()).toMatchObject({error:'legacy_memory_confirmation_retired'});
   expect(runtime.memory.read(root,retained.recordId)).toEqual(retained);
  }
  const activation=await page.request.patch(base+'/api/knowledge/legacy-ui-0',{data:{status:'active'}});
  expect(activation.status()).toBe(410);expect(await activation.json()).toMatchObject({error:'Legacy candidates are retained in history'});
  expect(runtime.memory.listAll(root)).toEqual(before);
  expect((await page.request.post(base+'/api/v2/memory/records/'+withdrawn.recordId+'/retract',{data:{expectedRevision:1}})).ok()).toBe(true);
  const afterWithdrawal=runtime.memory.read(root,withdrawn.recordId);expect(afterWithdrawal).toMatchObject({status:'retracted',revision:2,text:withdrawn.text,verification:'legacy_user_managed'});
  const correction=await page.request.post(base+'/api/v2/memory/records/'+withdrawn.recordId+'/correct',{data:{expectedRevision:2,text:'Forbidden reactivation'}});
  expect(correction.status()).toBe(410);
  expect(()=>runtime.memory.restore(root,{recordId:withdrawn.recordId,expectedRevision:2})).toThrow('legacy_memory_confirmation_retired');
  expect((await page.request.patch(base+'/api/knowledge/legacy-ui-1',{data:{content:'Forbidden rewrite'}})).status()).toBe(410);
  expect(runtime.memory.read(root,withdrawn.recordId)).toEqual(afterWithdrawal);expect(runtime.memory.read(root,retained.recordId)).toEqual(retained);
  expect(runtime.recall.summary(root,{projectId:null}).items).toEqual([]);
  await page.goto('/mana?tab=memory&recordId='+retained.recordId);await page.reload();
  const retainedCard=page.locator('.memory-history [data-record-id="'+retained.recordId+'"]');
  await expect(retainedCard).toContainText(retained.text);await expect(retainedCard.getByRole('button',{name:/确认|纠正|撤回/})).toHaveCount(0);
  await expect(page.locator('.memory-records [data-record-id="'+retained.recordId+'"]')).toHaveCount(0);
  expect(readFileSync(file,'utf8')).toBe(bytes);expect(readFileSync(join(home,'memory-migration-backup','knowledge.json'),'utf8')).toBe(bytes);
 }finally{await page.unroute('**/api/v2/memory/**');await manager.close();await runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(home,{recursive:true,force:true});}
});
