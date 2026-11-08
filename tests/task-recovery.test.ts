import {spawnSync} from 'node:child_process';
import {test,expect,afterEach,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store';
import {createSessionManager} from '../server/sessions';
import {createTasks} from '../server/tasks';
import {createTaskResources} from '../server/task-resources';
import {createTaskScheduler} from '../server/task-scheduler';
import {canReleaseNativeOccupancy} from '../server/task-recovery';
import type {Config} from '../shared/types';
import type {RunIdentity} from '../shared/tasks';
import type {CodexClient,CodexOptions} from '../server/codex';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
const config:Config={version:2,projects:[{id:'p',name:'P',cwd:'/tmp',agentIds:['a'],mcp:[],skills:[],resources:[]}],agents:[{id:'a',name:'A',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]};
function setup(cli:'codex'|'omp'='codex'){
 const home=mkdtempSync(join(tmpdir(),'mana-recovery-'));const store=openStore(home);let outcome='unknown',callbacks:CodexOptions;const starts:string[]=[],nativeCalls:{method:string;id:string}[]=[],inspections:RunIdentity[]=[];
 const factory=async(options:CodexOptions):Promise<CodexClient>=>{callbacks=options;return {getStatus:async()=>({status:'ready',version:'fake'}),listModels:async()=>[],startThread:async()=>{const id=store.listConversations().some(c=>c.nativeId==='session')?'fresh-session':'session';nativeCalls.push({method:'startThread',id});return id;},resumeThread:async(id)=>{nativeCalls.push({method:'resumeThread',id});},startTurn:async(_,text)=>{starts.push(text);return 'new-turn';},interrupt:async()=>{},replyApproval(){},close(){},inspectInvocation:async(identity)=>{inspections.push(identity);return outcome as any;}};};
 let manager=createSessionManager(store,async()=>config,factory,undefined,home);
 const tasks=createTasks(store,{resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'fixed input',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const c=store.createConversation({projectId:'p',agentId:'a',cli,model:null});
 const task=tasks.createTask({userId:'local'},{goal:'goal',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'create');
 const prepared=tasks.prepareStart({userId:'local'},task.id,task.revision,'start');
 const run=store.transaction(()=>prepared.commit({executionConversationId:c.id,mode:'dedicated',destinationConversationId:null}));
 clean.push(()=>{manager.close();store.close();rmSync(home,{recursive:true,force:true});});
 return{home,store,tasks,c,task,run,starts,nativeCalls,inspections,exit:(reason:string)=>callbacks.onExit(reason),setOutcome:(s:string)=>{outcome=s;},restart:()=>{manager.close();manager=createSessionManager(store,async()=>config,factory,undefined,home);return manager;},get manager(){return manager;}};
}
test('restart dispatches persisted queued Run once with its fixed input',async()=>{const f=setup();await f.restart().reconcileRuns('local');await vi.waitFor(()=>expect(f.starts).toEqual(['fixed input']));});
test('shutdown marks a submitted Run unknown without inventing terminal success or retrying it',async()=>{
 const f=setup(),p={userId:'local'};await f.manager.reconcileRuns('local');await vi.waitFor(()=>expect(f.starts).toEqual(['fixed input']));
 await f.manager.close();expect(f.tasks.getRun(p,f.run.id).state).toBe('unknown');
 expect(f.tasks.listReceipts(p,f.task.id)).toEqual([]);
 await f.restart().reconcileRuns('local');expect(f.starts).toEqual(['fixed input']);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});
test('shutdown preserves submitted queued input uncertainty and does not send the following input on restart',async()=>{
 const f=setup(),one=f.manager.enqueueUserInput(f.c.id,'first input','first'),two=f.manager.enqueueUserInput(f.c.id,'next input','next');
 await vi.waitFor(()=>expect(f.starts).toEqual(['first input']));await f.manager.close();
 expect(f.manager.listUserInputs(f.c.id)).toMatchObject([{id:one.id,state:'unknown'},{id:two.id,state:'queued'}]);
 await f.restart().reconcileRuns('local');expect(f.starts).toEqual(['first input']);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});
test('native disconnect leaves a submitted Run unknown with its reason instead of a fabricated failed receipt',async()=>{
 const f=setup(),p={userId:'local'};await f.manager.reconcileRuns('local');await vi.waitFor(()=>expect(f.starts).toEqual(['fixed input']));
 f.exit('native transport disconnected');expect(f.tasks.getRun(p,f.run.id).state).toBe('unknown');expect(f.tasks.listReceipts(p,f.task.id)).toEqual([]);
 expect(f.store.listEvents(f.c.id,0).some(e=>e.kind==='error'&&(e.data as {message:string}).message==='native transport disconnected')).toBe(true);
 await f.restart().reconcileRuns('local');expect(f.starts).toEqual(['fixed input']);
});
test('native disconnect does not mark a submitted queued input completed or wake the next input',async()=>{
 const f=setup(),one=f.manager.enqueueUserInput(f.c.id,'first input','first'),two=f.manager.enqueueUserInput(f.c.id,'next input','next');
 await vi.waitFor(()=>expect(f.starts).toEqual(['first input']));f.exit('CLI exited (3)');
 expect(f.manager.listUserInputs(f.c.id)).toMatchObject([{id:one.id,state:'unknown'},{id:two.id,state:'queued'}]);expect(f.starts).toEqual(['first input']);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});
test('lost start response becomes unknown and is never resent',async()=>{const f=setup();f.store.database.prepare("UPDATE task_runs SET state='starting' WHERE id=?").run(f.run.id);const m=f.restart();await m.reconcileRuns('local');await m.reconcileRuns('local');expect(f.tasks.getRun({userId:'local'},f.run.id).state).toBe('unknown');expect(f.starts).toEqual([]);});
test('exact native terminal only repairs one receipt and missing delivery stays waiting',async()=>{const f=setup();f.tasks.bindRunIdentity({runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'});f.setOutcome('succeeded');const m=f.restart();await m.reconcileRuns('local');await m.reconcileRuns('local');expect(f.tasks.listReceipts({userId:'local'},f.task.id)).toHaveLength(1);expect(f.tasks.getTask({userId:'local'},f.task.id)).toMatchObject({state:'waiting',waitingReason:'delivery_missing'});expect(f.starts).toEqual([]);});
test('old claimed input without exact invocation is uncertain and never automatically resent',async()=>{const f=setup();const input=f.manager.enqueueUserInput(f.c.id,'uncertain body','input');f.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(input.id);await f.restart().reconcileRuns('local');expect(f.manager.listUserInputs(f.c.id)[0].state).toBe('unknown');expect(f.starts).toEqual([]);});
test('restart approval is unknown; old approval cannot authorize a new explicit attempt',async()=>{
 const f=setup();f.tasks.bindRunIdentity({runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'});f.store.database.prepare("UPDATE task_runs SET state='approval' WHERE id=?").run(f.run.id);f.store.updateConversation(f.c.id,{status:'approval',nativeId:'session',turnId:'old-turn'});
 const m=f.restart();await m.reconcileRuns('local');expect(m.getApprovals(f.c.id)).toEqual([]);await expect(m.approve(f.c.id,'old-approval','approve')).rejects.toThrow();
 const waiting=f.tasks.getTask({userId:'local'},f.task.id);const newer=await m.retryTask(waiting.id,waiting.revision,'explicit-new-attempt');expect(newer.id).not.toBe(f.run.id);expect(newer.attempt).toBe(2);await vi.waitFor(()=>expect(f.starts).toEqual(['goal']));expect(newer.routing?.executionConversationId).not.toBe(f.c.id);expect(f.store.getConversation(f.c.id)).toMatchObject({status:'interrupted',nativeId:'session',turnId:'old-turn'});expect(m.getApprovals(newer.routing!.executionConversationId)).toEqual([]);await expect(m.approve(newer.routing!.executionConversationId,'old-approval','approve')).rejects.toThrow();await expect(m.approve(f.c.id,'old-approval','approve')).rejects.toThrow();
});
test('queued input association uses server invocation, never conversation latest turn',async()=>{
 const f=setup();const input=f.manager.enqueueUserInput(f.c.id,'first input','exact-input');
 // Leave the Run queued behind this input, then simulate loss of process after submission.
 await vi.waitFor(()=>expect(f.starts).toEqual(['first input']));const correlation=f.store.database.prepare('SELECT * FROM task_input_invocations WHERE input_id=?').get(input.id)!;
 expect(correlation).toMatchObject({native_session_id:'session',native_turn_id:'new-turn'});expect(correlation.invocation_id).not.toBe(f.run.id);
 f.store.updateConversation(f.c.id,{nativeId:'other-session',turnId:'unrelated-new-turn'});f.setOutcome('succeeded');await f.restart().reconcileRuns('local');expect(f.manager.listUserInputs(f.c.id)[0].state).toBe('completed');
});
test('uncertain input dismissal preserves native occupancy and following queued input order',async()=>{
 const f=setup();const one=f.manager.enqueueUserInput(f.c.id,'uncertain','one'),two=f.manager.enqueueUserInput(f.c.id,'second','two');f.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(one.id);f.store.updateConversation(f.c.id,{status:'running'});
 const m=f.restart();await m.reconcileRuns('local');expect(f.starts).toEqual([]);m.resolveUnknownInput(one.id,'dismiss','dismiss-one');await new Promise(r=>setImmediate(r));expect(f.starts).toEqual([]);expect(m.listUserInputs(f.c.id)).toMatchObject([{id:one.id,state:'cancelled'},{id:two.id,state:'queued'}]);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});
test('actual subprocess crash after native send with no response never repeats the action',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-crash-start-'));
 const code=`import {openStore} from './server/store.ts';import {createSessionManager} from './server/sessions.ts';import {createTasks} from './server/tasks.ts';import {writeFileSync} from 'node:fs';
 const home=process.env.OPEN_MANA_HOME,store=openStore(home),config=${JSON.stringify(config)};
 const factory=async()=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'native-session',resumeThread:async()=>{},startTurn:async()=>{writeFileSync(home+'/sent','once');process.exit(17);},interrupt:async()=>{},replyApproval(){},close(){}});
 const m=createSessionManager(store,async()=>config,factory,undefined,home);const tasks=createTasks(store,{resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'action',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const c=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),p={userId:'local'};const t=tasks.createTask(p,{goal:'goal',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'new');const prepared=tasks.prepareStart(p,t.id,1,'start');store.transaction(()=>prepared.commit({executionConversationId:c.id,mode:'dedicated',destinationConversationId:null}));await m.reconcileRuns('local');`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,OPEN_MANA_HOME:home},encoding:'utf8',timeout:10000});
 expect(result.status,result.stderr).toBe(17);
 const store=openStore(home);let starts=0;const m=createSessionManager(store,async()=>config,async()=>{starts++;throw Error('No replay');},undefined,home);
 try{await m.reconcileRuns('local');expect(store.database.prepare('SELECT state FROM task_runs').get()!.state).toBe('unknown');expect(starts).toBe(0);}finally{m.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test('actual subprocess crash after publish repairs original output projection and receipt',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-crash-artifact-'));
 const code=`import {openStore} from './server/store.ts';import {createSessionManager} from './server/sessions.ts';import {createTasks} from './server/tasks.ts';import {createAssets} from './server/assets.ts';import {createAssetFiles} from './server/asset-files.ts';import {createRunArtifacts} from './server/run-artifacts.ts';import {writeFileSync} from 'node:fs';
 const home=process.env.OPEN_MANA_HOME,store=openStore(home),config=${JSON.stringify(config)};const m=createSessionManager(store,async()=>config,undefined,undefined,home),files=createAssetFiles(home),assets=createAssets(store,files);
 const tasks=createTasks(store,{assets,resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'action',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})}),p={userId:'local'};
 const c=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),t=tasks.createTask(p,{goal:'goal',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'new');const prepared=tasks.prepareStart(p,t.id,1,'start'),run=store.transaction(()=>prepared.commit({executionConversationId:c.id,mode:'dedicated',destinationConversationId:null}));tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'});
 writeFileSync(home+'/output.txt','synthetic report');const tools=createRunArtifacts({store,files,assets,principal:{...p,agentId:'a',runId:run.id},outputRoot:home,sourceVersions:[],assertActive(){}});
 const prepare=store.database.prepare.bind(store.database);store.database.prepare=(sql)=>{if(sql==='INSERT INTO run_artifact_commands VALUES (?,?,?,?)')process.exit(19);return prepare(sql);};await tools.publish({title:'Report',files:[{path:'output.txt'}]},'publish');`;
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,OPEN_MANA_HOME:home},encoding:'utf8',timeout:10000});expect(result.status,result.stderr).toBe(19);
 const store=openStore(home),original=store.database.prepare('SELECT id FROM asset_versions').get()!.id;
 let starts=0;const factory=async()=>({inspectInvocation:async()=> 'succeeded',close(){},startTurn:async()=>{starts++;return 'no';}} as unknown as CodexClient);
 const m=createSessionManager(store,async()=>config,factory,undefined,home);
 try{expect(store.database.prepare('SELECT COUNT(*) n FROM run_artifact_commands').get()!.n).toBe(0);await m.reconcileRuns('local');expect(store.database.prepare('SELECT COUNT(*) n FROM asset_versions').get()!.n).toBe(1);const receipt=store.database.prepare('SELECT artifact_versions FROM task_receipts').get()!;expect(JSON.parse(receipt.artifact_versions as string)[0].versionId).toBe(original);const command=store.database.prepare('SELECT result FROM run_artifact_commands').get()!;expect(JSON.parse(command.result as string).version.id).toBe(original);expect(starts).toBe(0);}finally{m.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test.each([false,true])('restart reconstructs same-task origin continuation only at current epoch (stopped=%s)',async(stopped)=>{
 const f=setup(),p={userId:'local'};f.store.database.prepare('UPDATE work_tasks SET future_auto_resume=1,origin_conversation_id=? WHERE id=?').run(f.c.id,f.task.id);
 const executions=createTasks(f.store,{resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'delegated work',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',continuation:{taskId:f.task.id,conversationId:f.c.id,epoch:0,policy:'resume'}})});
 const dest=f.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),prepared=executions.prepareStart(p,f.task.id,executions.getTask(p,f.task.id).revision,'delegated-start',undefined,{agentId:'a'}),run=f.store.transaction(()=>prepared.commit({executionConversationId:dest.id,mode:'dedicated',destinationConversationId:f.c.id}));
 f.tasks.bindRunIdentity({runId:f.run.id,hostId:'local',nativeSessionId:'origin',nativeTurnId:'origin-turn'});f.tasks.applyRunEvent({runId:f.run.id,hostId:'local',nativeSessionId:'origin',nativeTurnId:'origin-turn',eventKey:'origin-end',outcome:'succeeded',summary:'Initial phase',artifactVersions:[]});
 executions.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'executor',nativeTurnId:'executor-turn'});if(stopped)f.tasks.stopTask(p,f.task.id,f.tasks.getTask(p,f.task.id).revision);f.setOutcome('succeeded');await f.restart().reconcileRuns('local');
 const receipt=()=>f.tasks.listReceipts(p,f.task.id).find(item=>item.sourceRunId===run.id)!;
 if(stopped){expect(f.starts).toEqual([]);expect(receipt()).toMatchObject({executionId:run.executionId,deliveryState:'parked',claimedByRunId:null});}else{await vi.waitFor(()=>expect(f.starts).toHaveLength(1));expect(f.tasks.listRuns(p,f.task.id)).toHaveLength(3);expect(receipt().claimedByRunId).toBeTruthy();}
});
test('an old terminal Run cannot release a newer uncorrelated interrupted invocation',async()=>{
 const f=setup();const identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'old',outcome:'succeeded',summary:'old result',artifactVersions:[]});
 f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:'new-ordinary-invocation'});f.store.updateConversation(f.c.id,{status:'running',nativeId:'session',turnId:'old-turn'});f.manager.enqueueUserInput(f.c.id,'wait for uncertain native','fresh');
 await f.restart().reconcileRuns('local');expect(f.starts).toEqual([]);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});
test('OMP local generation identity is unsupported and stays unknown without a native call',async()=>{const f=setup('omp');f.tasks.bindRunIdentity({runId:f.run.id,hostId:'local',nativeSessionId:'omp-session',nativeTurnId:'local-generation-turn'});f.setOutcome('succeeded');const result=await f.restart().reconcileRuns('local');expect(result.unknown).toBe(1);expect(f.tasks.getRun({userId:'local'},f.run.id).state).toBe('unknown');expect(f.starts).toEqual([]);});
test('F2 retry of old failed Task preserves newer unrelated invocation occupancy',async()=>{
 const f=setup(),p={userId:'local'},identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'terminal:old',outcome:'failed',summary:'failed old task',artifactVersions:[]});f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:'newer-native'});f.store.updateConversation(f.c.id,{status:'running',nativeId:'session',turnId:'newer-turn'});const m=f.restart();await m.reconcileRuns('local');const current=f.tasks.getTask(p,f.task.id),retry=await m.retryTask(current.id,current.revision,'retry-old');
 expect(f.store.getConversation(f.c.id)).toMatchObject({status:'interrupted',nativeId:'session',turnId:'newer-turn'});expect(retry.routing?.executionConversationId).not.toBe(f.c.id);await vi.waitFor(()=>expect(f.starts).toHaveLength(1));expect(f.store.getConversation(f.c.id)?.turnId).toBe('newer-turn');expect(f.nativeCalls).toEqual([{method:'startThread',id:'fresh-session'}]);expect(f.store.getConversation(retry.routing!.executionConversationId)?.nativeId).toBe('fresh-session');
});
test.each(['dismiss','retry'] as const)('F2 unknown input %s cannot release newer unrelated native occupancy',async(action)=>{
 const f=setup();f.store.updateConversation(f.c.id,{status:'running',nativeId:'session',turnId:'newer-turn'});const input=f.manager.enqueueUserInput(f.c.id,'old uncertain input','old-input');f.store.database.prepare("UPDATE task_user_inputs SET state='unknown' WHERE id=?").run(input.id);f.manager.enqueueUserInput(f.c.id,'waiting new input','new-input');f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:'newer-unrelated'});const m=f.restart();await m.reconcileRuns('local');m.resolveUnknownInput(input.id,action,'resolve-old');await new Promise(r=>setImmediate(r));expect(f.starts).toEqual([]);expect(f.store.getConversation(f.c.id)).toMatchObject({status:'interrupted',nativeId:'session',turnId:'newer-turn'});
});
function failedExecution(f:ReturnType<typeof setup>){
 const p={userId:'local'},continuation={taskId:f.task.id,conversationId:f.c.id,epoch:0,policy:'resume' as const};f.store.database.prepare('UPDATE work_tasks SET future_auto_resume=1,origin_conversation_id=? WHERE id=?').run(f.c.id,f.task.id);
 const executions=createTasks(f.store,{resolve:()=>({agentId:'a',projectId:'p',hostId:'local',input:'goal',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',continuation})});
 const destination=f.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),prepared=executions.prepareStart(p,f.task.id,executions.getTask(p,f.task.id).revision,'delegated-start',undefined,{agentId:'a'}),run=f.store.transaction(()=>prepared.commit({executionConversationId:destination.id,mode:'dedicated',destinationConversationId:f.c.id}));
 const originIdentity={runId:f.run.id,hostId:'local',nativeSessionId:'origin',nativeTurnId:'origin-turn'};f.tasks.bindRunIdentity(originIdentity);f.tasks.applyRunEvent({...originIdentity,eventKey:'terminal:origin',outcome:'succeeded',summary:'Initial phase',artifactVersions:[]});
 const identity={runId:run.id,hostId:'local',nativeSessionId:'executor',nativeTurnId:'executor-turn'};executions.bindRunIdentity(identity);executions.applyRunEvent({...identity,eventKey:'terminal:executor',outcome:'failed',summary:'Failed execution',artifactVersions:[]});return{p,executions,run,continuation};
}
test('retry preserves same-task origin policy and epoch through successful receipt and eligible claim',async()=>{
 const f=setup(),{p,executions,run,continuation}=failedExecution(f),current=executions.getTask(p,f.task.id),retry=await f.manager.retryTask(f.task.id,current.revision,'retry-execution');expect(retry.continuation).toEqual(continuation);expect(retry.id).not.toBe(run.id);await vi.waitFor(()=>expect(f.starts).toEqual(['goal']));
 const native=executions.getRun(p,retry.id);executions.applyRunEvent({runId:native.id,hostId:native.hostId!,nativeSessionId:native.nativeSessionId!,nativeTurnId:native.nativeTurnId!,eventKey:'terminal:retried',outcome:'succeeded',summary:'Execution result',artifactVersions:[]});const receipt=executions.listReceipts(p,f.task.id).find(r=>r.sourceRunId===retry.id)!;expect(receipt).toMatchObject({taskId:f.task.id,executionId:retry.executionId,destinationConversationId:f.c.id,capturedEpoch:0,policy:'resume',deliveryState:'pending'});
 const scheduler=createTaskScheduler(f.store,f.tasks,{principal:p});expect(scheduler.claimReceipts(f.task.id,0,f.c.id,'coordinator-fix',[receipt.id])).toHaveLength(1);
});
test.each(['stopped','epoch_changed','disabled'] as const)('retry rejects %s origin authority without creating an attempt or waking it',async(mode)=>{
 const f=setup(),{p,executions}=failedExecution(f);if(mode==='stopped')f.tasks.stopTask(p,f.task.id,f.tasks.getTask(p,f.task.id).revision);else f.store.database.prepare(mode==='epoch_changed'?'UPDATE work_tasks SET continuation_epoch=continuation_epoch+1 WHERE id=?':'UPDATE work_tasks SET future_auto_resume=0 WHERE id=?').run(f.task.id);
 const current=executions.getTask(p,f.task.id),receiptsBefore=executions.listReceipts(p,f.task.id);await expect(f.manager.retryTask(f.task.id,current.revision,'stale-retry')).rejects.toMatchObject({code:'continuation_conflict'});expect(executions.listRuns(p,f.task.id)).toHaveLength(2);expect(f.tasks.getTask(p,f.task.id)).toEqual(current);expect(executions.listReceipts(p,f.task.id)).toEqual(receiptsBefore);expect(f.starts).toEqual([]);
});
test('F2 matching latest proven native terminal may reuse the original session safely',async()=>{
 const f=setup(),p={userId:'local'},identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'terminal:old',outcome:'failed',summary:'failed',artifactVersions:[]});f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:f.run.id});f.store.updateConversation(f.c.id,{status:'running',nativeId:'session',turnId:'old-turn'});const m=f.restart(),task=f.tasks.getTask(p,f.task.id),retry=await m.retryTask(task.id,task.revision,'same-session-retry');expect(retry.routing?.executionConversationId).toBe(f.c.id);await vi.waitFor(()=>expect(f.starts).toEqual(['goal']));expect(f.nativeCalls.some(call=>call.method==='startThread')).toBe(false);expect(f.nativeCalls.some(call=>call.method==='resumeThread'&&call.id==='session')).toBe(true);expect(f.tasks.getRun(p,retry.id)).toMatchObject({nativeSessionId:'session',nativeTurnId:'new-turn'});
});
test('F2 dismissing a claimed input without persisted conversation status still preserves unknown occupancy',async()=>{
 const f=setup(),input=f.manager.enqueueUserInput(f.c.id,'claimed before crash','claim-only');f.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(input.id);const m=f.restart();await m.reconcileRuns('local');m.resolveUnknownInput(input.id,'dismiss','dismiss-claim-only');await new Promise(r=>setImmediate(r));expect(f.starts).toEqual([]);expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
});

test.each(['dismiss','retry'] as const)('F2 older terminal proof cannot release a newer claim after %s or later Task retry',async(action)=>{
 const f=setup(),p={userId:'local'},identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};
 f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'terminal:old',outcome:'failed',summary:'failed',artifactVersions:[]});
 f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:f.run.id});f.store.updateConversation(f.c.id,{status:'idle',nativeId:'session',turnId:'old-turn'});
 const b=f.manager.enqueueUserInput(f.c.id,'claimed before metadata','claim-B');f.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(b.id);
 const c=f.manager.enqueueUserInput(f.c.id,'queued C','queue-C');let m=f.restart();await m.reconcileRuns('local');
 m.resolveUnknownInput(b.id,action,'resolve-B');await new Promise(r=>setImmediate(r));
 expect(f.starts).toEqual([]);expect(f.nativeCalls).toEqual([]);expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);
 expect(()=>m.resolveUnknownInput(b.id,action,'resolve-B')).toThrow('input_not_unknown');expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);
 expect(m.listUserInputs(f.c.id).find(i=>i.id===c.id)?.state).toBe('queued');expect(f.store.getConversation(f.c.id)?.status).toBe('interrupted');
 m=f.restart();await m.reconcileRuns('local');const task=f.tasks.getTask(p,f.task.id),retry=await m.retryTask(task.id,task.revision,'retry-A-after-dismiss');
 expect(retry.routing?.executionConversationId).not.toBe(f.c.id);expect((await m.retryTask(task.id,task.revision,'retry-A-after-dismiss')).id).toBe(retry.id);await vi.waitFor(()=>expect(f.starts).toEqual(['goal']));
 expect(f.nativeCalls).toEqual([{method:'startThread',id:'fresh-session'}]);expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);
 expect(f.store.getConversation(f.c.id)).toMatchObject({status:'interrupted',nativeId:'session',turnId:'old-turn'});
});
test.each(['dismiss','retry'] as const)('F2 internal %s retains a claimed occupancy even before startup recovery',async(action)=>{
 const f=setup(),identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};
 f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'terminal:old',outcome:'failed',summary:'failed',artifactVersions:[]});
 f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:f.run.id});f.store.updateConversation(f.c.id,{status:'idle',nativeId:'session',turnId:'old-turn'});
 const scheduler=createTaskScheduler(f.store,f.tasks,{principal:{userId:'local'}}),b=scheduler.enqueueUserInput(f.c.id,'unknown B','B');
 f.store.database.prepare("UPDATE task_user_inputs SET state='unknown' WHERE id=?").run(b.id);scheduler.enqueueUserInput(f.c.id,'queued C','C');
 scheduler.resolveUnknownInput(b.id,action,'resolve-B');expect(scheduler.takeNext(f.c.id)).toBeNull();expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);
 const task=f.tasks.getTask({userId:'local'},f.task.id),retry=await f.manager.retryTask(task.id,task.revision,'retry-A');
 expect(retry.routing?.executionConversationId).not.toBe(f.c.id);await vi.waitFor(()=>expect(f.starts).toEqual(['goal']));
 expect(f.nativeCalls).toEqual([{method:'startThread',id:'fresh-session'}]);
});

test('F2 input dismissal rolls back the occupancy marker with its local cancellation',()=>{
 const f=setup(),scheduler=createTaskScheduler(f.store,f.tasks,{principal:{userId:'local'}}),b=scheduler.enqueueUserInput(f.c.id,'B','B');
 f.store.database.prepare("UPDATE task_user_inputs SET state='unknown' WHERE id=?").run(b.id);
 const fault=vi.spyOn(f.store,'enqueueOutbox').mockImplementation(()=>{throw new Error('transaction crash');});
 expect(()=>scheduler.resolveUnknownInput(b.id,'dismiss','dismiss-B')).toThrow('transaction crash');fault.mockRestore();
 expect(scheduler.listUserInputs(f.c.id)[0].state).toBe('unknown');expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toEqual([]);
 scheduler.resolveUnknownInput(b.id,'dismiss','dismiss-B');expect(scheduler.listUserInputs(f.c.id)[0].state).toBe('cancelled');
 expect(f.store.database.prepare('SELECT kind,claim_id FROM task_native_uncertainty').all()).toEqual([{kind:'input',claim_id:b.id}]);
});
test('F2 internal Run abandonment persists occupancy atomically without native terminal evidence',async()=>{
 const f=setup(),p={userId:'local'};f.store.database.prepare("UPDATE task_runs SET state='unknown' WHERE id=?").run(f.run.id);
 const task=f.tasks.getTask(p,f.task.id),fault=vi.spyOn(f.store,'enqueueOutbox').mockImplementation(()=>{throw new Error('transaction crash');});
 expect(()=>f.tasks.abandonUnknown(p,f.run.id,task.revision)).toThrow('transaction crash');fault.mockRestore();
 expect(f.tasks.getRunControl(p,f.run.id).state).toBe('unknown');expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toEqual([]);
 f.tasks.abandonUnknown(p,f.run.id,task.revision);expect(f.tasks.getRunControl(p,f.run.id).state).toBe('interrupted');
 expect(f.store.database.prepare('SELECT kind,claim_id FROM task_native_uncertainty').all()).toEqual([{kind:'run',claim_id:f.run.id}]);
 const m=f.restart();await m.reconcileRuns('local');const current=f.tasks.getTask(p,f.task.id),retry=await m.retryTask(task.id,current.revision,'retry-abandoned');
 expect(retry.routing?.executionConversationId).not.toBe(f.c.id);expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);
});
test('F2 cancelled input occupancy is cleared only by its own exact inspected terminal identity',async()=>{
 const f=setup(),identity={runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'};
 f.tasks.bindRunIdentity(identity);f.tasks.applyRunEvent({...identity,eventKey:'terminal:old',outcome:'failed',summary:'failed',artifactVersions:[]});
 f.store.appendEvent(f.c.id,'metadata',{execution:'started',runId:f.run.id});f.store.updateConversation(f.c.id,{nativeId:'session',turnId:'old-turn'});
 const scheduler=createTaskScheduler(f.store,f.tasks,{principal:{userId:'local'}}),b=scheduler.enqueueUserInput(f.c.id,'B','B');
 f.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(b.id);scheduler.bindInputInvocation(b.id,'invocation-B','session','turn-B');
 scheduler.reconcileInput(b.id,false);scheduler.resolveUnknownInput(b.id,'dismiss','dismiss-B');let m=f.restart();await m.reconcileRuns('local');
 expect(canReleaseNativeOccupancy(f.store,f.c.id)).toBe(false);expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toHaveLength(1);
 f.setOutcome('succeeded');m=f.restart();await m.reconcileRuns('local');expect(f.store.database.prepare('SELECT claim_id FROM task_native_uncertainty').all()).toEqual([]);
 expect(m.listUserInputs(f.c.id)[0].state).toBe('cancelled');expect(f.starts).toEqual([]);
 expect(f.inspections).toEqual([1,2].map(()=>({runId:'invocation-B',hostId:'local',nativeSessionId:'session',nativeTurnId:'turn-B'})));
});

test('recreated manager retains unknown directory claim until exact native inspection confirms its turn',async()=>{
 const f=setup(),resources=createTaskResources(f.store);
 f.tasks.bindRunIdentity({runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'});
 resources.claim({kind:'run',id:f.run.id,conversationId:f.c.id},[f.home],'write');resources.submitted('run',f.run.id,f.run.id,'session');resources.bindTurn('run',f.run.id,f.run.id,'session','old-turn');
 await f.restart().reconcileRuns('local');expect(resources.claimDirectory('waiting',f.home,'write')).toBe('queued');
 expect(f.inspections).toContainEqual({runId:f.run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'old-turn'});
 expect(f.starts).toEqual([]);
 f.setOutcome('failed');await f.restart().reconcileRuns('local');
 expect(resources.claimDirectory('waiting',f.home,'write')).toBe('granted');expect(f.starts).toEqual([]);
});
