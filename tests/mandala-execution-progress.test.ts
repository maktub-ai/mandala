import {ensureConfiguredMandala} from './configured-mandala';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {createTasks} from '../server/tasks';
import {createMandalaCoordination} from '../server/mandala-coordination';

import {ensureMandalaConversation} from '../server/mandala';
import type {Task,Run,TaskExecution} from '../shared/tasks';
let home:string,store:Store,tasks:ReturnType<typeof createTasks>,goal:Task;
const root=()=>({userId:store.ownerUserId});
beforeEach(async()=>{
 home=await mkdtemp(join(tmpdir(),'mandala-execution-progress-'));store=openStore(home);
 tasks=createTasks(store,{resolve:(_p,task)=>({agentId:task.assigneeAgentId!,projectId:task.projectId,hostId:'host',input:task.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const {config}=await ensureConfiguredMandala(home),chat=ensureMandalaConversation(store,config);
 goal=await createMandalaCoordination({home,store,tasks}).create({agentId:chat.agentId,conversationId:chat.id,invocationId:'current'},{goal:'Investigate',criteria:[{id:'answer',text:'Return evidence',checkRef:null}],projectId:null},'goal');
});
afterEach(async()=>{store.close();await rm(home,{recursive:true,force:true});});
const read=()=>tasks.getTask(root(),goal.id);
function execution(key='worker'){const chat=store.createConversation({agentId:key,projectId:'',cli:'codex',model:null});return tasks.createExecution(root(),goal.id,{conversationId:chat.id,agentId:key,projectId:null,request:'Investigate '+key},key);}
function start(item:TaskExecution,key='start'){const prepared=tasks.prepareStart(root(),goal.id,read().revision,key,undefined,{executionId:item.id}),run=store.transaction(()=>prepared.commit({executionConversationId:item.conversationId,mode:'dedicated',destinationConversationId:goal.originConversationId}));tasks.bindRunIdentity(identity(run));return run;}
const identity=(run:Run)=>({runId:run.id,hostId:'host',nativeSessionId:run.id,nativeTurnId:'turn'});
function finish(run:Run,outcome:'succeeded'|'failed'='succeeded'){tasks.applyRunEvent({...identity(run),outcome,summary:'Evidence delivered',artifactVersions:[],eventKey:'finish-'+run.id});}
it('reflects execution delivery without implicitly accepting the task',()=>{const run=start(execution());expect(read()).toMatchObject({state:'running',completion:null});finish(run);expect(read()).toMatchObject({state:'review',completion:null});expect(tasks.userCommand(root(),goal.id,read().revision,'accept').state).toBe('completed');});
it('waits for every execution before review while preserving parallel activity',()=>{const first=execution('first'),second=execution('second'),a=start(first,'a'),b=start(second,'b');finish(a);expect(read()).toMatchObject({state:'running',completion:null});finish(b);expect(read().state).toBe('review');});
it('ignores never-run execution in aggregation and retains it as undelivered metadata',()=>{const first=execution('first'),unused=execution('second');finish(start(first));expect(read()).toMatchObject({state:'review',waitingReason:null,completion:null});expect(tasks.getExecution(root(),unused.id).latestRun).toBeNull();});
it('surfaces failed work without losing another active execution',()=>{const a=start(execution('first'),'a'),b=start(execution('second'),'b');finish(a,'failed');expect(read().state).toBe('running');finish(b);expect(read()).toMatchObject({state:'waiting',waitingReason:'run_failed',completion:null});});
it('approval and uncertainty remain active execution facts',()=>{const run=start(execution());tasks.setRunApproval(identity(run),true);expect(read().state).toBe('running');tasks.setRunApproval(identity(run),false);tasks.markUnknown(run.id);expect(tasks.getRunControl(root(),run.id).state).toBe('unknown');finish(run,'failed');expect(read()).toMatchObject({state:'waiting',waitingReason:'run_failed'});});
it.each(['completed','cancelled'] as const)('preserves a %s task when delayed execution evidence arrives',state=>{const run=start(execution()),completion=state==='completed'?{completedBy:'user',sourceRunId:null,artifactVersions:[],acceptedAt:new Date().toISOString()}:null;store.database.prepare('UPDATE work_tasks SET state=?,waiting_reason=NULL,completion=? WHERE id=?').run(state,completion?JSON.stringify(completion):null,goal.id);finish(run);expect(read()).toMatchObject({state,completion});});
it('only the latest run per execution contributes to progress',()=>{const item=execution(),first=start(item);finish(first,'failed');const second=start(item,'retry');finish(second);expect(read()).toMatchObject({state:'review',completion:null});expect(tasks.listRuns(root(),goal.id)).toHaveLength(2);});
it('a returned delivery can run again without retaining stale success',()=>{const item=execution(),first=start(item);finish(first);tasks.userCommand(root(),goal.id,read().revision,'request_changes','Add evidence');const second=start(item,'retry');finish(second,'failed');expect(read()).toMatchObject({state:'waiting',waitingReason:'run_failed',completion:null});});
it('task cancellation stops all parallel executions and keeps their reports parked',()=>{const a=start(execution('first'),'a'),b=start(execution('second'),'b');const result=tasks.stopTask(root(),goal.id,read().revision,true);expect(result.runs?.map(run=>run.id).sort()).toEqual([a.id,b.id].sort());expect(read().state).toBe('cancelled');expect(tasks.listRuns(root(),goal.id).every(run=>run.state==='interrupted')).toBe(true);expect(tasks.listReceipts(root(),goal.id).every(receipt=>receipt.deliveryState==='parked')).toBe(true);});
it('rolls back run and task state when its queued event cannot be saved',()=>{const item=execution();store.database.exec("CREATE TRIGGER fail_execution_progress BEFORE INSERT ON outbox WHEN NEW.type='task.run_queued' BEGIN SELECT RAISE(ABORT,'injected'); END");expect(()=>start(item)).toThrow();expect(tasks.listRuns(root(),goal.id)).toEqual([]);expect(read()).toMatchObject({state:'todo',revision:1});});
