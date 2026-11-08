import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
const owner={userId:'local'},clean:(()=>void)[]=[];
afterEach(()=>clean.splice(0).forEach(f=>f()));
function setup(){const home=mkdtempSync(join(tmpdir(),'task-agent-actions-')),store=openStore(home),tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return {store,tasks};}
test.each(['creator','assignee','participant'] as const)('authorized %s Agent can finish and reopen a task with actor attribution and no execution',role=>{
 const {tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(role==='creator'?agent:owner,{goal:'Human or Agent objective',assigneeAgentId:role==='assignee'?'a':null,participantAgentIds:role==='participant'?['a']:[]},'new');
 const done=tasks.moveTask(agent,task.id,task.revision,'completed',null,'finish');expect(done).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a'},futureAutoResume:false});
 expect(tasks.moveTask(agent,task.id,task.revision,'completed',null,'finish')).toEqual(done);
 const reopened=tasks.moveTask(agent,task.id,done.revision,'todo',null,'reopen');expect(reopened).toMatchObject({state:'todo',completion:null});expect(tasks.listRuns(agent,task.id)).toEqual([]);
 expect(()=>tasks.moveTask(agent,task.id,done.revision,'completed',null,'stale')).toThrow(expect.objectContaining({code:'revision_conflict'}));
});
test('task actions retain owner and Agent ACL even when the ID or a completed command key is known',()=>{
 const {tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(owner,{goal:'Private',participantAgentIds:['a']},'new');
 const done=tasks.moveTask(agent,task.id,1,'completed',null,'finish');
 for(const actor of [{userId:'foreign',agentId:'a'},{...owner,agentId:'b'}])expect(()=>tasks.moveTask(actor,task.id,done.revision,'todo',null,'finish')).toThrow(expect.objectContaining({code:'forbidden'}));
 tasks.updateTask(owner,task.id,done.revision,{participantAgentIds:[]},'revoke');expect(()=>tasks.moveTask(agent,task.id,1,'completed',null,'finish')).toThrow(expect.objectContaining({code:'forbidden'}));
});
test('review, accept and mark completed cannot conceal a pending execution or approval',()=>{
 const {tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(owner,{goal:'Executing',assigneeAgentId:'a'},'new'),run=tasks.startTask(owner,task.id,1,'start');
 const current=tasks.getTask(owner,task.id);
 for(const action of ['complete','accept'] as const)expect(()=>tasks.userCommand(agent,task.id,current.revision,action,null,undefined,action)).toThrow(expect.objectContaining({code:'task_run_active'}));
 expect(()=>tasks.moveTask(agent,task.id,current.revision,'completed',null,'finish')).toThrow(expect.objectContaining({code:'task_run_active'}));expect(tasks.getRun(owner,run.id).state).toBe('queued');expect(tasks.getTask(owner,task.id)).toEqual(current);
});
test('accepting then reopening a task invalidates its retained auto-resume receipts',()=>{
 const {store,tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(agent,{goal:'Coordinator',assigneeAgentId:'a'},'goal'),run=tasks.startTask(owner,task.id,1,'execute');
 tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t'});tasks.applyRunEvent({runId:run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t',eventKey:'done',outcome:'succeeded',summary:'Result',artifactVersions:[]});
 store.database.prepare('UPDATE work_tasks SET future_auto_resume=1 WHERE id=?').run(task.id);store.database.prepare("UPDATE task_receipts SET captured_epoch=0,policy='resume',delivery_state='pending' WHERE source_run_id=?").run(run.id);
 const done=tasks.moveTask(agent,task.id,tasks.getTask(owner,task.id).revision,'completed',null,'finish');expect(done.continuationEpoch).toBe(1);expect(tasks.listReceipts(agent,task.id)[0].deliveryState).toBe('parked');
 const reopened=tasks.moveTask(agent,task.id,done.revision,'todo',null,'reopen');expect(reopened).toMatchObject({continuationEpoch:2,futureAutoResume:false});expect(tasks.listReceipts(agent,task.id)[0]).toMatchObject({executionId:run.executionId,capturedEpoch:0,deliveryState:'parked'});
});

test('creation source uses the actual creator or trusted coordination origin, never the assignee',()=>{
 const {store,tasks}=setup(),user=tasks.createTask(owner,{goal:'User goal',assigneeAgentId:'a'},'user'),agent=tasks.createTask({...owner,agentId:'a'},{goal:'Agent goal',assigneeAgentId:null},'agent'),system=tasks.createTask(owner,{goal:'Coordinator'},'coordinate:source:user-event','system');
 const legacy=tasks.createTask(owner,{goal:'Legacy'},'legacy');store.database.prepare('UPDATE work_tasks SET legacy_id=? WHERE id=?').run('old-task',legacy.id);store.database.prepare('DELETE FROM task_creation_sources WHERE task_id=?').run(legacy.id);
 const spoofed=tasks.createTask(owner,{goal:'Not a coordinator'},'coordinate:spoofed');expect(spoofed.creationSource).toBe('user');expect(tasks.getTask(owner,user.id).creationSource).toBe('user');expect(tasks.getTask(owner,agent.id).creationSource).toBe('agent');expect(tasks.getTask(owner,system.id).creationSource).toBe('system');expect(tasks.getTask(owner,legacy.id).creationSource).toBe('unknown');
});
test.each(['succeeded','failed','interrupted','recovered','stale','active-execution','missing-delivery'] as const)('own Run explicit completion intent finalizes only current settled success: %s',outcome=>{
 const {store,tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(owner,{goal:'Executor-owned goal',assigneeAgentId:'a'},'new'),run=tasks.startTask(owner,task.id,1,'start'),identity={runId:run.id,hostId:'local',nativeSessionId:'own-session',nativeTurnId:'own-turn'};tasks.bindRunIdentity(identity);
 const current=tasks.getTask(agent,task.id),bound={...agent,runId:run.id};
 const requested=tasks.requestCompletion(bound,task.id,current.revision,'request-finish');expect(requested).toMatchObject({state:'running',completion:null,completionRequested:true});expect(tasks.getRun(owner,run.id).state).toBe('running');
 expect(tasks.requestCompletion(bound,task.id,current.revision,'request-finish')).toEqual(requested);
 if(outcome==='stale')tasks.updateTask(owner,task.id,current.revision,{goal:'Changed goal'},'new-goal');
 if(outcome==='active-execution'){const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),prepared=tasks.prepareStart(owner,task.id,current.revision,'parallel',undefined,{agentId:'a'});store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));tasks.requestCompletion(bound,task.id,tasks.getTask(owner,task.id).revision,'intent-with-sibling');}
 if(outcome==='recovered')tasks.markUnknown(run.id);
 tasks.applyRunEvent({...identity,eventKey:'terminal-own',outcome:outcome==='failed'||outcome==='interrupted'?outcome:'succeeded',summary:outcome==='missing-delivery'?'':'Final delivery',artifactVersions:[]});
 const finished=tasks.getTask(owner,task.id);if(outcome==='succeeded'||outcome==='recovered'){expect(finished).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a',sourceRunId:run.id}});expect(tasks.getRun(owner,run.id).completion).toMatchObject({completedBy:'agent'});}else expect(finished.state).not.toBe('completed');if(outcome==='active-execution'){expect(finished.state).toBe('running');expect(tasks.listRuns(owner,task.id).map(item=>item.state)).toEqual(['succeeded','queued']);}
 expect(store.database.prepare('SELECT * FROM task_completion_intents WHERE run_id=?').get(run.id)).toBeUndefined();
});

test('stopping own Run removes completion intent and late success cannot finish or wake it',()=>{
 const {store,tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(owner,{goal:'Stop own goal',assigneeAgentId:'a'},'new'),run=tasks.startTask(owner,task.id,1,'start'),identity={runId:run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t'};tasks.bindRunIdentity(identity);
 const current=tasks.getTask(agent,task.id);tasks.requestCompletion({...agent,runId:run.id},task.id,current.revision,'finish');tasks.stopTask(owner,task.id,current.revision);
 expect(store.database.prepare('SELECT * FROM task_completion_intents WHERE run_id=?').get(run.id)).toBeUndefined();expect(tasks.applyRunEvent({...identity,eventKey:'late',outcome:'succeeded',summary:'Late result',artifactVersions:[]})).toBe('duplicate');expect(tasks.getTask(owner,task.id)).toMatchObject({state:'waiting',waitingReason:'interrupted',completion:null,futureAutoResume:false});
});
test.each(['move','command'] as const)('reopening historical completed goals invalidates retained continuations through %s',route=>{
 const {store,tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(agent,{goal:'Historical completed'},'new');store.database.prepare("UPDATE work_tasks SET state='completed',future_auto_resume=1,completion=? WHERE id=?").run(JSON.stringify({completedBy:'user',sourceRunId:null,artifactVersions:[],acceptedAt:'2020-01-01'}),task.id);
 const reopened=route==='move'?tasks.moveTask(agent,task.id,1,'todo',null,'reopen'):tasks.userCommand(agent,task.id,1,'reopen',null,undefined,'reopen');expect(reopened).toMatchObject({state:'todo',completion:null,futureAutoResume:false,continuationEpoch:1});
});

test.each(['unproven','wrong-identity','proven','stale','stopped'] as const)('uncertain completion intent needs exact native proof and unchanged authority: %s',mode=>{
 const {store,tasks}=setup(),agent={...owner,agentId:'a'},task=tasks.createTask(owner,{goal:'Recover explicit completion',assigneeAgentId:'a'},'new'),run=tasks.startTask(owner,task.id,1,'start'),identity={runId:run.id,hostId:'local',nativeSessionId:'recover-session',nativeTurnId:'recover-turn'};tasks.bindRunIdentity(identity);const current=tasks.getTask(owner,task.id);tasks.requestCompletion({...agent,runId:run.id},task.id,current.revision,'intent');tasks.markUnknown(run.id);expect(tasks.getTask(owner,task.id)).toMatchObject({state:'waiting',completion:null});expect(tasks.listRuns(owner,task.id)).toHaveLength(1);
 if(mode==='stale')tasks.updateTask(owner,task.id,tasks.getTask(owner,task.id).revision,{goal:'Changed after uncertainty'},'edit');
 if(mode==='stopped')tasks.stopTask(owner,task.id,tasks.getTask(owner,task.id).revision);
 const reconstructed=createTasks(store);
 if(mode==='wrong-identity')expect(reconstructed.applyRunEvent({...identity,nativeTurnId:'another-turn',eventKey:'forged-proof',outcome:'succeeded',summary:'Not this turn',artifactVersions:[]})).toBe('unmatched');
 else if(mode!=='unproven')reconstructed.applyRunEvent({...identity,eventKey:'exact-proof',outcome:'succeeded',summary:'Verified final delivery',artifactVersions:[]});
 if(mode==='proven')expect(reconstructed.getTask(owner,task.id)).toMatchObject({state:'completed',completion:{completedBy:'agent',completedByAgentId:'a',sourceRunId:run.id}});else expect(reconstructed.getTask(owner,task.id).state).not.toBe('completed');
 expect(reconstructed.listRuns(owner,task.id)).toHaveLength(1);
});
