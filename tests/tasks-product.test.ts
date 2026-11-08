import { afterEach,expect,test,vi } from 'vitest';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTasks } from '../server/tasks';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import type { CodexClient,CodexOptions } from '../server/codex';
import type { Config } from '../shared/types';
const p={userId:'local'};const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
const config:Config={version:2,projects:[{id:'p',name:'P',cwd:'/tmp',agentIds:['a'],mcp:[],skills:[],resources:[]}],agents:[{id:'a',name:'A',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]};
function setup(){const home=mkdtempSync(join(tmpdir(),'task-product-')),store=openStore(home),files=createAssetFiles(home),assets=createAssets(store,files);const tasks=createTasks(store,{assets,resolve:(_p,task)=>({agentId:task.assigneeAgentId!,projectId:task.projectId,hostId:'local',input:task.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return {home,store,files,assets,tasks};}
const input={goal:'Manual goal',criteria:[],acceptance:'delivery' as const,projectId:null,assigneeAgentId:null};
async function plan(f:ReturnType<typeof setup>){writeFileSync(join(f.home,'plan.md'),'Collect then summarize');const stage=await f.files.stageFiles(p,null,[{allowedRoot:f.home,relativePath:'plan.md',manifestPath:'plan.md'}]);const {asset,version}=f.assets.importAsset(p,{kind:'document',title:'Plan',submissionId:stage.submissionId},'plan');return {asset,ref:{assetId:asset.id,versionId:version.id}};}
test('fixed plan tasks start independently and sources are authorized as executor, not root',async()=>{
 const f=setup(),{asset,ref}=await plan(f);
 const [first,second]=f.tasks.adoptPlan(p,ref,[{key:'one',taskId:null,goal:'Collect'},{key:'two',taskId:null,goal:'Summarize'}],'adopt');
 const assigned=f.tasks.userCommand(p,second.id,1,'assign','a');
 expect(f.tasks.getTask(p,first.id).state).toBe('todo');
 expect(()=>f.tasks.startTask(p,assigned.id,assigned.revision,'denied')).toThrow(expect.objectContaining({code:'forbidden'}));expect(f.tasks.listRuns(p,assigned.id)).toEqual([]);
 f.assets.setAccess(p,asset.id,{mode:'selected',agentIds:['a']},asset.revision);
 const run=f.tasks.startTask(p,assigned.id,assigned.revision,'allowed');expect(f.tasks.getContextSnapshot(p,run.id)?.sourceVersions).toMatchObject([ref]);expect(f.tasks.getTask(p,first.id).state).toBe('todo');
});
test('existing Task selection is owned and failed multi-step adoption rolls back all bindings and new tasks',async()=>{
 const f=setup(),{ref}=await plan(f),foreign=f.tasks.createTask({userId:'other'},input,'foreign');
 expect(()=>f.tasks.adoptPlan(p,ref,[{key:'new',taskId:null,goal:'New'},{key:'foreign',taskId:foreign.id,goal:'Unauthorized'}],'foreign')).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(f.tasks.listTasks(p)).toEqual([]);expect(f.store.database.prepare('SELECT count(*) n FROM task_plan_steps').get()?.n).toBe(0);
 const [a,b]=f.tasks.adoptPlan(p,ref,[{key:'a',taskId:null,goal:'A'},{key:'b',taskId:null,goal:'B'}],'first');
 const [linked]=f.tasks.adoptPlan(p,ref,[{key:'alias-a',taskId:a.id,goal:'A alias'}],'alias');
 expect(linked.id).toBe(a.id);expect(f.tasks.listTasks(p).map(t=>t.id).sort()).toEqual([a.id,b.id].sort());expect(f.store.database.prepare('SELECT count(*) n FROM task_plan_steps').get()?.n).toBe(3);
});
test('current plan ACL is checked even for command replay; rejected adoption leaves no dedup',async()=>{
 const f=setup(),{asset,ref}=await plan(f),steps=[{key:'a',taskId:null,goal:'A'}];f.tasks.adoptPlan(p,ref,steps,'adopt');
 f.assets.setLifecycle(p,asset.id,'retracted',asset.revision);
 expect(()=>f.tasks.adoptPlan(p,ref,steps,'adopt')).toThrow(expect.objectContaining({code:'forbidden'}));expect(()=>f.tasks.adoptPlan(p,ref,steps,'new')).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(f.store.database.prepare('SELECT count(*) n FROM task_plan_commands').get()?.n).toBe(1);
});
test('Run success never accepts legacy checks or human tasks; user review then accept records output Run',()=>{
 const f=setup();for(const acceptance of ['checks','human'] as const){const task=f.tasks.createTask(p,{...input,assigneeAgentId:'a',acceptance},acceptance),run=f.tasks.startTask(p,task.id,1,'start-'+acceptance);const identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:run.id};f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:run.id,outcome:'succeeded',summary:'Delivered',artifactVersions:[]});
 expect(f.tasks.getTask(p,task.id)).toMatchObject({state:'review',completion:null});const review=f.tasks.userCommand(p,task.id,3,'complete');expect(f.tasks.userCommand(p,task.id,review.revision,'accept')).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:run.id}});
 }
});
test('start retains caller revision across async preparation and never queues after unrelated edit',async()=>{
 const f=setup();let resume!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>resume=r);const manager=createSessionManager(f.store,async()=>{entered();await wait;return config;},undefined,undefined,f.home);clean.unshift(()=>manager.close());
 const task=manager.taskService.createTask(p,{...input,projectId:'p',assigneeAgentId:'a'},'create');const starting=manager.startDurableTask(task.id,1,'start');await ready;
 manager.taskService.userCommand(p,task.id,1,'assign','a');resume();await expect(starting).rejects.toMatchObject({code:'revision_conflict'});expect(manager.taskService.listRuns(p,task.id)).toEqual([]);expect(f.store.listConversations()).toEqual([]);
});
test('public stop rejects stale caller revision and applies one epoch/receipt before native interrupt',async()=>{
 const f=setup();let options:CodexOptions;let interrupted=0;
 const factory=async(o:CodexOptions):Promise<CodexClient>=>{options=o;return {getStatus:async()=>({status:'ready',version:'fake'}),listModels:async()=>[],startThread:async()=> 'native',resumeThread:async()=>{},startTurn:async()=>{options.onEvent({method:'turn/started',params:{threadId:'native',turn:{id:'turn'}}});return 'turn';},interrupt:async()=>{interrupted++;options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'interrupted'}}});},replyApproval(){},close(){}};};
 const manager=createSessionManager(f.store,async()=>config,factory,undefined,f.home);clean.unshift(()=>manager.close());
 const source=await manager.create('p','a'),accepted=await manager.createTask(source.id,'a','hold',undefined,{policy:'notify'});await vi.waitFor(()=>expect(manager.taskService.listRuns(p,accepted.id)[0]?.nativeTurnId).toBe('turn'));
 const before=manager.taskService.getTask(p,accepted.id);await expect(manager.stopDurableTask(accepted.id,before.revision+7)).rejects.toMatchObject({code:'revision_conflict'});expect(interrupted).toBe(0);
 const result=await manager.stopDurableTask(accepted.id,before.revision);expect(result).toMatchObject({taskId:accepted.id,status:'stopped'});expect(Object.keys(result).sort()).toEqual(['runId','status','taskId']);expect(interrupted).toBe(1);
 expect(manager.taskService.getTask(p,accepted.id).continuationEpoch).toBe(before.continuationEpoch+1);expect(manager.taskService.listReceipts(p,accepted.id)).toHaveLength(1);
});
test('reassigning a stopped task starts a fresh transcript for the new assignee and retains fixed sources',async()=>{
 const f=setup(),{asset,ref}=await plan(f);f.assets.setAccess(p,asset.id,{mode:'all'},asset.revision);
 const expanded={...config,agents:[...config.agents,{...config.agents[0],id:'b',name:'B'}],projects:[{...config.projects[0],agentIds:['a','b']}]};
 const source=f.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const service=createTasks(f.store,{assets:f.assets,resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'original',sourceVersions:[ref],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const task=service.createTask(p,{...input,projectId:'p',assigneeAgentId:'a'},'source-task'),prepared=service.prepareStart(p,task.id,1,'source-start');
 const old=f.store.transaction(()=>prepared.commit({executionConversationId:source.id,mode:'dedicated',destinationConversationId:null}));service.stopTask(p,task.id,2);
 const current=service.getTask(p,task.id),assigned=service.userCommand(p,task.id,current.revision,'assign','b');
 const manager=createSessionManager(f.store,async()=>expanded,async()=>{throw Error('No native execution required');},undefined,f.home);clean.unshift(()=>manager.close());
 const run=await manager.startDurableTask(task.id,assigned.revision,'start-b');
 expect(f.store.getConversation(run.routing!.executionConversationId)?.agentId).toBe('b');expect(run.routing!.executionConversationId).not.toBe(source.id);
 expect(service.getContextSnapshot(p,run.id)?.sourceVersions).toMatchObject([ref]);expect(service.getContextSnapshot(p,old.id)?.input).toBe('original');manager.close();
});
test('adopting a plan onto an existing Task advances its revision once and protects stale commands',async()=>{
 const f=setup(),{ref}=await plan(f),task=f.tasks.createTask(p,input,'existing'),steps=[{key:'linked',taskId:task.id,goal:'Linked step'}];
 const [linked]=f.tasks.adoptPlan(p,ref,steps,'link');expect(linked.revision).toBe(task.revision+1);
 expect(()=>f.tasks.userCommand(p,task.id,task.revision,'complete')).toThrow(expect.objectContaining({code:'revision_conflict'}));
 expect(f.tasks.adoptPlan(p,ref,steps,'same')[0].revision).toBe(linked.revision);
});
