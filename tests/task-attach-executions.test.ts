import {DomainError} from '../shared/workspace-contracts';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {createTaskScheduler} from '../server/task-scheduler';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(fn=>fn()));
function setup(){const home=mkdtempSync(join(tmpdir(),'execution-attach-')),store=openStore(home),p={userId:store.ownerUserId},tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});const chat=(agentId='a')=>store.createConversation({agentId,projectId:'',cli:'codex',model:null});return {home,store,p,tasks,chat};}
test('attaches authorized Agent chats with derived instructions, readonly IDs and transactional replay',()=>{
 const {store,p,tasks,chat}=setup(),c=chat(),task=tasks.createTask(p,{goal:'Goal\nDetails'},'create');store.appendEvent(c.id,'user',{text:'First human request'});
 const attached=tasks.attachExecution(p,task.id,1,c.id,'attach');expect(attached).toMatchObject({revision:2,conversationIds:[c.id],executions:[{conversationId:c.id,agentId:'a',projectId:null,request:'First human request'}]});
 const edited=tasks.updateTask(p,task.id,2,{goal:'Edited'},'edit');expect(tasks.attachExecution(p,task.id,1,c.id,'attach')).toEqual(edited);
 expect(()=>tasks.attachExecution(p,task.id,2,c.id,'attach')).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
 const other=tasks.createTask(p,{goal:'Other'},'other');expect(()=>tasks.attachExecution(p,other.id,1,c.id,'foreign')).toThrow(expect.objectContaining({code:'execution_conversation_in_use'}));
});
test('rejects no Agent, primary, unreadable, stale and malformed attach requests',()=>{
 const {store,p,tasks,chat}=setup(),task=tasks.createTask(p,{goal:'Goal',participantAgentIds:['b']},'create'),plain=chat(''),primary=chat();store.database.prepare("UPDATE conversations SET data=json_set(data,'$.purpose','mandala-main') WHERE id=?").run(primary.id);
 expect(()=>tasks.attachExecution(p,task.id,1,plain.id,'plain')).toThrow(expect.objectContaining({code:'execution_agent_required'}));
 expect(()=>tasks.attachExecution(p,task.id,1,primary.id,'primary')).toThrow(expect.objectContaining({code:'primary_conversation'}));
 expect(()=>tasks.attachExecution({...p,agentId:'b'},task.id,1,chat().id,'denied')).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(()=>tasks.attachExecution(p,task.id,0,chat().id,'invalid')).toThrow(expect.objectContaining({status:422}));
 expect(()=>tasks.attachExecution(p,task.id,2,chat().id,'stale')).toThrow(expect.objectContaining({code:'revision_conflict'}));
});
test('removes only pristine executions and replays without removing a later attachment',()=>{
 const {p,tasks,chat}=setup(),c=chat(),task=tasks.createTask(p,{goal:'Goal'},'create'),attached=tasks.attachExecution(p,task.id,1,c.id,'attach'),execution=attached.executions[0];
 const removed=tasks.removeExecution(p,task.id,2,execution.id,'remove');expect(removed.conversationIds).toEqual([]);expect(removed.executions).toEqual([]);
 const restored=tasks.attachExecution(p,task.id,removed.revision,c.id,'restore');expect(tasks.removeExecution(p,task.id,2,execution.id,'remove')).toEqual(restored);
});
test.each(['native','event','status','hook','scope','pending','completed-input','cancelled-invocation','receipt','run'] as const)('rejects removal with %s execution history',kind=>{
 const {store,p,tasks,chat}=setup(),c=chat(),task=tasks.createTask(p,{goal:'Goal',assigneeAgentId:'a'},'create'),attached=tasks.attachExecution(p,task.id,1,c.id,'attach'),execution=attached.executions[0],queue=createTaskScheduler(store,tasks,{principal:p});
 if(kind==='native')store.updateConversation(c.id,{nativeId:'native-session'});
 if(kind==='status')store.appendEvent(c.id,'status',{status:'running'});
 if(kind==='hook')store.appendEvent(c.id,'hook',{type:'native-start'});
 if(kind==='scope'){store.database.exec('CREATE TABLE file_execution_scopes(invocation_id TEXT,user_id TEXT,agent_id TEXT,project_id TEXT,conversation_id TEXT)');store.database.prepare('INSERT INTO file_execution_scopes VALUES (?,?,?,?,?)').run('invocation',p.userId,'a',null,c.id);}
 if(kind==='cancelled-invocation'){const input=queue.enqueueUserInput(c.id,'Historical input','history');store.database.prepare("UPDATE task_user_inputs SET state='cancelled' WHERE id=?").run(input.id);store.database.prepare('INSERT INTO task_input_invocations VALUES (?,?,?,?,?)').run(input.id,'invocation','host','native','turn');}
 if(kind==='event')store.appendEvent(c.id,'text',{text:'Historical native response'});
 if(kind==='pending'||kind==='completed-input'){const input=queue.enqueueUserInput(c.id,'Input','input');if(kind==='completed-input')store.database.prepare("UPDATE task_user_inputs SET state='completed' WHERE id=?").run(input.id);}
 if(kind==='receipt')store.database.prepare("INSERT INTO task_receipts(id,task_id,destination_conversation_id,execution_id,policy,delivery_state,summary,artifact_versions,legacy_id,created_at) VALUES ('r',?,?,?,'notify','pending','Report','[]','legacy','now')").run(task.id,c.id,execution.id);
 if(kind==='run'){const prepared=tasks.prepareStart(p,task.id,2,'start',undefined,{executionId:execution.id});store.transaction(()=>prepared.commit({executionConversationId:c.id,mode:'existing',destinationConversationId:null}));}
 expect(()=>tasks.removeExecution(p,task.id,tasks.getTask(p,task.id).revision,execution.id,'remove')).toThrow(expect.objectContaining({code:'execution_has_history',status:409}));expect(tasks.getTask(p,task.id).conversationIds).toEqual([c.id]);
});
test('never-run executions do not block delivered sibling review',()=>{
 const {store,p,tasks,chat}=setup(),task=tasks.createTask(p,{goal:'Goal',assigneeAgentId:'a'},'create'),run=tasks.startTask(p,task.id,1,'start');tasks.attachExecution(p,task.id,2,chat().id,'unused');const identity={runId:run.id,hostId:'local',nativeSessionId:'native',nativeTurnId:'turn'};tasks.bindRunIdentity(identity);tasks.applyRunEvent({...identity,eventKey:'done',outcome:'succeeded',summary:'Delivered',artifactVersions:[]});expect(tasks.getTask(p,task.id)).toMatchObject({state:'review',waitingReason:null});
});
test('obsolete Task input is rejected rather than silently ignored',()=>{
 const {p,tasks}=setup();expect(()=>tasks.createTask(p,{goal:'Goal',conversationIds:[]} as any,'legacy')).toThrow(expect.objectContaining({code:'invalid_task'}));const task=tasks.createTask(p,{goal:'Goal'},'valid');expect(()=>tasks.updateTask(p,task.id,1,{conversationIds:[]} as any,'legacy-patch')).toThrow(expect.objectContaining({code:'invalid_task'}));
});
test.each([false,true])('linked-chat migration backs up before clearing and retains data if backup fails=%s',failure=>{
 const {home,store,p,tasks,chat}=setup(),c=chat(),task=tasks.createTask(p,{goal:'Legacy'},'legacy');store.database.exec('CREATE TABLE IF NOT EXISTS task_conversation_links(task_id TEXT,conversation_id TEXT)');store.database.prepare('INSERT INTO task_conversation_links VALUES (?,?)').run(task.id,c.id);
 if(failure){writeFileSync(join(home,'backups'),'blocked');expect(()=>createTasks(store)).toThrow();expect(tasks.getTask(p,task.id).goal).toBe('Legacy');return;}
 const migrated=createTasks(store);expect(migrated.listTasks(p)).toEqual([]);expect(store.getConversation(c.id)).toBeTruthy();const backups=readdirSync(join(home,'backups'));expect(backups).toHaveLength(1);const snapshot=new DatabaseSync(join(home,'backups',backups[0]));try{expect(snapshot.prepare('SELECT goal FROM work_tasks').get()?.goal).toBe('Legacy');}finally{snapshot.close();}expect(store.database.prepare("SELECT name FROM sqlite_master WHERE name='task_conversation_links'").get()).toBeUndefined();createTasks(store);expect(readdirSync(join(home,'backups'))).toEqual(backups);
});

test('all never-run executions leave task todo and expose no completed delivery',()=>{
 const {p,tasks,chat}=setup(),task=tasks.createTask(p,{goal:'Goal'},'create'),first=tasks.attachExecution(p,task.id,1,chat().id,'first'),second=tasks.attachExecution(p,task.id,first.revision,chat().id,'second');expect(second).toMatchObject({state:'todo',waitingReason:null,completion:null});expect(second.executions.every(execution=>execution.latestRun===null)).toBe(true);
});
test('execution-derived IDs follow current conversation authority on every service projection',()=>{
 const {store,p,chat}=setup(),c=chat();let denied=false;const tasks=createTasks(store,{authorizeConversation:()=>{if(denied)throw new DomainError('forbidden',403,'Revoked');}}),task=tasks.createTask(p,{goal:'Goal'},'create');tasks.attachExecution(p,task.id,1,c.id,'attach');denied=true;
 expect(tasks.getTask(p,task.id)).toMatchObject({executions:[],conversationIds:[]});expect(tasks.listTasks(p)[0]).toMatchObject({executions:[],conversationIds:[]});expect(tasks.updateTask(p,task.id,2,{goal:'Changed'},'edit')).toMatchObject({executions:[],conversationIds:[]});
});
test('attach and removal failures roll back revision, dedup and registry together',()=>{
 const {store,p,tasks,chat}=setup(),c=chat(),task=tasks.createTask(p,{goal:'Goal'},'create');store.database.exec("CREATE TRIGGER reject_execution_add BEFORE INSERT ON outbox WHEN NEW.type='task.execution_added' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(()=>tasks.attachExecution(p,task.id,1,c.id,'attach')).toThrow();expect(tasks.getTask(p,task.id)).toEqual(task);expect(store.database.prepare('SELECT command_key FROM task_command_dedup WHERE command_key=\'attach\'').get()).toBeUndefined();store.database.exec('DROP TRIGGER reject_execution_add');const attached=tasks.attachExecution(p,task.id,1,c.id,'attach');
 store.database.exec("CREATE TRIGGER reject_execution_remove BEFORE INSERT ON outbox WHEN NEW.type='task.execution_removed' BEGIN SELECT RAISE(ABORT,'injected'); END");expect(()=>tasks.removeExecution(p,task.id,2,attached.executions[0].id,'remove')).toThrow();expect(tasks.getTask(p,task.id)).toEqual(attached);expect(store.database.prepare('SELECT command_key FROM task_command_dedup WHERE command_key=\'remove\'').get()).toBeUndefined();
});
