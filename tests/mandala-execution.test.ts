import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig,writeConfig,validateConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createSessionManager} from '../server/sessions';
import type {CodexClient,CodexOptions} from '../server/codex';
import {DomainError} from '../shared/workspace-contracts';
import {businessCliContext} from './business-cli-context';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();vi.unstubAllEnvs();});
const criteria=[{id:'ok',text:'Deliver answer',checkRef:null}];
async function setup(limit?:number, prepare?:()=>Promise<void>,stage:'resume'|'turn'='turn',skillOptions?:Parameters<typeof createSessionManager>[8]){
 const home=await mkdtemp(join(tmpdir(),'mandala-execution-')),store=openStore(home),first=await ensureConfiguredMandala(home);
 await writeConfig(home,{...first.config,agents:[...first.config.agents,{id:'worker',name:'Worker',instructions:'Execute',defaultCli:'codex',models:{},mcp:[],skills:[],...(limit?{maxParallel:limit}:{})}]},first.revision);
 const entries:{options:CodexOptions;token:string;native:string;turn:number;cwd:string;instructions:string;input:string;reloadError?:Error;closed?:boolean;onInterrupt?:()=>void}[]=[];
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{const entry:typeof entries[number]={options,token:'',native:'native-'+entries.length,turn:0,cwd:options.cwd,instructions:'',input:''};entries.push(entry);return {inspectContext:async()=>({settled:!entry.reloadError}),compactThread:async()=> 'completed',assertReloadable:async()=>{if(entry.reloadError)throw entry.reloadError;},getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{entry.instructions=p.instructions;entry.token=businessCliContext(p.instructions).token;return entry.native;},resumeThread:async(_id,_m,instructions)=>{if(stage==='resume')await prepare?.();entry.native=_id;entry.turn=Math.max(...entries.filter(e=>e!==entry&&e.native===_id).map(e=>e.turn),0);entry.instructions=instructions??'';entry.token=businessCliContext(instructions).token;},prepareTurn:stage==='turn'?prepare:undefined,startTurn:async(_id,text)=>{entry.input=text;return entry.native+'-turn-'+(++entry.turn);},interrupt:async()=>entry.onInterrupt?.(),replyApproval(){},close(){entry.closed=true;}};};
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home,undefined,undefined,undefined,skillOptions);
 cleanup.push(async()=>{await manager.close();store.close();await rm(home,{recursive:true,force:true});});
 const chat=ensureMandalaConversation(store,(await readConfig(home)).config);
 const finish=(entry=entries[0],status='completed')=>entry.options.onEvent({method:'turn/completed',params:{threadId:entry.native,turn:{id:entry.native+'-turn-'+entry.turn,status}}});
 const started=(entry=entries[0])=>entry.options.onEvent({method:'turn/started',params:{threadId:entry.native,turn:{id:entry.native+'-turn-'+entry.turn}}});
 return {home,store,manager,chat,entries,finish,started,factory};
}
it('waits for the interrupted Codex thread before sending the selected input once',async()=>{
 const {manager,store,chat,entries,finish,started}=await setup();
 const unrelated=await manager.create('','worker');
 await manager.send(chat.id,'Original turn');
 await manager.send(unrelated.id,'Unrelated work');
 const [previous,worker]=entries;
 started(previous);
 const older=manager.enqueueUserInput(chat.id,'Older draft','older');
 const executionId=manager.executionId(chat.id)!;
 previous.onInterrupt=()=>finish(previous,'interrupted');
 previous.reloadError=new DomainError('native_background_active',409,'Background still active');

 await expect(manager.interruptAndSend(chat.id,'Stale request','stale','stale-execution')).rejects.toMatchObject({code:'execution_changed'});
 expect(manager.listUserInputs(chat.id).map(input=>input.id)).toEqual([older.id]);
 expect(store.getConversation(chat.id)?.status).toBe('running');
 const selected=await manager.interruptAndSend(chat.id,'Send after the interrupt','selected',executionId);
 await expect(manager.interruptAndSend(chat.id,selected.text,'selected',executionId)).resolves.toMatchObject({id:selected.id,state:'queued'});
 await expect(manager.interruptAndSend(chat.id,'Other interruption','other',executionId)).rejects.toMatchObject({code:'conversation_busy'});
 expect(manager.listUserInputs(chat.id).find(input=>input.id===selected.id)).toMatchObject({state:'queued',waitingReason:'background'});
 expect(store.listEvents(chat.id,0).filter(event=>event.kind==='user')).toHaveLength(1);
 expect(previous.closed).toBeFalsy();
 expect(worker.closed).toBeFalsy();

 previous.reloadError=new DomainError('native_background_check_failed',409,'Background status unavailable');
 await new Promise(resolve=>setTimeout(resolve,1000));
 expect(entries).toHaveLength(2);
 previous.reloadError=undefined;
 await expect.poll(()=>entries.filter(entry=>entry.native===previous.native).at(-1)?.input,{timeout:4000}).toContain(selected.text);
 const resumed=entries.filter(entry=>entry.native===previous.native).at(-1)!;
 await expect(manager.interruptAndSend(chat.id,selected.text,'selected',executionId)).resolves.toMatchObject({id:selected.id,state:'running'});
 expect(resumed.turn).toBe(2);
 expect(store.listEvents(chat.id,0).filter(event=>event.kind==='user'&&(event.data as {queuedInputId?:string}).queuedInputId===selected.id)).toHaveLength(1);
 expect(manager.listUserInputs(chat.id).find(input=>input.id===older.id)?.state).toBe('queued');
 expect(store.getConversation(unrelated.id)?.status).toBe('running');
 expect(worker.closed).toBeFalsy();
 finish(resumed);
 finish(worker);
});
it('does not send a cancelled input when the interrupted thread becomes available',async()=>{
 const {manager,chat,entries,finish,started}=await setup();
 await manager.send(chat.id,'Original turn');
 const previous=entries[0],selected=manager.enqueueUserInput(chat.id,'Cancel before dispatch','cancel');
 started(previous);
 previous.onInterrupt=()=>finish(previous,'interrupted');
 previous.reloadError=new DomainError('native_background_active',409,'Background still active');
 await manager.sendQueuedInput(chat.id,selected.id,manager.executionId(chat.id));
 manager.cancelUserInput(selected.id);
 previous.reloadError=undefined;
 await new Promise(resolve=>setTimeout(resolve,1000));
 expect(manager.listUserInputs(chat.id).find(input=>input.id===selected.id)?.state).toBe('cancelled');
 expect(entries).toHaveLength(1);
 expect(previous.closed).toBeFalsy();
});
it('validates positive safe per-Agent limits and accepts legacy absence',async()=>{
 const {home}=await setup(),{config}=await readConfig(home);
 expect(()=>validateConfig(config)).not.toThrow();
 for(const maxParallel of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>validateConfig({...config,agents:config.agents.map(a=>a.id==='worker'?{...a,maxParallel}:a)})).toThrow();
});
it('queues racing direct sends at the per-Agent limit and releases the oldest pending work',async()=>{
 const {manager,store,entries,finish}=await setup(1);
 const chats=await Promise.all([1,2,3].map(()=>manager.create('','worker')));
 await Promise.all(chats.map(c=>manager.send(c.id,'Work')));
 expect(entries).toHaveLength(1);
 expect(store.database.prepare("SELECT id FROM task_user_inputs WHERE state='queued'").all()).toHaveLength(2);
 finish();await expect.poll(()=>entries.length).toBe(2);
 finish(entries[1]);await expect.poll(()=>entries.length).toBe(3);
});
it('defaults to three per-Agent background executions and excludes main conversation',async()=>{
 const {manager,chat,entries}=await setup();
 await manager.send(chat.id,'Coordinate');
 const chats=await Promise.all([1,2,3,4].map(()=>manager.create('','worker')));
 await Promise.all(chats.map(c=>manager.send(c.id,'Work')));
 expect(entries).toHaveLength(4);
});
it('merges notify receipts into a durable nonhuman main input without changing goal assignee',async()=>{
 const {manager,chat,entries,finish,store}=await setup();await manager.send(chat.id,'Coordinate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'child') as import('../shared/tasks').Run;
 await expect.poll(()=>entries.length).toBe(2);finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination')?.state).toBe('running');
 await expect.poll(()=>manager.taskService.listReceipts({userId:store.ownerUserId},run.taskId)[0].deliveryState).toBe('consumed');
 const input=manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination');expect(input?.state).toBe('running');
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user').at(-1)?.data).toMatchObject({source:{kind:'coordination'}});
 await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_configure',{change:{kind:'agent',action:'archive',id:'worker'},mode:'direct'},'deny')).rejects.toMatchObject({code:'human_request_required'});
 expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id).assigneeAgentId).toBeNull();
 const accepted=await manager.callBoundTool(entries.at(-1)!.token,'task_mark_completed',{taskId:goal.id,expectedRevision:manager.taskService.getTask({userId:store.ownerUserId},goal.id).revision},'accept');expect(accepted).toMatchObject({state:'completed',assigneeAgentId:null});
 expect(manager.taskService.listRuns({userId:store.ownerUserId},goal.id).some(run=>run.routing?.executionConversationId===chat.id)).toBe(false);
});
it.each(['ready','source-blocked','output-blocked','recovered'] as const)('reports the exact delegated delivery to Mandala once (%s)',async mode=>{
 const {manager,chat,entries,finish,store,home,factory}=await setup(),root={userId:store.ownerUserId};
 let active=manager;
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files');
 const files=createAssetFiles(home),assets=createAssets(store,files);
 const {createHttpServer}=await import('../server/http');
 const http=createHttpServer({requireIdentity:false,home,store,manager});
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 cleanup.push(async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));});
 const api='http://127.0.0.1:'+(http.address() as {port:number}).port+'/api';
 const source=(mode==='source-blocked'||mode==='recovered')?await (async()=>{
  await writeFile(join(home,'input.txt'),'Protected input');
  const stage=await files.stageFiles(root,null,[{allowedRoot:home,relativePath:'input.txt',manifestPath:'input.txt'}]);
  const item=assets.importAsset(root,{kind:'file',title:'Source',agentId:'worker',submissionId:stage.submissionId},'source');
  assets.bind(root,{ownerType:'agent',ownerId:'worker',assetId:item.asset.id,versionPolicy:'latest'});
  return item;
 })():null;
 await manager.send(chat.id,'Coordinate');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Review deployment',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'worker') as import('../shared/tasks').Run;
 await expect.poll(()=>entries.length).toBe(2);
 const outputRoot=join(home,'outputs',run.id);
 await writeFile(join(outputRoot,'report.txt'),'Deployment report with two findings');
 const output=await manager.callBoundTool(entries[1].token,'artifact_publish',{title:'Delivery',files:[{path:'report.txt'}]},'publish') as {asset:import('../shared/assets').Asset;version:import('../shared/assets').AssetVersion};
 const ref={assetId:output.asset.id,versionId:output.version.id};
 const restricted=mode==='output-blocked'?assets.setAccess(root,output.asset.id,{mode:'owner'},output.asset.revision):
  mode==='recovered'&&source?assets.setLifecycle(root,source.asset.id,'retracted',source.asset.revision):source?.asset;
 entries[1].options.onEvent({method:'item/completed',params:{threadId:entries[1].native,turnId:entries[1].native+'-turn-1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Two deployment findings'}}});
 finish(entries[1]);finish(entries[0]);
 const receipt=()=>active.taskService.listReceipts(root,goal.id)[0];
 if(restricted){
  const parked=()=>store.database.prepare('SELECT id,claim_error,created_at FROM task_receipts WHERE source_run_id=?').get(run.id);
  await expect.poll(()=>parked()?.claim_error).toBe('forbidden');
  expect(manager.listUserInputs(chat.id).filter(input=>input.source?.kind==='coordination')).toEqual([]);
  const results=await (await fetch(api+'/conversations/'+chat.id+'/results')).json();
  expect(results).toContainEqual(expect.objectContaining({id:parked()?.id,reportAccessBlocked:true}));
  const policy={mode:'selected' as const,agentIds:['worker',chat.agentId]};
  if(mode==='recovered'){
   // Older runtimes retained a link to a cancelled, provably unsubmitted automatic input.
   const oldId='legacy-retired-input',receiptId=parked()!.id as string;
   expect(results.find((item:{id:string})=>item.id===receiptId)).toMatchObject({summary:'',artifactCount:0});
   expect(results.find((item:{id:string})=>item.id===receiptId)).not.toHaveProperty('conversationId');
   store.transaction(()=>{
    store.database.prepare("INSERT INTO task_user_inputs(id,owner_user_id,conversation_id,text,command_key,state,created_at,source) VALUES (?,?,?,?,?,'cancelled',?,?)").run(oldId,root.userId,chat.id,'Old queued report','receipts:'+receiptId,parked()!.created_at,JSON.stringify({kind:'coordination',receiptIds:[receiptId]}));
    store.database.prepare('INSERT INTO task_receipt_inputs VALUES (?,?)').run(receiptId,oldId);
    store.enqueueOutbox({type:'task.receipt_input_recovered',aggregateId:oldId,aggregateRevision:1,causationId:oldId,payload:{inputId:oldId,retired:[{id:receiptId,reason:'forbidden'}]}});
   });
   await manager.close();
   const restored=assets.setLifecycle(root,restricted.id,'active',restricted.revision);
   assets.setAccess(root,restricted.id,policy,restored.revision);
   active=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);
   cleanup.push(()=>active.close());
   await active.reconcileRuns('local');
  }else{
   const grant=await fetch(api+'/v2/assets/'+restricted.id+'/access',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:restricted.revision,policy})});
   expect(grant.status).toBe(200);
  }
 }
 await expect.poll(()=>receipt()?.deliveryState,{timeout:4000}).toBe('consumed');
 const inputs=active.listUserInputs(chat.id).filter(input=>input.source?.kind==='coordination'&&input.state!=='cancelled');
 expect(inputs).toHaveLength(1);
 expect(inputs[0].source).toEqual({kind:'coordination',receiptIds:[receipt().id]});
 expect(inputs[0].text).toContain('Two deployment findings');
 expect(receipt().artifactVersions).toEqual([ref]);
 expect(active.taskService.listRuns(root,goal.id).map(item=>item.id)).toEqual([run.id]);
 await expect(active.callBoundTool(entries.at(-1)!.token,'artifact_read',{...ref,fileId:'0'},'read-delivery')).resolves.toMatchObject({text:'Deployment report with two findings'});
});

it('rebuilds revoked receipt history before reporting a different authorized delivery',async()=>{
 const {manager,chat,entries,finish,store,home}=await setup(),root={userId:store.ownerUserId};
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files');
 const assets=createAssets(store,createAssetFiles(home));
 await manager.send(chat.id,'Coordinate');
 const receipts: {taskId:string;asset:import('../shared/assets').Asset}[]=[];
 for(const label of ['OLD_FINDING','NEW_FINDING']){
  const token=entries[0].token,goal=await manager.callBoundTool(token,'mandala_create',{goal:label,criteria,projectId:null},'goal-'+label) as {id:string};
  const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:label,criteria},'delegate-'+label) as import('../shared/tasks').Run;
  const execution=()=>entries.find(entry=>entry.native===store.getConversation(run.routing!.executionConversationId)?.nativeId);
  await expect.poll(()=>execution()?.turn).toBe(1);
  const worker=execution()!;
  await writeFile(join(home,'outputs',run.id,'report.txt'),label);
  const output=await manager.callBoundTool(worker.token,'artifact_publish',{title:label,files:[{path:'report.txt'}]},'publish') as {asset:import('../shared/assets').Asset};
  const asset=label==='NEW_FINDING'?assets.setAccess(root,output.asset.id,{mode:'owner'},output.asset.revision):output.asset;
  receipts.push({taskId:goal.id,asset});
  worker.options.onEvent({method:'item/completed',params:{threadId:worker.native,turnId:worker.native+'-turn-1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:label}}});
  finish(worker);
 }
 finish(entries[0]);
 const receipt=(index:number)=>manager.taskService.listReceipts(root,receipts[index].taskId)[0];
 await expect.poll(()=>receipt(0)?.deliveryState).toBe('consumed');
 await expect.poll(()=>receipt(1)?.claimError).toBe('forbidden');
 finish(entries.at(-1));
 await expect.poll(()=>store.getConversation(chat.id)?.status).toBe('idle');
 assets.setAccess(root,receipts[0].asset.id,{mode:'owner'},receipts[0].asset.revision);
 assets.setAccess(root,receipts[1].asset.id,{mode:'selected',agentIds:['worker',chat.agentId]},receipts[1].asset.revision);
 manager.wakeBlockedReceiptReports();
 await expect.poll(()=>receipt(1)?.deliveryState).toBe('consumed');
 const response=entries.at(-1)!;
 expect(response.input).toContain('NEW_FINDING');
 expect(response.input+' '+response.instructions).not.toContain('OLD_FINDING');
 expect(store.listEvents(chat.id,0).some(event=>event.kind==='metadata'&&(event.data as {nativeContextReset?:unknown}).nativeContextReset)).toBe(true);
});

it('self work runs in an independent managed workspace while main remains responsive',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Coordinate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:chat.agentId,projectId:null,request:'Deliver',criteria},'self') as import('../shared/tasks').Run;
 await expect.poll(()=>entries.length).toBe(2);expect(entries[1].cwd).not.toBe(entries[0].cwd);expect(entries[1].cwd.startsWith(entries[0].cwd+'/')).toBe(false);
 expect(store.getConversation(run.routing!.executionConversationId)).toMatchObject({purpose:'mandala-background',projectId:'',agentId:chat.agentId});
});
it('aggregate limit counts owned work, keeps main responsive, and does not preempt when lowered',async()=>{
 const {manager,home,chat,entries,finish,store}=await setup();const {updateMandalaSettings}=await import('../server/config');
 const cfg=await readConfig(home);await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:1},cfg.revision);
 await manager.send(chat.id,'Coordinate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 for(let i=0;i<2;i++)await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:i?'worker':chat.agentId,projectId:null,request:'Work '+i,criteria},'child'+i);
 await expect.poll(()=>store.database.prepare("SELECT COUNT(*) n FROM task_runs WHERE state='running'").get()?.n).toBe(1);
 expect(entries).toHaveLength(2);finish(entries[1]);await expect.poll(()=>entries.length).toBe(3);
 expect(store.getConversation(chat.id)?.status).toBe('running');
});
it('stopping main preserves child work and parks delivery until genuine human continuation',async()=>{
 const {manager,chat,entries,finish,store}=await setup();await manager.send(chat.id,'Coordinate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'child') as import('../shared/tasks').Run;
 await expect.poll(()=>entries.length).toBe(2);
 const stopping=manager.stop(chat.id);entries[0].options.onEvent({method:'turn/completed',params:{threadId:entries[0].native,turn:{id:entries[0].native+'-turn-1',status:'interrupted'}}});await stopping;
 expect(manager.taskService.getRun({userId:store.ownerUserId},run.id).state).toBe('running');
 finish(entries[1]);await new Promise<void>(r=>setImmediate(r));
 expect(entries.reduce((n,e)=>n+e.turn,0)).toBe(2);
 expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id)).toMatchObject({state:'waiting',waitingReason:'delivery_missing',completion:null});
 await manager.continue(chat.id,'Review the result');finish(entries.filter(e=>e.native===store.getConversation(chat.id)!.nativeId).at(-1));
 await expect.poll(()=>manager.taskService.listReceipts({userId:store.ownerUserId},run.taskId)[0].deliveryState,{timeout:5000}).toBe('consumed');
});
it('cancels all executions of an owned task while leaving unrelated tasks unchanged',async()=>{
 const {manager,chat,entries,store}=await setup();await manager.send(chat.id,'Coordinate');const token=entries[0].token,root={userId:store.ownerUserId};
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const runs=[];for(let i=0;i<2;i++)runs.push(await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver'+i,criteria},'execution'+i) as import('../shared/tasks').Run);
 const unrelated=manager.taskService.createTask(root,{goal:'Unrelated',assigneeAgentId:'worker'},'unrelated');
 const cancelling=manager.stopDurableTask(goal.id,manager.taskService.getTask(root,goal.id).revision,true);
 for(const entry of entries.slice(1))entry.options.onEvent({method:'turn/completed',params:{threadId:entry.native,turn:{id:entry.native+'-turn-'+entry.turn,status:'interrupted'}}});
 await cancelling;expect(manager.taskService.getTask(root,goal.id).state).toBe('cancelled');
 for(const run of runs)expect(manager.taskService.getRun(root,run.id).state).toBe('interrupted');
 expect(manager.taskService.getTask(root,unrelated.id).state).toBe('todo');
});
it('system backgrounds use the configurable total rather than a hidden per-Agent three',async()=>{
 const {manager,home,chat,entries,store}=await setup(1);const {updateMandalaSettings}=await import('../server/config');const cfg=await readConfig(home);
 await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:4},cfg.revision);
 const backgrounds=await Promise.all([1,2,3,4].map(()=>manager.create('',chat.agentId)));
 await Promise.all(backgrounds.map(c=>manager.send(c.id,'Independent work')));expect(entries).toHaveLength(4);
 const workers=await Promise.all([1,2].map(()=>manager.create('','worker')));await Promise.all(workers.map(c=>manager.send(c.id,'Unrelated user work')));
 expect(entries).toHaveLength(5);expect(store.database.prepare("SELECT id FROM task_user_inputs WHERE state='queued'").all()).toHaveLength(1);
});
it('unknown native occupancy retains capacity after process recovery',async()=>{
 const {manager,home,store,factory}=await setup(1);const first=await manager.create('','worker');await manager.send(first.id,'Uncertain work');await manager.close();
 const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>recovered.close());
 await recovered.reconcileRuns('local');const next=await recovered.create('','worker');await recovered.send(next.id,'Wait for certainty');
 expect(store.getConversation(first.id)?.status).toBe('interrupted');
 expect(recovered.listUserInputs(next.id).some(input=>input.state==='queued')).toBe(true);
 expect(store.getConversation(next.id)?.status).toBe('idle');
});
it('takeover counts existing execution without preemption or reassignment',async()=>{
 const {manager,chat,home,store,entries}=await setup();const {updateMandalaSettings}=await import('../server/config'),cfg=await readConfig(home);await updateMandalaSettings(home,{name:'Mandala',soul:'',cli:'codex',maxParallel:1},cfg.revision);
 const root={userId:store.ownerUserId},existing=manager.taskService.createTask(root,{goal:'Existing',assigneeAgentId:'worker'},'existing');const active=await manager.startDurableTask(existing.id,existing.revision,'start');
 await expect.poll(()=>manager.taskService.getRun(root,active.id).state).toBe('running');await manager.send(chat.id,'Take over');
 const token=entries.at(-1)!.token;await manager.callBoundTool(token,'mandala_takeover',{taskId:existing.id,expectedRevision:manager.taskService.getTask(root,existing.id).revision,criteria},'take');
 const child=await manager.callBoundTool(token,'mandala_delegate',{taskId:existing.id,targetAgentId:chat.agentId,projectId:null,request:'Self work',criteria},'child') as import('../shared/tasks').Run;
 await new Promise<void>(r=>setImmediate(r));expect(manager.taskService.getRun(root,active.id).state).toBe('running');expect(manager.taskService.getRun(root,child.id).state).toBe('queued');expect(manager.taskService.getTask(root,existing.id).assigneeAgentId).toBe('worker');
});
it.each(['direct','queued'] as const)('revoked receipt history remains denied while safe %s human work continues',async mode=>{
 const {manager,chat,entries,finish,store,home,factory}=await setup();await manager.send(chat.id,'Coordinate');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'child') as import('../shared/tasks').Run;
 await expect.poll(()=>entries[1]?.turn).toBe(1);
 const {writeFile}=await import('node:fs/promises');await writeFile(join(home,'outputs',run.id,'result.txt'),'private result');
 const published=await manager.callBoundTool(entries[1].token,'artifact_publish',{title:'Output',files:[{path:'result.txt'}]},'publish') as {asset:{id:string}};
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files');const assets=createAssets(store,createAssetFiles(home)),root={userId:store.ownerUserId};
 assets.setAccess(root,published.asset.id,{mode:'selected',agentIds:['worker',chat.agentId]},assets.getAuthorizedAsset(root,published.asset.id).revision);
 finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>manager.taskService.listReceipts(root,run.taskId)[0]?.deliveryState).toBe('consumed');
 assets.setAccess(root,published.asset.id,{mode:'owner'},assets.getAuthorizedAsset(root,published.asset.id).revision);
 await expect(manager.callBoundTool(entries.at(-1)!.token,'conversation_history',{conversationId:chat.id},'history')).rejects.toMatchObject({status:403});
 store.appendEvent(chat.id,'text',{text:'DERIVED_PRIVATE_TEXT',itemId:'private-answer',phase:'final_answer'});
 const oldNative=store.getConversation(chat.id)!.nativeId,oldEvents=store.listEvents(chat.id,0).length;
 if(mode==='queued'){
  manager.enqueueUserInput(chat.id,'Start fresh with a public question','fresh-human');
  expect(store.getConversation(chat.id)!.nativeId).toBe(oldNative);
  expect(store.listEvents(chat.id,0).some(e=>(e.data as {nativeContextReset?:unknown}).nativeContextReset)).toBe(false);
  const previous=entries.at(-1)!;const {DomainError}=await import('../shared/workspace-contracts');
  previous.reloadError=new DomainError('native_background_active',409,'Background still active');finish(previous);
  await expect.poll(()=>store.listOutbox(0).some(e=>e.type==='task.execution_error'),{timeout:5000}).toBe(true);
  const queued=manager.listUserInputs(chat.id).find(i=>i.commandKey==='fresh-human')!;
  expect(queued.state).toBe('queued');expect(previous.closed).not.toBe(true);expect(store.getConversation(chat.id)!.nativeId).toBe(oldNative);
  previous.reloadError=undefined;
  await manager.sendQueuedInput(chat.id,queued.id);
  expect(entries.at(-1)!.turn).toBe(1);
 }else{
  const previous=entries.at(-1)!;finish(previous);
  const {DomainError}=await import('../shared/workspace-contracts');
  previous.reloadError=new DomainError('native_background_active',409,'Background still active');
  await expect(manager.send(chat.id,'Wait for background')).rejects.toMatchObject({code:'native_background_active'});
  expect(previous.closed).not.toBe(true);expect(store.getConversation(chat.id)!.nativeId).toBe(oldNative);
  previous.reloadError=undefined;
  store.database.prepare("INSERT INTO task_native_uncertainty VALUES ('input','uncertain-old',?)").run(chat.id);
  await expect(manager.send(chat.id,'Wait for certainty')).rejects.toMatchObject({code:'native_context_busy'});
  expect(store.database.prepare("SELECT claim_id FROM task_native_uncertainty WHERE claim_id='uncertain-old'").get()).toBeTruthy();
  expect(previous.closed).not.toBe(true);
  store.database.prepare("DELETE FROM task_native_uncertainty WHERE claim_id='uncertain-old'").run();
  await manager.send(chat.id,'Start fresh with a public question');
 }

 expect(store.getConversation(chat.id)!.nativeId).not.toBe(oldNative);
 expect(entries.at(-1)!.input).toBe('Start fresh with a public question');
 expect(entries.at(-1)!.instructions).not.toContain('private result');
 expect(entries.at(-1)!.instructions).not.toContain(published.asset.id);
 expect(store.listEvents(chat.id,0).length).toBeGreaterThan(oldEvents);
 expect(store.listEvents(chat.id,0).some(e=>e.kind==='metadata'&&(e.data as {nativeContextReset?:unknown}).nativeContextReset)).toBe(true);
 expect(manager.coordination.ownership(goal.id)?.conversationId).toBe(chat.id);
 await expect(manager.callBoundTool(entries.at(-1)!.token,'conversation_history',{conversationId:chat.id},'history-again')).rejects.toMatchObject({status:403});
 const {createMessageReference}=await import('../server/composer-references');
 const oldReply=store.listEvents(chat.id,0).find(e=>e.kind==='text'&&(e.data as {text?:string}).text==='DERIVED_PRIVATE_TEXT')!;
 await expect(createMessageReference({home,store,manager,config:(await readConfig(home)).config,principal:root,conversationId:chat.id},{sourceConversationId:chat.id,eventId:oldReply.id,text:'DERIVED_PRIVATE_TEXT'})).rejects.toMatchObject({status:403});

 finish(entries.at(-1));await manager.close();
 const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>recovered.close());
 // Restart resumes only the replacement native context.
 const replacement=store.getConversation(chat.id)!.nativeId;
 await recovered.send(chat.id,'Resume safe context');expect(entries.at(-1)!.native).toBe(replacement);finish(entries.at(-1));
 // A later runtime rebuild must honor the persisted cutoff, including after restart.
 store.updateConversation(chat.id,{nativeId:null,continuityPending:true});
 await recovered.send(chat.id,'Another public question');
 expect(entries.at(-1)!.input).not.toContain('DERIVED_PRIVATE_TEXT');
 expect(entries.at(-1)!.input).not.toContain('private result');
 expect(entries.at(-1)!.native).not.toBe(oldNative);finish(entries.at(-1));
 const {saveAttachment,loadAttachments}=await import('../server/attachments');
 const fresh=await saveAttachment(home,chat.id,'fresh.txt',Buffer.from('current authorized content'));
 await recovered.send(chat.id,'Use this new file',await loadAttachments(home,chat.id,[fresh.id]));
 expect(entries.at(-1)!.input).toContain('fresh.txt');
 expect(entries.at(-1)!.instructions).not.toContain(published.asset.id);
});
it('lowering an Agent limit preserves active work and delays new admission until below capacity',async()=>{
 const {manager,home,entries,finish,store}=await setup(2);const chats=await Promise.all([1,2,3].map(()=>manager.create('','worker')));
 await Promise.all(chats.slice(0,2).map(c=>manager.send(c.id,'Active')));
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,agents:cfg.config.agents.map(a=>a.id==='worker'?{...a,maxParallel:1}:a)},cfg.revision);
 await manager.send(chats[2].id,'Wait');expect(entries).toHaveLength(2);expect(chats.slice(0,2).every(c=>store.getConversation(c.id)?.status==='running')).toBe(true);
 finish(entries[0]);await new Promise<void>(resolve=>setImmediate(resolve));expect(manager.listUserInputs(chats[2].id)[0].state).toBe('queued');
 finish(entries[1]);await expect.poll(()=>entries.length).toBe(3);
});
it('background delegation reports to stable main, merges child receipts, and never starts a parent Run',async()=>{
 const {manager,chat,entries,store,finish}=await setup();await manager.send(chat.id,'Coordinate');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:chat.agentId,projectId:null,request:'Coordinate independent work',criteria},'self');
 await expect.poll(()=>entries[1]?.turn).toBe(1);
 const child=await manager.callBoundTool(entries[1].token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'nested') as import('../shared/tasks').Run;
 expect(child.continuation?.conversationId).toBe(chat.id);
 await expect.poll(()=>entries[2]?.turn).toBe(1);finish(entries[2]);finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>manager.taskService.listReceipts({userId:store.ownerUserId},child.taskId)[0]?.deliveryState,{timeout:5000}).toBe('consumed');
 const received=manager.listUserInputs(chat.id).find(input=>input.source?.kind==='coordination');expect(received?.source).toMatchObject({kind:'coordination',receiptIds:expect.arrayContaining([manager.taskService.listReceipts({userId:store.ownerUserId},child.taskId)[0].id])});
 expect(manager.taskService.listRuns({userId:store.ownerUserId},goal.id).some(run=>run.routing?.executionConversationId===chat.id)).toBe(false);
});

it.each(['resume','turn'] as const)('stopping an automatic receipt during %s preparation requeues the same claim behind pause',async stage=>{
 let blocked=false,entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const {manager,chat,entries,finish,store}=await setup(undefined,async()=>{if(blocked){entered=true;await gate;}},stage);
 await manager.send(chat.id,'Coordinate');const token=entries[0].token,root={userId:store.ownerUserId};
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'child') as import('../shared/tasks').Run;
 await expect.poll(()=>entries[1]?.turn).toBe(1);blocked=true;finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>entered).toBe(true);
 const input=manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination')!;
 expect(input.state).toBe('running');expect(await manager.stop(chat.id)).toBe(true);
 release();blocked=false;
 expect(manager.listUserInputs(chat.id).find(i=>i.id===input.id)?.state).toBe('queued');
 expect(manager.taskService.listReceipts(root,run.taskId)[0].deliveryState).not.toBe('consumed');
 await manager.continue(chat.id,'Please resume');finish(entries.at(-1));
 await expect.poll(()=>manager.taskService.listReceipts(root,run.taskId)[0].deliveryState,{timeout:5000}).toBe('consumed');
 expect(manager.listUserInputs(chat.id).filter(i=>i.source?.kind==='coordination')).toHaveLength(1);
});
it('replayed receipt after an earlier revocation reset remains tracked for a second revocation',async()=>{
 let blocked=false,entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const {manager,chat,entries,finish,store,home}=await setup(undefined,async()=>{if(blocked){entered=true;await gate;}});
 const root={userId:store.ownerUserId};await manager.send(chat.id,'Coordinate A and B');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Combined goal',criteria,projectId:null},'goal') as {id:string};
 const runs:import('../shared/tasks').Run[]=[];for(const label of ['A','B'])runs.push(await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver '+label,criteria},label) as import('../shared/tasks').Run);
 await expect.poll(()=>entries[2]?.turn).toBe(1);
 const {writeFile}=await import('node:fs/promises'),{createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files');
 const assets=createAssets(store,createAssetFiles(home)),assetIds:string[]=[];
 for(let i=0;i<2;i++){
  await writeFile(join(home,'outputs',runs[i].id,'result.txt'),'private receipt '+i);
  const published=await manager.callBoundTool(entries[i+1].token,'artifact_publish',{title:'Output '+i,files:[{path:'result.txt'}]},'publish') as {asset:{id:string}};
  assetIds.push(published.asset.id);assets.setAccess(root,published.asset.id,{mode:'selected',agentIds:['worker',chat.agentId]},assets.getAuthorizedAsset(root,published.asset.id).revision);
 }
 finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>manager.taskService.listReceipts(root,runs[0].taskId).find(receipt=>receipt.sourceRunId===runs[0].id)!?.deliveryState).toBe('consumed');
 const processingA=entries.at(-1)!;blocked=true;finish(entries[2]);finish(processingA);
 await expect.poll(()=>entered).toBe(true);
 const receiptB=manager.taskService.listReceipts(root,runs[1].taskId).find(receipt=>receipt.sourceRunId===runs[1].id)!;
 const inputB=manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination'&&i.source.receiptIds.includes(receiptB.id))!;
 const originalB=store.listEvents(chat.id,0).find(e=>e.kind==='user'&&(e.data as {queuedInputId?:string}).queuedInputId===inputB.id)!;
 expect(await manager.stop(chat.id)).toBe(true);blocked=false;release();
 expect(manager.listUserInputs(chat.id).find(i=>i.id===inputB.id)?.state).toBe('queued');
 assets.setAccess(root,assetIds[0],{mode:'owner'},assets.getAuthorizedAsset(root,assetIds[0]).revision);
 await manager.continue(chat.id,'Continue with current authorized context');
 const {mandalaContextBoundary}=await import('../server/mandala');
 const firstBoundary=mandalaContextBoundary(store,chat.id),firstReplacement=store.getConversation(chat.id)!.nativeId;
 expect(firstBoundary).toBeGreaterThan(originalB.id);finish(entries.at(-1));
 await expect.poll(()=>manager.taskService.listReceipts(root,runs[1].taskId).find(receipt=>receipt.sourceRunId===runs[1].id)!.deliveryState,{timeout:5000}).toBe('consumed');
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user'&&(e.data as {queuedInputId?:string}).queuedInputId===inputB.id)).toHaveLength(1);
 expect(store.listEvents(chat.id,firstBoundary).some(e=>e.kind==='metadata'&&(e.data as {receiptContext?:boolean;receiptIds?:string[]}).receiptContext&&(e.data as {receiptIds:string[]}).receiptIds.includes(receiptB.id))).toBe(true);
 await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_configure',{change:{kind:'agent',action:'archive',id:'worker'},mode:'direct'},'no-human-provenance')).rejects.toMatchObject({code:'human_request_required'});
 store.appendEvent(chat.id,'text',{text:'B_DERIVED_PRIVATE',itemId:'reply-B',phase:'final_answer'});finish(entries.at(-1));
 store.database.prepare("UPDATE events SET createdAt=? WHERE conversationId=? AND kind='user'").run(new Date(Date.now()-7*3600000).toISOString(),chat.id);
 await manager.maintainMandalaContext();
 expect(store.listEvents(chat.id,firstBoundary).some(e=>(e.data as any).contextMaintenance?.status==='completed')).toBe(true);
 expect(mandalaContextBoundary(store,chat.id)).toBe(firstBoundary);
 assets.setAccess(root,assetIds[1],{mode:'owner'},assets.getAuthorizedAsset(root,assetIds[1]).revision);
 await manager.send(chat.id,'A fresh public question');
 expect(store.getConversation(chat.id)!.nativeId).not.toBe(firstReplacement);
 expect(mandalaContextBoundary(store,chat.id)).toBeGreaterThan(firstBoundary);
 expect(entries.at(-1)!.input).toBe('A fresh public question');
 expect(entries.at(-1)!.instructions).not.toContain(assetIds[1]);
 await expect(manager.callBoundTool(entries.at(-1)!.token,'conversation_history',{conversationId:chat.id},'denied-old')).rejects.toMatchObject({status:403});
});

it('scheduled owned business goals use independent main backgrounds and stable receipts without rebinding the goal',async()=>{
 const {createAutomations}=await import('../server/automations');
 const {manager,chat,entries,finish,store,home}=await setup();
 await mkdir(join(home,'business'));const before=await readConfig(home);await writeConfig(home,{...before.config,projects:[{id:'business',name:'Business',cwd:join(home,'business'),agentIds:['worker'],resources:[],mcp:[],skills:[]}]},before.revision);
 await manager.send(chat.id,'Check this goal every five minutes');const token=entries[0].token;
 const goal=await manager.callBoundTool(token,'mandala_create',{goal:'Check state',criteria,projectId:'business'},'scheduled-goal') as {id:string};
 let now=new Date('2026-10-01T00:00:00Z');const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config,now:()=>now});cleanup.push(async()=>service.close());
 const body={goalId:goal.id,name:'Monitor',instructions:'Check state',projectId:'business',agentId:chat.agentId,cli:'codex',enabled:false,missedPolicy:'latest',overlapPolicy:'coalesce',schedule:{kind:'interval',minutes:5,anchor:now.toISOString()}};
 await expect(service.create({...body,taskId:goal.id})).rejects.toThrow('invalid automation binding');
 await expect(service.create({...body,conversationId:chat.id})).rejects.toThrow('invalid automation binding');
 const saved=await manager.callBoundTool(token,'automation_create',body,'schedule-owned') as import('../shared/automations').Automation;
 await manager.callBoundTool(token,'automation_update',{automationId:saved.id,expectedRevision:saved.revision,enabled:true},'enable-owned');
 now=new Date('2026-10-01T00:05:00Z');await service.tick();await expect.poll(()=>entries.length).toBe(2);
 const occurrence=(await service.list()).runs[0],run=manager.taskService.getRun({userId:store.ownerUserId},occurrence.runId!);
 expect(manager.taskService.getTask({userId:store.ownerUserId},goal.id)).toMatchObject({projectId:'business',assigneeAgentId:null});
 expect(manager.taskService.getTask({userId:store.ownerUserId},occurrence.taskId!)).toMatchObject({id:goal.id,projectId:'business'});
 expect(store.getConversation(run.routing!.executionConversationId)).toMatchObject({projectId:'business',purpose:'mandala-background'});
 expect(run.continuation).toMatchObject({taskId:goal.id,conversationId:chat.id,policy:'notify'});expect(entries[1].cwd).not.toBe(entries[0].cwd);
 await expect(manager.callBoundTool(entries[1].token,'automation_create',{...body,name:'Invented'},'invented')).rejects.toMatchObject({code:'human_request_required'});
 const current=(await service.list()).automations[0];await expect(manager.callBoundTool(entries[1].token,'automation_update',{automationId:current.id,expectedRevision:current.revision,schedule:{kind:'interval',minutes:1,anchor:now.toISOString()}},'expanded')).rejects.toMatchObject({code:'human_request_required'});
 finish(entries[1]);finish(entries[0]);await expect.poll(()=>manager.listUserInputs(chat.id).some(i=>i.source?.kind==='coordination')).toBe(true);
 const latest=manager.taskService.getTask({userId:store.ownerUserId},goal.id);await manager.stopDurableTask(goal.id,latest.revision,true);now=new Date('2026-10-01T00:10:00Z');await service.tick();expect((await service.list()).runs).toHaveLength(1);
});

it.each(['cancel','complete','epoch','access','artifact'] as const)('recovers the valid member of an unsubmitted receipt batch after %s changes during preparation',async change=>{
 let blocked=false,entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const {manager,chat,entries,finish,store,home}=await setup(undefined,async()=>{if(blocked){entered=true;await gate;}});
 const root={userId:store.ownerUserId};await manager.send(chat.id,'Coordinate two goals');
 const goals:string[]=[],runs:import('../shared/tasks').Run[]=[];
 for(const label of ['INVALID_MEMBER','VALID_MEMBER']){
  const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:label==='INVALID_MEMBER'?'Goal A':'Goal B',criteria,projectId:null},label) as {id:string};goals.push(goal.id);
  const child=manager.taskService.getTask(root,goal.id);
  runs.push(await manager.startDurableTask(child.id,child.revision,'start-'+label,undefined,{agentId:'worker',projectId:null,request:label,criteria,continuation:{taskId:goal.id,conversationId:chat.id,epoch:manager.taskService.getTask(root,goal.id).continuationEpoch,policy:'notify'},assertActive(){}}));
 }
 await expect.poll(()=>runs.every(run=>manager.taskService.getRun(root,run.id).state==='running')).toBe(true);
 const children=runs.map(run=>entries.find(entry=>entry.native===store.getConversation(run.routing!.executionConversationId)!.nativeId)!);
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files'),{writeFile}=await import('node:fs/promises');
 const assets=createAssets(store,createAssetFiles(home)),versions:{assetId:string;versionId:string}[]=[];
 if(change==='artifact')for(let i=0;i<2;i++){
  await writeFile(join(home,'outputs',runs[i].id,'report.txt'),'PRIVATE_ARTIFACT_'+i);
  const output=await manager.callBoundTool(children[i].token,'artifact_publish',{title:'PRIVATE_ARTIFACT_'+i,files:[{path:'report.txt'}]},'publish') as {asset:{id:string};version:{id:string}};
  assets.setAccess(root,output.asset.id,{mode:'selected',agentIds:['worker',chat.agentId]},assets.getAuthorizedAsset(root,output.asset.id).revision);versions.push({assetId:output.asset.id,versionId:output.version.id});
 }
 for(const entry of children){entry.options.onEvent({method:'item/agentMessage/delta',params:{threadId:entry.native,turnId:entry.native+'-turn-1',itemId:'answer',delta:entry===children[0]?'INVALID_MEMBER':'VALID_MEMBER'}});finish(entry);}
 blocked=true;finish(entries[0]);await expect.poll(()=>entered).toBe(true);
 const original=manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination')!;
 expect(original.source).toMatchObject({receiptIds:expect.any(Array)});expect(original.source!.kind==='coordination'&&original.source!.receiptIds).toHaveLength(2);
 const goal=manager.taskService.getTask(root,goals[0]);
 if(change==='cancel')await manager.stopDurableTask(goal.id,goal.revision,true);
 else if(change==='complete'||change==='epoch'){const review=manager.taskService.userCommand(root,goal.id,goal.revision,'complete'),done=manager.taskService.userCommand(root,goal.id,review.revision,'accept');if(change==='epoch')manager.taskService.userCommand(root,goal.id,done.revision,'reopen');}
 else if(change==='artifact')assets.setAccess(root,versions[0].assetId,{mode:'owner'},assets.getAuthorizedAsset(root,versions[0].assetId).revision);
 else {const task=manager.taskService.getTask(root,runs[0].taskId);store.database.prepare('UPDATE work_tasks SET creator_agent_id=? WHERE id=?').run('worker',task.id);manager.taskService.updateTask(root,task.id,task.revision,{participantAgentIds:[]},'revoke');}
 blocked=false;release();
 await expect.poll(()=>manager.taskService.listReceipts(root,runs[1].taskId).find(receipt=>receipt.sourceRunId===runs[1].id)!.deliveryState,{timeout:5000}).toBe('consumed');
 const good=manager.taskService.listReceipts(root,runs[1].taskId).find(receipt=>receipt.sourceRunId===runs[1].id)!,bad=manager.taskService.listReceipts(root,runs[0].taskId).find(receipt=>receipt.sourceRunId===runs[0].id)!;
 expect(bad.deliveryState).toBe('parked');
 const replacement=manager.listUserInputs(chat.id).find(i=>i.id!==original.id&&i.source?.kind==='coordination')!;
 expect(replacement.source).toEqual({kind:'coordination',receiptIds:[good.id]});expect(replacement.text).not.toContain('INVALID_MEMBER');
 expect(entries.at(-1)!.input).toContain('VALID_MEMBER');expect(entries.at(-1)!.input).not.toContain('INVALID_MEMBER');
 const retired=store.database.prepare("SELECT id,data,superseded FROM events WHERE conversationId=? AND kind='user' AND json_extract(data,'$.queuedInputId')=?").get(chat.id,original.id)!;
 expect(retired.superseded).toBe(1);expect(String(retired.data)).toContain('INVALID_MEMBER');
 const {createMessageReference}=await import('../server/composer-references');
 await expect(createMessageReference({home,store,manager,config:(await readConfig(home)).config,principal:root,conversationId:chat.id},{sourceConversationId:chat.id,eventId:Number(retired.id),text:'INVALID_MEMBER'})).rejects.toThrow();
 if(change==='artifact'){
  expect(entries.filter(e=>e.cwd===entries[0].cwd).every(e=>!e.instructions.includes('PRIVATE_ARTIFACT_0')&&!e.instructions.includes(versions[0].assetId))).toBe(true);
  const invocation=store.listEvents(chat.id,0).filter(e=>e.kind==='metadata'&&(e.data as any).receiptContext).at(-1)!.data as {invocationId:string};
  await writeFile(join(home,'outputs','conversations',chat.id,invocation.invocationId,'combined.txt'),'Good result');
  const output=await manager.callBoundTool(entries.at(-1)!.token,'artifact_publish',{title:'Combined',files:[{path:'combined.txt'}]},'combined') as {version:{provenance:{sourceVersions:unknown[]}}};
  expect(output.version.provenance.sourceVersions).toContainEqual(versions[1]);expect(output.version.provenance.sourceVersions).not.toContainEqual(versions[0]);
 }

 await expect(manager.callBoundTool(entries.at(-1)!.token,'mandala_configure',{change:{kind:'agent',action:'archive',id:'worker'},mode:'direct'},'nonhuman')).rejects.toMatchObject({code:'human_request_required'});
 finish(entries.at(-1));store.updateConversation(chat.id,{nativeId:null,continuityPending:true});await manager.send(chat.id,'A public follow-up');
 expect(entries.at(-1)!.input).not.toContain('INVALID_MEMBER');
 expect(manager.listUserInputs(chat.id).filter(i=>i.source?.kind==='coordination')).toHaveLength(2);
});

it('versionless receipt revocation denies Skill evidence before and after safe main reset',async()=>{
 const {assertSkillEvidence}=await import('../server/skill-evidence');
 const {manager,chat,entries,finish,store,home}=await setup(undefined,undefined,'turn',{wikiGenerate:async(_config,prompt)=>{
  const input=JSON.parse(prompt.split('INPUT_JSON:\n')[1]);return JSON.stringify(input.mode==='capture'?{outcomes:[{text:'PRIVATE_DERIVED',eventIds:input.events.filter((e:any)=>e.kind==='reply'||e.kind==='tool').map((e:any)=>e.id)}]}:{pages:[{id:'policy',title:'Policy',body:'PRIVATE_DERIVED',links:[],claims:input.sources.map((source:any)=>({key:'policy',text:source.text,sourceId:source.id,quote:source.text}))}]});
 }}),root={userId:store.ownerUserId};
 const {legacyWiki}=await import('./legacy-wiki-fixture'),wiki=manager.knowledgeBase;
 const base=await legacyWiki(home,store,wiki,{name:'Reports',purpose:'Reports',maintainerAgentId:chat.agentId,automatic:false,reception:{enabled:true,agentId:chat.agentId}});
 await manager.send(chat.id,'Coordinate');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Goal',criteria,projectId:null},'goal') as {id:string};
 const child=manager.taskService.getTask(root,goal.id);
 const run=await manager.startDurableTask(child.id,child.revision,'start',undefined,{agentId:'worker',projectId:null,request:'Private report',criteria,continuation:{taskId:goal.id,conversationId:chat.id,epoch:manager.taskService.getTask(root,goal.id).continuationEpoch,policy:'notify'},assertActive(){}});
 await expect.poll(()=>entries[1]?.turn).toBe(1);finish(entries[1]);finish(entries[0]);
 await expect.poll(()=>manager.taskService.listReceipts(root,run.taskId)[0].deliveryState).toBe('consumed');
 const event=store.appendEvent(chat.id,'text',{text:'PRIVATE_DERIVED',itemId:'answer',phase:'final_answer'}),source={conversationId:chat.id,agentId:chat.agentId,projectId:'',eventIds:[event.id],method:'dialogue' as const,verification:'draft' as const},reader={...root,agentId:chat.agentId},config=(await readConfig(home)).config;
 expect(()=>assertSkillEvidence(store,source,chat.agentId,reader,config)).not.toThrow();
 store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{type:'commandExecution',aggregatedOutput:'PRIVATE_DERIVED'}}});
 store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{type:'agentMessage',text:'PRIVATE_DERIVED',phase:'final_answer'}}});
 finish(entries.at(-1));await wiki.reconcile();await wiki.drain();await wiki.refresh(root,base.id);await wiki.drain();
 const wikiVersion=wiki.get(root,base.id).headVersionId!;expect(wiki.readPage(reader,base.id,'policy',wikiVersion).markdown).toContain('PRIVATE_DERIVED');

 store.database.prepare('UPDATE work_tasks SET creator_agent_id=? WHERE id=?').run('worker',child.id);
 const current=manager.taskService.getTask(root,child.id);manager.taskService.updateTask(root,child.id,current.revision,{participantAgentIds:[]},'revoke');
 expect(()=>manager.authorizeConversationReference(chat.id,chat.agentId)).toThrow();expect(()=>manager.authorizeConversationRead(chat.id)).not.toThrow();
 expect(()=>wiki.readPage(reader,base.id,'policy',wikiVersion)).toThrow();
 expect(()=>assertSkillEvidence(store,source,chat.agentId,reader,config)).toThrow();
 await manager.send(chat.id,'A public question');
 expect(entries.at(-1)!.input).toBe('A public question');expect(()=>assertSkillEvidence(store,source,chat.agentId,reader,config)).toThrow();
 expect(()=>wiki.readPage(reader,base.id,'policy',wikiVersion)).toThrow();expect(wiki.search(reader,base.id,'PRIVATE_DERIVED')).toEqual([]);
 // Root readers still cannot launder an Agent-owned source through Skill evidence.
 expect(()=>assertSkillEvidence(store,source,chat.agentId,root,config)).toThrow();
});

it('managed Codex restart inspection and continuity use the same connection and host permission policy as execution',async()=>{
 const {manager,chat,home,entries,finish,store,factory}=await setup();
 vi.stubEnv('MANAGED_TEST_ROUTE','fixture-route');const initial=await readConfig(home);await writeConfig(home,{...initial.config,runtimeDefaults:{codex:{args:['--profile','global-profile'],fullAccess:true,approvalMode:'auto',env:{ROUTE:'${MANAGED_TEST_ROUTE}'}}}},initial.revision);
 await manager.send(chat.id,'Coordinate');expect(entries[0].options).toMatchObject({extraArgs:[],fullAccess:false,env:{ROUTE:'fixture-route'}});finish(entries[0]);
 await manager.close();
 const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>recovered.close());
 store.database.prepare("UPDATE events SET createdAt=? WHERE conversationId=? AND kind='user'").run(new Date(Date.now()-7*3600000).toISOString(),chat.id);
 await recovered.maintainMandalaContext();
 expect(entries.length).toBeGreaterThan(1);expect(entries.slice(1).every(entry=>entry.options.extraArgs?.length===0&&entry.options.fullAccess===false&&entry.options.env?.ROUTE==='fixture-route')).toBe(true);
 await recovered.send(chat.id,'Resume');expect(entries.at(-1)!.options).toMatchObject({extraArgs:[],fullAccess:false,env:{ROUTE:'fixture-route'}});
});


it('executes ordinary system Project chats and self delegation without membership',async()=>{
 const {manager,home,chat,entries,store,finish}=await setup();
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,projects:[{id:'p',name:'Project',cwd:home,agentIds:['worker'],resources:[],mcp:[],skills:[]}]},cfg.revision);
 const ordinary=await manager.create('p',chat.agentId,'chosen-model');
 expect(ordinary).toMatchObject({projectId:'p',purpose:'mandala-background',model:'chosen-model',cwd:home});
 expect(manager.taskService.listTasks({userId:store.ownerUserId})).toEqual([]);
 await manager.send(ordinary.id,'Coordinate Project work');expect(entries[0].cwd).toBe(home);
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Project goal',criteria,projectId:'p'},'goal') as {id:string};
 const run=await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:chat.agentId,projectId:'p',request:'Self work',criteria},'self') as import('../shared/tasks').Run;
 finish(entries[0]);await expect.poll(()=>entries.length).toBe(2);expect(entries[1].cwd).toBe(home);
 expect(run.continuation?.conversationId).toBe(ordinary.id);
 expect((await readConfig(home)).config.projects[0].agentIds).toEqual(['worker']);
});
it('system task observation projects global state without task mutation or raw conversation authority',async()=>{
 const {manager,chat,entries,store}=await setup();const root={userId:store.ownerUserId};
 const foreign=manager.taskService.createTask(root,{goal:'Other Project work',projectId:'other',assigneeAgentId:'worker'},'foreign');
 const privateChat=await manager.create('','worker');store.appendEvent(privateChat.id,'text',{text:'PRIVATE HISTORY'});
 await manager.send(chat.id,'Observe');const token=entries[0].token;
 expect(await manager.callBoundTool(token,'task_list',{},'list')).toContainEqual(expect.objectContaining({id:foreign.id,goal:foreign.goal,readOnly:true}));
 const summary=await manager.callBoundTool(token,'task_read',{taskId:foreign.id},'read');expect(summary).toMatchObject({id:foreign.id,readOnly:true});expect(summary).not.toHaveProperty('completion');
 await expect(manager.callBoundTool(token,'task_update',{taskId:foreign.id,expectedRevision:1,goal:'steal'},'mutate')).rejects.toMatchObject({status:403});
 await expect(manager.callBoundTool(token,'task_start',{taskId:foreign.id,expectedRevision:1},'start')).rejects.toMatchObject({status:403});
 await expect(manager.callBoundTool(token,'task_cancel',{taskId:foreign.id,expectedRevision:1},'cancel')).rejects.toMatchObject({status:403});
 await expect(manager.callBoundTool(token,'conversation_read',{conversationId:privateChat.id},'history')).rejects.toMatchObject({status:403});
 await expect(manager.callBoundTool(token,'task_list',{agentId:chat.agentId},'forged')).rejects.toMatchObject({status:422});
 await manager.send(privateChat.id,'Observe');expect(await manager.callBoundTool(entries[1].token,'task_list',{},'ordinary')).toHaveLength(1);
 const unrelated=manager.taskService.createTask(root,{goal:'Unrelated',assigneeAgentId:'nobody'},'unrelated');
 await expect(manager.callBoundTool(entries[1].token,'task_read',{taskId:unrelated.id},'unrelated')).rejects.toMatchObject({status:403});
 expect(manager.taskService.getTask(root,foreign.id).participantAgentIds).toEqual([]);expect(manager.coordination.list()).toEqual([]);
});
it('rejects primary chat task association and execution even for its own assigned task',async()=>{
 const {manager,chat,store}=await setup();const root={userId:store.ownerUserId};
 const task=manager.taskService.createTask(root,{goal:'Own work',assigneeAgentId:chat.agentId},'own');
 expect(()=>manager.taskService.attachExecution(root,task.id,task.revision,chat.id,'attach')).toThrow('primary_conversation');
 await expect(manager.startDurableTask(task.id,task.revision,'start',chat.id)).rejects.toMatchObject({code:'primary_conversation'});
});

it('redacts protected global delivery summaries without changing file, detailed run or memory ACLs',async()=>{
 const {manager,chat,entries,store,home,finish}=await setup();const root={userId:store.ownerUserId};
 const task=manager.taskService.createTask(root,{goal:'Private delivery',assigneeAgentId:'worker'},'private');
 const run=await manager.startDurableTask(task.id,task.revision,'start');await expect.poll(()=>entries.length).toBe(1);
 const {writeFile}=await import('node:fs/promises');await writeFile(join(home,'outputs',run.id,'private.txt'),'PRIVATE BYTES');
 const output=await manager.callBoundTool(entries[0].token,'artifact_publish',{title:'Private',files:[{path:'private.txt'}]},'publish') as {asset:{id:string};version:{id:string}};
 const {createAssets}=await import('../server/assets'),{createAssetFiles}=await import('../server/asset-files');const assets=createAssets(store,createAssetFiles(home));
 assets.setAccess(root,output.asset.id,{mode:'owner'},assets.getAuthorizedAsset(root,output.asset.id).revision);
 // Frozen output and explicit report text, not raw native chat history.
 finish(entries[0]);await expect.poll(()=>manager.taskService.getRun(root,run.id).state).toBe('succeeded');
 store.database.prepare('UPDATE task_runs SET summary=? WHERE id=?').run('PRIVATE DELIVERY',run.id);
 store.database.prepare('UPDATE task_receipts SET summary=? WHERE source_run_id=?').run('PRIVATE RECEIPT',run.id);
 await manager.send(chat.id,'Observe');const token=entries[1].token;
 const observed=await manager.callBoundTool(token,'task_runs',{taskId:task.id},'runs') as Record<string,unknown>[];
 expect(observed[0]).toMatchObject({readOnly:true,id:run.id,state:'succeeded',summary:null,deliveries:[expect.objectContaining({summary:null})]});
 for(const field of ['contextSnapshotId','snapshot','nativeSessionId','nativeTurnId','routing','artifactVersions'])expect(observed[0]).not.toHaveProperty(field);
 expect(JSON.stringify(observed)).not.toContain('PRIVATE');expect(JSON.stringify(observed)).not.toContain(output.asset.id);
 expect(()=>manager.taskService.getRun({...root,agentId:chat.agentId},run.id)).toThrow(expect.objectContaining({status:403}));
 await expect(manager.callBoundTool(token,'artifact_read',{assetId:output.asset.id,versionId:output.version.id,fileId:'0'},'read-file')).rejects.toMatchObject({status:403});
 const {createMemoryStore}=await import('../server/memory-store');const memory=createMemoryStore(store,{assets,tasks:manager.taskService,localUserId:store.ownerUserId});
 const collection=memory.ensureCollection(root,{projectId:null,agentId:'worker'});
 expect(()=>memory.collection({...root,agentId:chat.agentId},collection.id)).toThrow(expect.objectContaining({status:403}));
});
it('ordinary coordinator reports return to ownership source after restart',async()=>{
 const {manager,chat,home,store,entries,finish,factory}=await setup();const root={userId:store.ownerUserId};
 const ordinary=await manager.create('',chat.agentId);await manager.send(ordinary.id,'Own this goal');
 const goal=await manager.callBoundTool(entries[0].token,'mandala_create',{goal:'Ordinary coordination',criteria,projectId:null},'goal') as {id:string};
 const run=await manager.callBoundTool(entries[0].token,'mandala_delegate',{taskId:goal.id,targetAgentId:'worker',projectId:null,request:'Deliver',criteria},'delegate') as import('../shared/tasks').Run;
 await expect.poll(()=>entries.length).toBe(2);finish(entries[0]);await expect.poll(()=>store.getConversation(ordinary.id)?.status).toBe('idle');
 finish(entries[1]);await expect.poll(()=>manager.taskService.listReceipts(root,run.taskId)[0]?.destinationConversationId).toBe(ordinary.id);
 // Park an existing delivery for restart without inventing a primary association.
 await manager.close();const receipt=manager.taskService.listReceipts(root,run.taskId)[0];
 store.database.prepare("UPDATE task_receipts SET delivery_state='pending',claimed_by_run_id=NULL WHERE id=?").run(receipt.id);
 store.database.prepare("DELETE FROM task_receipt_inputs WHERE receipt_id=?").run(receipt.id);
 store.database.prepare("UPDATE task_user_inputs SET state='completed' WHERE conversation_id=?").run(ordinary.id);
 store.updateConversation(ordinary.id,{status:'idle',turnId:null});
 const restarted=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);
 cleanup.push(()=>restarted.close());
 await restarted.reconcileRuns('local');
 await expect.poll(()=>restarted.listUserInputs(ordinary.id).some(input=>input.source?.kind==='coordination')).toBe(true);
 expect(restarted.listUserInputs(chat.id)).toEqual([]);expect(restarted.coordination.ownership(goal.id)?.conversationId).toBe(ordinary.id);
});

it('system Project askAgent executes without source membership and retains the Project directory',async()=>{
 const {manager,home,chat,entries,finish}=await setup();const cfg=await readConfig(home);
 await writeConfig(home,{...cfg.config,projects:[{id:'p',name:'Project',cwd:home,agentIds:['worker'],resources:[],mcp:[],skills:[]}]},cfg.revision);
 const ordinary=await manager.create('p',chat.agentId);await manager.send(ordinary.id,'Ask the worker');
 const message=await manager.askAgent(ordinary.id,{targetAgentId:'worker',text:'Confirm',policy:'notify'},{commandKey:'ask'});
 finish(entries[0]);await expect.poll(()=>entries.length).toBe(2);
 expect(entries[1].cwd).toBe(home);await expect.poll(()=>manager.getAgentMessage(message.id,chat.agentId).state).toBe('running');
 expect((await readConfig(home)).config.projects[0].agentIds).toEqual(['worker']);
});

it.each(['self','worker'])('standalone automation created in primary chat reports executor %s results once to the primary chat',async executor=>{
 const {createAutomations}=await import('../server/automations');
 const {manager,chat,entries,finish,store,home}=await setup();
 await manager.send(chat.id,'Create an independent scheduled check');
 const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});cleanup.push(async()=>service.close());
 const rule=await manager.callBoundTool(entries[0].token,'automation_create',{name:'Audit check',instructions:'Check the fixture',projectId:'',agentId:executor==='self'?chat.agentId:'worker',cli:'codex',enabled:false,executionMode:'independent',schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}},'audit-rule') as import('../shared/automations').Automation;
 expect(rule.createdByAgentId).toBe(chat.agentId);
 await expect(service.update(rule.id,{expectedRevision:rule.revision,reportConversationId:chat.id})).rejects.toThrow('invalid automation');
 const occurrence=await service.runNow(rule.id,'audit-run');await service.tick();await expect.poll(()=>entries.length).toBe(2);
 const child=entries[1];
 child.options.onEvent({method:'item/completed',params:{threadId:child.native,turnId:child.native+'-turn-'+child.turn,item:{id:'audit-answer',type:'agentMessage',phase:'final_answer',text:'Fixture result: two differences.'}}});
 finish(child);finish(entries[0]);
 await expect.poll(()=>manager.taskService.listReceipts({userId:store.ownerUserId},occurrence.taskId!).length).toBe(1);
 const run=manager.taskService.listRuns({userId:store.ownerUserId},occurrence.taskId!)[0];
 const receipt=manager.taskService.listReceipts({userId:store.ownerUserId},occurrence.taskId!)[0];
 expect(run.routing?.destinationConversationId).toBe(chat.id);expect(receipt.destinationConversationId).toBe(chat.id);
 expect(receipt.summary).toBe('Fixture result: two differences.');
 await expect.poll(()=>manager.listUserInputs(chat.id).filter(i=>i.source?.kind==='coordination').length).toBe(1);
 expect(rule.reportConversationId).toBe(chat.id);
 await expect.poll(()=>manager.listUserInputs(chat.id).find(i=>i.source?.kind==='coordination')?.state).toBe('running');
 await expect.poll(()=>entries.some(entry=>entry.input.includes('two differences'))).toBe(true);
 await service.tick();
 expect(manager.listUserInputs(chat.id).filter(i=>i.source?.kind==='coordination')).toHaveLength(1);
});

it.each(['ordinary','page'] as const)('preserves the %s automation report destination and never uses it as execution chat',async origin=>{
 const {createAutomations}=await import('../server/automations');
 const {manager,chat,entries,finish,store,home}=await setup();
 const source=origin==='ordinary'?await manager.create('',chat.agentId):chat;
 const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});cleanup.push(async()=>service.close());
 const body={name:'Report destination',instructions:'Check state',projectId:'',agentId:chat.agentId,cli:'codex',enabled:false,executionMode:'continuous',schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}};
 if(origin==='ordinary')await manager.send(source.id,'Schedule this work');
 const rule=(origin==='ordinary'?await manager.callBoundTool(entries[0].token,'automation_create',body,'destination-rule'):await service.create(body)) as import('../shared/automations').Automation;
 expect(rule.reportConversationId).toBe(source.id);
 const occurrence=await service.runNow(rule.id,'destination-run');await service.tick();await expect.poll(()=>entries.length).toBe(origin==='ordinary'?2:1);
 const run=manager.taskService.listRuns({userId:store.ownerUserId},occurrence.taskId!)[0];
 expect(run.routing?.destinationConversationId).toBe(source.id);expect(run.routing?.executionConversationId).not.toBe(source.id);
 finish(entries.at(-1));if(origin==='ordinary')finish(entries[0]);
 await expect.poll(()=>manager.listUserInputs(source.id).some(input=>input.source?.kind==='coordination'&&input.state==='running')).toBe(true);
 if(origin==='ordinary')expect(manager.listUserInputs(chat.id)).toEqual([]);
});

it('recovers an independent result after restart once, including a failed execution with no final answer',async()=>{
 const {createAutomations}=await import('../server/automations');
 const {manager,chat,entries,store,home,factory}=await setup();
 const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});cleanup.push(async()=>service.close());
 const rule=await service.create({name:'Failure report',instructions:'Check state',projectId:'',agentId:chat.agentId,cli:'codex',enabled:false,schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}});
 manager.coordination.pauseDelivery(chat.id);
 const occurrence=await service.runNow(rule.id,'failed-check');await service.tick();await expect.poll(()=>entries.length).toBe(1);
 const entry=entries[0];entry.options.onEvent({method:'turn/completed',params:{threadId:entry.native,turn:{id:entry.native+'-turn-'+entry.turn,status:'failed'}}});
 await expect.poll(()=>manager.taskService.listRuns({userId:store.ownerUserId},occurrence.taskId!)[0].state).toBe('failed');
 expect(manager.listUserInputs(chat.id)).toEqual([]);
 await manager.close();
 const recovered=createSessionManager(store,async()=>(await readConfig(home)).config,factory,undefined,home);cleanup.push(()=>recovered.close());
 recovered.coordination.resumeDelivery(chat.id);await recovered.reconcileRuns('local');
 await expect.poll(()=>recovered.listUserInputs(chat.id).some(input=>input.source?.kind==='coordination'&&input.state==='running')).toBe(true);
 await expect.poll(()=>entries.some(entry=>entry.input.includes('"state":"failed"'))).toBe(true);
 await recovered.reconcileRuns('local');expect(recovered.listUserInputs(chat.id).filter(input=>input.source?.kind==='coordination')).toHaveLength(1);
});

it.each(['independent','continuous'] as const)('manual retry preserves frozen %s report ownership after rule deletion',async executionMode=>{
 const {createAutomations}=await import('../server/automations');
 const {manager,chat,entries,finish,store,home}=await setup();
 const service=createAutomations({home,store,manager,loadConfig:async()=>(await readConfig(home)).config});cleanup.push(async()=>service.close());
 const rule=await service.create({name:'Retry report',instructions:'Check state',projectId:'',agentId:chat.agentId,cli:'codex',enabled:false,executionMode,schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}});
 manager.coordination.pauseDelivery(chat.id);
 const occurrence=await service.runNow(rule.id,'first-attempt');await service.tick();await expect.poll(()=>entries.length).toBe(1);
 const first=entries[0];first.options.onEvent({method:'turn/completed',params:{threadId:first.native,turn:{id:first.native+'-turn-'+first.turn,status:'failed'}}});
 await expect.poll(()=>manager.taskService.listRuns({userId:store.ownerUserId},occurrence.taskId!)[0].state).toBe('failed');
 await service.remove(rule.id,rule.revision);
 const task=manager.taskService.getTask({userId:store.ownerUserId},occurrence.taskId!);
 const retry=await manager.retryTask(task.id,task.revision,'explicit-retry');
 expect(retry.snapshot?.rule?.reportConversationId).toBe(chat.id);
 await expect.poll(()=>entries.some(entry=>entry.turn===2)||entries.length===2).toBe(true);
 manager.coordination.resumeDelivery(chat.id);finish(entries.at(-1));
 await expect.poll(()=>manager.listUserInputs(chat.id).some(input=>input.source?.kind==='coordination'&&input.state==='running')).toBe(true);
 await expect.poll(()=>manager.taskService.listReceipts({userId:store.ownerUserId},task.id).find(receipt=>receipt.sourceRunId===retry.id)?.deliveryState).toBe('consumed');
});
