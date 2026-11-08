import type {CodexClient} from '../server/codex';
import {createTasks} from '../server/tasks';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
let nativeForks=0,nativeFactories=0,nativeTurns=0;
let onFork=async()=>{};
let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>,url:string;
beforeEach(async()=>{nativeForks=0;nativeFactories=0;nativeTurns=0;onFork=async()=>{};home=mkdtempSync(join(tmpdir(),'task-http-'));store=openStore(home);manager=createSessionManager(store,async()=>({...((await readConfig(home)).config),agents:[{id:'a',name:'A',defaultCli:'codex' as const,models:{},instructions:'',mcp:[],skills:[]}]}),async()=>{nativeFactories++;return {forkThread:async()=>{nativeForks++;await onFork();return 'fork-'+nativeForks;},resumeThread:async()=>{},startTurn:async()=>{nativeTurns++;return 'new-turn';},close(){}} as unknown as CodexClient;},undefined,home);server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as {port:number}).port;});
afterEach(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});});
const request=(path:string,method='GET',data?:unknown,key='test')=>fetch(url+path,{method,headers:{'Content-Type':'application/json','Idempotency-Key':key},...(data===undefined?{}:{body:JSON.stringify(data)})});
const todo={goal:'Buy notebooks',criteria:[],acceptance:'delivery' as const,projectId:null,assigneeAgentId:null};
test('task list and detail expose execution conversations directly without hierarchy projections',async()=>{
 const saved=await request('/api/v2/tasks','POST',{goal:'One deliverable'},'flat-task');expect(saved.status).toBe(201);const task=await saved.json();
 const detail=await(await request('/api/v2/tasks/'+task.id)).json();
 expect(detail.executions).toEqual([]);expect(detail.task.executions).toEqual([]);
 expect(detail).not.toHaveProperty('children');expect(detail).not.toHaveProperty('dependencies');
 expect((await(await request('/api/v2/tasks')).json())[0].executions).toEqual([]);
});
test('saves a projectless manual todo; user review then acceptance completes with stale revision protection',async()=>{
 const saved=await request('/api/v2/tasks','POST',todo);expect(saved.status).toBe(201);const task=await saved.json();
 expect(task).toMatchObject({state:'todo',assigneeAgentId:null,projectId:null});
 expect(await (await request('/api/v2/tasks')).json()).toEqual([task]);
 const review=await request(`/api/v2/tasks/${task.id}/complete`,'POST',{expectedRevision:1});expect(review.status).toBe(200);
 expect(await review.json()).toMatchObject({state:'review',revision:2,completion:null});
 const accepted=await request(`/api/v2/tasks/${task.id}/accept`,'POST',{expectedRevision:2},'accept');expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:null}});
 expect((await request(`/api/v2/tasks/${task.id}/reopen`,'POST',{expectedRevision:1,reason:'More stationery'},'reopen')).status).toBe(409);
 expect((await request(`/api/v2/tasks/${task.id}/reopen`,'POST',{expectedRevision:3,reason:'More stationery'},'reopen')).status).toBe(200);
 expect((await request('/api/v2/tasks','POST',{...todo,ownerUserId:'forged'},'forged')).status).toBe(422);
 expect((await fetch(url+'/api/v2/tasks',{headers:{Origin:'https://foreign.example'}})).status).toBe(403);
});
test('adopts independent fixed plan steps once and rejects removed dependency fields',async()=>{
 const upload=await fetch(url+'/api/v2/assets/uploads?name=plan.md',{method:'POST',body:'Plan: collect then summarize'});const stage=await upload.json();
 const published=await(await request('/api/v2/assets/imports','POST',{kind:'document',title:'Plan',submissionId:stage.submissionId},'plan')).json();
 const plan={assetId:published.asset.id,versionId:published.version.id};const steps=[{key:'collect',taskId:null,goal:'Collect'},{key:'summarize',taskId:null,goal:'Summarize'}];
 const removed=await request('/api/v2/tasks/adopt-plan','POST',{plan,steps:[{...steps[0],dependsOn:['summarize']},steps[1]]},'removed');expect(removed.status).toBe(422);
 expect(await(await request('/api/v2/tasks')).json()).toEqual([]);
 const response=await request('/api/v2/tasks/adopt-plan','POST',{plan,steps},'adopt');expect(response.status).toBe(201);const adopted=await response.json();expect(adopted).toHaveLength(2);
 expect(await(await request('/api/v2/tasks/adopt-plan','POST',{plan,steps},'adopt')).json()).toEqual(adopted);
 expect(await(await request('/api/v2/tasks/adopt-plan','POST',{plan,steps},'again')).json()).toEqual(adopted);
 expect((await request('/api/v2/tasks/adopt-plan','POST',{plan,steps:[{...steps[0],goal:'Changed'}]},'changed')).status).toBe(409);
 const detail=await(await request('/api/v2/tasks/'+adopted[1].id)).json();expect(detail).not.toHaveProperty('dependencies');expect(detail.executions).toEqual([]);expect(detail.planVersions).toEqual([plan]);
});
test('manual review does not accept a legacy checks task; body-free stop still rejects stale revision',async()=>{
 const response=await request('/api/v2/tasks','POST',{...todo,acceptance:'checks',criteria:[{id:'test',text:'Verified tests',checkRef:'test'}]});expect(response.status).toBe(201);const task=await response.json();
 const review=await request(`/api/v2/tasks/${task.id}/complete`,'POST',{expectedRevision:1});expect(review.status).toBe(200);expect(await review.json()).toMatchObject({state:'review',completion:null});
 expect((await request(`/api/v2/tasks/${task.id}/stop`,'POST',{expectedRevision:1})).status).toBe(409);
 const stop=await request(`/api/v2/tasks/${task.id}/stop`,'POST',{expectedRevision:2});expect(stop.status).toBe(200);expect(await stop.json()).toEqual({taskId:task.id,status:'stopped',runId:null});
});

test('source withdrawal is denied access rather than missing bytes, while body-free Task stop remains available',async()=>{
 const upload=async(name:string,text:string)=>await(await fetch(url+'/api/v2/assets/uploads?name='+name,{method:'POST',body:text})).json();
 const stage=await upload('source.md','private source');
 const source=await(await request('/api/v2/assets/imports','POST',{kind:'document',title:'Source',submissionId:stage.submissionId},'source')).json();
 const asset=await(await request('/api/v2/assets','POST',{kind:'document',title:'Derived'},'asset')).json();
 const derivedStage=await upload('derived.md','derived secret');
 await request('/api/v2/assets/'+asset.id+'/versions','POST',{expectedHeadVersionId:null,submissionId:derivedStage.submissionId,provenance:{sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}]}},'derived');
 const p={userId:'local'},assets=createAssets(store,createAssetFiles(home));
 assets.setAccess(p,source.asset.id,{mode:'all'},source.asset.revision);
 const taskService=createTasks(store,{assets,resolve:()=>({agentId:'a',projectId:null,hostId:'local',input:'private source context',sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const target=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const task=taskService.createTask(p,{...todo,assigneeAgentId:'a'},'protected'),prepared=taskService.prepareStart(p,task.id,1,'protected-start');
 const run=store.transaction(()=>prepared.commit({executionConversationId:target.id,mode:'dedicated',destinationConversationId:null}));
 const stream=await request('/api/conversations/'+target.id+'/events'),reader=stream.body!.getReader();expect(stream.status).toBe(200);await reader.read();

 expect((await request('/api/v2/assets/'+source.asset.id+'/lifecycle','PUT',{lifecycle:'retracted',expectedRevision:source.asset.revision+1})).status).toBe(200);
 store.appendEvent(target.id,'text',{runId:run.id,text:'private body appended after withdrawal'});
 expect((await request('/api/conversations/'+target.id+'/events')).status).toBe(403);
 expect((await request('/api/conversations/'+target.id)).status).toBe(403);
 let streamed='';for(;;){const part=await reader.read();if(part.done)break;streamed+=new TextDecoder().decode(part.value);}expect(streamed).not.toContain('private body appended after withdrawal');
 const list=await(await request('/api/v2/assets')).json();expect(list.find((a:any)=>a.id===asset.id).availability).toBe('access_denied');
 expect((await request('/api/v2/assets/'+asset.id+'/versions')).status).toBe(403);
 expect((await request('/api/v2/tasks/'+task.id)).status).toBe(403);
 const control=await(await request('/api/v2/tasks/'+task.id+'/control')).json();expect(control.revision).toBe(2);expect(JSON.stringify(control)).not.toContain('private source context');
 const stop=await request('/api/v2/tasks/'+task.id+'/stop','POST',{expectedRevision:2});expect(stop.status).toBe(200);expect(await stop.json()).toEqual({taskId:task.id,status:'stopped',runId:run.id});
 expect((await request('/api/v2/tasks/'+task.id)).status).toBe(403);
 const legacy=await request('/api/tasks?view=control');expect(legacy.status).toBe(200);expect(JSON.stringify(await legacy.json())).not.toContain('private source context');
 const other=await request('/api/tasks');expect(other.status).toBe(200);expect(JSON.stringify(await other.json())).not.toContain('private source context');

});

async function protectedTranscript(kind:'source'|'output'='source',withSource=false){
 const upload=await fetch(url+'/api/v2/assets/uploads?name=protected.md',{method:'POST',body:'PROTECTED_SOURCE'}),stage=await upload.json();
 const published=await(await request('/api/v2/assets/imports','POST',{kind:'document',title:'Protected',submissionId:stage.submissionId},'protected')).json();
 const assets=createAssets(store,createAssetFiles(home)),p={userId:'local'};assets.setAccess(p,published.asset.id,{mode:'all'},published.asset.revision);
 const ref={assetId:published.asset.id,versionId:published.version.id};
 const tasks=createTasks(store,{assets,resolve:()=>({agentId:'a',projectId:null,hostId:'local',input:'PROTECTED_INPUT',sourceVersions:kind==='source'||withSource?[ref]:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});store.updateConversation(chat.id,{nativeId:'native-original'});
 const task=tasks.createTask(p,{...todo,assigneeAgentId:'a'},'protected-task'),prepared=tasks.prepareStart(p,task.id,1,'protected-start');
 const run=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));
 const identity={runId:run.id,hostId:'local',nativeSessionId:'native-original',nativeTurnId:'turn'};
 tasks.bindRunIdentity(identity);
 let withdrawn=assets.getAuthorizedAsset(p,published.asset.id),outputRef=ref;
 if(kind==='output'){
  const files=createAssetFiles(home),actor={...p,agentId:'a',runId:run.id};writeFileSync(join(home,'output.txt'),'WITHDRAWN_RESULT_BODY');
  const stage=await files.stageFiles(actor,run.id,[{allowedRoot:home,relativePath:'output.txt',manifestPath:'output.txt'}]);
  const output=assets.importAsset(actor,{kind:'file',title:'Protected output',agentId:'a',submissionId:stage.submissionId,sourceVersions:[]},'protected-output');withdrawn=output.asset;outputRef={assetId:output.asset.id,versionId:output.version.id};
 }
 tasks.applyRunEvent({...identity,eventKey:'terminal',outcome:'succeeded',summary:'WITHDRAWN_RESULT_BODY',artifactVersions:kind==='output'?[outputRef]:[]});
 expect(tasks.getTask(p,task.id)).toMatchObject({state:'review',completion:null});
 const review=tasks.userCommand(p,task.id,tasks.getTask(p,task.id).revision,'complete');tasks.userCommand(p,task.id,review.revision,'accept');
 store.appendEvent(chat.id,'user',{text:'Synthetic input',runId:run.id});store.appendEvent(chat.id,'text',{text:'WITHDRAWN_RESULT_BODY',runId:run.id});store.appendEvent(chat.id,'status',{status:'idle'});
 const events=store.listEvents(chat.id,0);
 return {chat,task,source:published,user:events.find(e=>e.kind==='user')!.id,checkpoint:events.at(-1)!.id,retract:()=>assets.setLifecycle(p,withdrawn.id,'retracted',withdrawn.revision)};
}
test('withdrawn execution bodies cannot be copied by fork branch or edit before native work',async()=>{
 const f=await protectedTranscript();f.retract();
 for(const action of ['fork','branch','edit'])expect((await request('/api/conversations/'+f.chat.id+'/'+action,'POST',{eventId:action==='fork'?f.checkpoint:f.user,text:'Changed'})).status).toBe(403);
 expect(nativeForks).toBe(0);expect(store.listConversations()).toHaveLength(1);
 const c=await(await request('/api/v2/tasks/'+f.task.id+'/control')).json();expect((await request('/api/v2/tasks/'+f.task.id+'/stop','POST',{expectedRevision:c.revision})).status).toBe(200);
});
test.each(['source','output'] as const)('an authorized fork and its descendant retain current protected provenance after %s withdrawal',async(kind)=>{
 const f=await protectedTranscript(kind);
 const first=await request('/api/conversations/'+f.chat.id+'/fork','POST',{eventId:f.checkpoint});expect(first.status).toBe(201);const fork=(await first.json()).conversation;
 const checkpoint=store.listEvents(fork.id,0).find(e=>e.kind==='status')!.id;
 const next=await request('/api/conversations/'+fork.id+'/fork','POST',{eventId:checkpoint});expect(next.status).toBe(201);const descendant=(await next.json()).conversation;
 const stream=await request('/api/conversations/'+descendant.id+'/events'),reader=stream.body!.getReader();expect(stream.status).toBe(200);await reader.read();
 f.retract();store.appendEvent(descendant.id,'text',{text:'NEW_WITHDRAWN_BODY'});
 for(const id of [fork.id,descendant.id]){expect((await request('/api/conversations/'+id)).status).toBe(403);expect((await request('/api/conversations/'+id+'/events')).status).toBe(403);}
 let text='';for(;;){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}expect(text).not.toContain('NEW_WITHDRAWN_BODY');
 expect((await request('/api/conversations/'+fork.id+'/fork','POST',{eventId:checkpoint})).status).toBe(403);expect(nativeForks).toBe(2);
});
test('public start replays the exact original revision and rejects changed revision for the same key',async()=>{
 const tasks=createTasks(store,{resolve:()=>({agentId:'a',projectId:null,hostId:'local',input:'Goal',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const task=tasks.createTask({userId:'local'},{...todo,assigneeAgentId:'a'},'replay-task'),run=tasks.startTask({userId:'local'},task.id,1,'same-start');
 expect((await request('/api/v2/tasks/'+task.id+'/start','POST',{expectedRevision:999},'same-start')).status).toBe(409);
 const exact=await request('/api/v2/tasks/'+task.id+'/start','POST',{expectedRevision:1},'same-start');expect(exact.status).toBe(202);expect((await exact.json()).id).toBe(run.id);
 expect(tasks.listRunControls({userId:'local'},task.id)).toHaveLength(1);expect(nativeForks).toBe(0);
});

test('a fork cannot resubmit withdrawn native history through send or continue',async()=>{
 const f=await protectedTranscript();const fork=(await(await request('/api/conversations/'+f.chat.id+'/fork','POST',{eventId:f.checkpoint})).json()).conversation;
 f.retract();const before=nativeFactories;
 for(const action of ['messages','continue'])expect((await request('/api/conversations/'+fork.id+'/'+action,'POST',{text:'Use old context'})).status).toBe(403);
 expect(nativeFactories).toBe(before);expect(nativeTurns).toBe(0);expect(store.listEvents(fork.id,0).some(e=>(e.data as {text?:string}).text==='Use old context')).toBe(false);
});

test('editing an authorized inherited transcript does not erase its protected provenance',async()=>{
 const f=await protectedTranscript();const fork=(await(await request('/api/conversations/'+f.chat.id+'/fork','POST',{eventId:f.checkpoint})).json()).conversation;
 const user=store.listEvents(fork.id,0).find(e=>e.kind==='user')!;
 const edited=await request('/api/conversations/'+fork.id+'/edit','POST',{eventId:user.id,text:'Edited synthetic input'});expect(edited.status).toBe(200);expect(nativeTurns).toBe(1);
 f.retract();expect((await request('/api/conversations/'+fork.id)).status).toBe(403);expect((await request('/api/conversations/'+fork.id+'/events')).status).toBe(403);
});
test('withdrawal while native fork awaits denies copy commit without publishing a derived conversation',async()=>{
 const f=await protectedTranscript();let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);onFork=async()=>{entered();await gate;};
 const pending=request('/api/conversations/'+f.chat.id+'/fork','POST',{eventId:f.checkpoint});await waiting;f.retract();release();
 expect((await pending).status).toBe(403);expect(store.listConversations()).toHaveLength(1);expect(nativeForks).toBe(1);
});

test('upgrade fixes protected provenance for existing fork chains without changing ordinary chats',async()=>{
 const restart=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));manager.close();manager=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw Error('Unexpected native during migration');},undefined,home);server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as {port:number}).port;};
 const f=await protectedTranscript();
 const fork=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,branchedFrom:{conversationId:f.chat.id,eventId:f.checkpoint}});
 const descendant=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null,branchedFrom:{conversationId:fork.id,eventId:1}});
 store.appendEvent(descendant.id,'text',{text:'LEGACY_PROTECTED_BODY'});
 const ordinary=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 store.database.prepare('DELETE FROM schema_migrations WHERE key=?').run('durable_tasks_006_conversation_provenance');
 await restart();
 f.retract();expect((await request('/api/conversations/'+descendant.id)).status).toBe(403);expect((await request('/api/conversations/'+fork.id)).status).toBe(403);
 expect((await request('/api/conversations/'+ordinary.id)).status).toBe(200);
 const saved=store.listConversationTaskRuns(descendant.id);expect(saved).toHaveLength(1);
 const late=createTasks(store,{resolve:()=>({agentId:'a',projectId:null,hostId:'local',input:'Later unrelated input',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const current=late.getTask({userId:'local'},f.task.id),reopened=late.userCommand({userId:'local'},current.id,current.revision,'reopen','Later input'),prepared=late.prepareStart({userId:'local'},reopened.id,reopened.revision,'later-start');store.transaction(()=>prepared.commit({executionConversationId:f.chat.id,mode:'dedicated',destinationConversationId:null}));
 expect(store.listConversationTaskRuns(f.chat.id)).toHaveLength(2);await restart();expect(store.listConversationTaskRuns(descendant.id)).toEqual(saved);expect((await request('/api/conversations/'+descendant.id)).status).toBe(403);
});

test('fixed output source lookup authorizes exact membership and rejects forged or superseded feedback',async()=>{
 const f=await protectedTranscript('output'),p={userId:'local'},tasks=manager.taskService;
 const run=tasks.listRuns(p,f.task.id).at(-1)!,ref=run.artifactVersions[0];
 const sourcePath='/api/v2/tasks/source?assetId='+ref.assetId+'&versionId='+ref.versionId;
 const valid=await request(sourcePath);expect(valid.status).toBe(200);expect(await valid.json()).toMatchObject({task:{id:f.task.id},run:{id:run.id},currentOutput:true});
 const files=createAssetFiles(home),actor={...p,runId:run.id};writeFileSync(join(home,'forged.md'),'Not a Run output');
 const stage=await files.stageFiles(actor,run.id,[{allowedRoot:home,relativePath:'forged.md',manifestPath:'forged.md'}]);
 const forged=createAssets(store,files).publishAssetVersion(actor,{assetId:ref.assetId,expectedHeadVersionId:ref.versionId,submissionId:stage.submissionId,files:stage.files,provenance:{runId:run.id,sourceVersions:[]}},'forged-source');
 expect(await(await request(sourcePath)).json()).toMatchObject({currentOutput:false});
 const wrong=await request('/api/v2/tasks/source?assetId='+ref.assetId+'&versionId='+forged.id);expect(wrong.status).toBe(200);expect(await wrong.json()).toBe(null);
 tasks.userCommand(p,f.task.id,tasks.getTask(p,f.task.id).revision,'reopen','More work');
 const starts=createTasks(store,{assets:createAssets(store,files),resolve:()=>({agentId:'a',projectId:null,hostId:'local',input:'New attempt',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const next=starts.startTask(p,f.task.id,tasks.getTask(p,f.task.id).revision,'later-run');expect(next.id).not.toBe(run.id);
 const identity={runId:next.id,hostId:'local',nativeSessionId:'newer-native',nativeTurnId:'newer-turn'};expect(starts.bindRunIdentity(identity)).toBe('applied');
 const laterActor={...p,agentId:'a',runId:next.id};writeFileSync(join(home,'newer.md'),'Later restricted output');
 const laterStage=await files.stageFiles(laterActor,next.id,[{allowedRoot:home,relativePath:'newer.md',manifestPath:'newer.md'}]),assets=createAssets(store,files);
 const later=assets.importAsset(laterActor,{kind:'file',title:'Newer restricted output',agentId:'a',submissionId:laterStage.submissionId},'newer-output');
 expect(starts.applyRunEvent({...identity,eventKey:'newer-complete',outcome:'succeeded',summary:'Later restricted summary',artifactVersions:[{assetId:later.asset.id,versionId:later.version.id}]})).toBe('applied');
 assets.setLifecycle(p,later.asset.id,'retracted',later.asset.revision);
 const oldSource=await request(sourcePath);expect(oldSource.status).toBe(200);const oldBody=await oldSource.text();expect(oldBody).not.toContain(later.asset.id);expect(oldBody).not.toContain(later.version.id);expect(oldBody).not.toContain('Later restricted summary');
 expect(await(await request(sourcePath)).json()).toMatchObject({currentOutput:false});
 const current=createAssets(store,files).getAuthorizedAsset(p,ref.assetId);createAssets(store,files).setLifecycle(p,ref.assetId,'retracted',current.revision);expect((await request(sourcePath)).status).toBe(403);
});

for(const change of ['head','output','source'] as const)test('feedback guard atomically rejects '+change+' changed after authorized preflight',async()=>{
 const f=await protectedTranscript('output',true),p={userId:'local'},tasks=manager.taskService,assets=createAssets(store,createAssetFiles(home));
 const run=tasks.listRuns(p,f.task.id)[0],ref=run.artifactVersions[0];
 const source=await(await request('/api/v2/tasks/source?assetId='+ref.assetId+'&versionId='+ref.versionId)).json();expect(source.currentOutput).toBe(true);
 if(change==='head'){
  const stage=await(await fetch(url+'/api/v2/assets/uploads?name=new.md',{method:'POST',body:'NEW HEAD'})).json();
  expect((await request('/api/v2/assets/'+ref.assetId+'/versions','POST',{expectedHeadVersionId:ref.versionId,submissionId:stage.submissionId,provenance:{sourceVersions:[]}},'new-head')).status).toBe(201);
 }else if(change==='output')f.retract();else assets.setLifecycle(p,f.source.asset.id,'retracted',assets.getAuthorizedAsset(p,f.source.asset.id).revision);
 const response=await request('/api/v2/tasks/'+f.task.id+'/reopen','POST',{expectedRevision:source.task.revision,reason:'Fix report',expectedOutput:{...ref,runId:run.id}},'guarded-feedback');
 expect(response.status).toBe(change==='head'?409:403);expect(tasks.getTask(p,f.task.id)).toMatchObject({state:'completed',revision:source.task.revision});
});
test('feedback guard permits current output, hashes exact guard and retains unguarded owner control',async()=>{
 const f=await protectedTranscript('output'),p={userId:'local'},tasks=manager.taskService,run=tasks.listRuns(p,f.task.id)[0],ref=run.artifactVersions[0],task=tasks.getTask(p,f.task.id);
 const data={expectedRevision:task.revision,reason:'Fix report',expectedOutput:{...ref,runId:run.id}};
 expect((await request('/api/v2/tasks/'+task.id+'/reopen','POST',data,'feedback')).status).toBe(200);
 expect((await request('/api/v2/tasks/'+task.id+'/reopen','POST',data,'feedback')).status).toBe(200);
 expect((await request('/api/v2/tasks/'+task.id+'/reopen','POST',{...data,expectedOutput:{...data.expectedOutput,runId:'different-run'}},'feedback')).status).toBe(409);
 const manual=tasks.createTask(p,todo,'manual-guard-test'),review=tasks.userCommand(p,manual.id,1,'complete');const accepted=tasks.userCommand(p,manual.id,review.revision,'accept');
 expect((await request('/api/v2/tasks/'+manual.id+'/reopen','POST',{expectedRevision:accepted.revision,reason:'Owner choice'})).status).toBe(200);
});

test('board move is atomic and rejects active execution without interrupting it',async()=>{
 const task=await(await request('/api/v2/tasks','POST',todo,'board-http')).json();
 const moved=await request(`/api/v2/tasks/${task.id}/move`,'POST',{expectedRevision:task.revision,state:'completed'},'board-move');expect(moved.status).toBe(200);const done=await moved.json();expect(done.state).toBe('completed');
 const response=await request(`/api/v2/tasks/${task.id}/move`,'POST',{expectedRevision:done.revision,state:'running'},'board-reopen');expect(response.status).toBe(200);const reopened=await response.json();expect(reopened.state).toBe('running');
 expect(await(await request(`/api/v2/tasks/${task.id}/runs`)).json()).toEqual([]);
 const agentTask=manager.taskService.createTask({userId:'local'},{goal:'Active task',assigneeAgentId:'a'},'active-board');
 const run=await manager.startDurableTask(agentTask.id,agentTask.revision,'active-start');
 const active=manager.taskService.getTask({userId:'local'},agentTask.id);
 expect((await request(`/api/v2/tasks/${active.id}/move`,'POST',{expectedRevision:active.revision,state:'completed'},'active-move')).status).toBe(409);
 expect(manager.taskService.getTask({userId:'local'},active.id)).toMatchObject({id:active.id,state:active.state,revision:active.revision,completion:active.completion});
 expect(['queued','starting','running']).toContain(manager.taskService.getRun({userId:'local'},run.id).state);
 expect(store.listOutbox(0).filter(event=>event.aggregateId===active.id&&['task.cancelled','task.stopped','task.accept'].includes(event.type))).toEqual([]);
});
