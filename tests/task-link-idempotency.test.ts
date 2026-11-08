import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,expect,test}from'vitest';
import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{openStore}from'../server/store';import{createTasks}from'../server/tasks';
const p={userId:'local'},cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(){const home=mkdtempSync(join(tmpdir(),'task-link-key-')),store=openStore(home),tasks=createTasks(store);cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});const chat=(agentId='a')=>store.createConversation({projectId:'p',agentId,cli:'codex',model:null});return{store,tasks,chat};}
test('execution attach and removal replay preserve later relations and revisions',()=>{
 const{tasks,chat,store}=setup(),a=chat(),b=chat(),task=tasks.createTask(p,{goal:'Goal'},'create');
 const linked=tasks.attachExecution(p,task.id,task.revision,a.id,'link-a');
 const withB=tasks.attachExecution(p,task.id,linked.revision,b.id,'link-b');
 const beforeOutbox=store.listOutbox(0).length;
 expect(tasks.attachExecution(p,task.id,1,a.id,'link-a')).toEqual(withB);expect(store.listOutbox(0)).toHaveLength(beforeOutbox);
 const removed=tasks.removeExecution(p,task.id,withB.revision,linked.executions[0].id,'unlink-a');
 const edited=tasks.updateTask(p,task.id,removed.revision,{goal:'Updated goal'},'edit');
 const restored=tasks.attachExecution(p,task.id,edited.revision,a.id,'relink-a');
 const after=store.listOutbox(0).length;
 expect(tasks.removeExecution(p,task.id,withB.revision,linked.executions[0].id,'unlink-a')).toEqual(restored);expect(store.listOutbox(0)).toHaveLength(after);
});
test('real semantic payload conflicts and stale revisions remain rejected',()=>{
 const{tasks,chat}=setup(),a=chat(),b=chat(),task=tasks.createTask(p,{goal:'Goal'},'create');
 const linked=tasks.attachExecution(p,task.id,1,a.id,'key');
 for(const [revision,id,linkedValue]of [[1,b.id,true],[2,a.id,true],[1,a.id,false]] as const)expect(()=>linkedValue?tasks.attachExecution(p,task.id,revision,id,'key'):tasks.removeExecution(p,task.id,revision,linked.executions[0].id,'key')).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
 expect(()=>tasks.attachExecution(p,task.id,1,b.id,'stale')).toThrow(expect.objectContaining({code:'revision_conflict'}));
 for(const revision of [0,-1,NaN,Infinity,1.1])expect(()=>tasks.attachExecution(p,task.id,revision,b.id,'invalid')).toThrow(expect.objectContaining({status:422}));
 expect(tasks.getTask(p,task.id)).toEqual(linked);
});
test('Task permission revocation blocks replay and new attachments validate only added conversation access',()=>{
 const{store,chat}=setup(),foreign=chat('a'),own=chat('b'),denied=chat('a');
 const tasks=createTasks(store),task=createTaskWithExecutions(store,tasks,p,{goal:'Shared goal',participantAgentIds:['b']},[foreign.id],'create'),b={...p,agentId:'b'};
 const linked=tasks.attachExecution(b,task.id,1,own.id,'link-own');expect(linked.conversationIds).toEqual([own.id]);
 expect(()=>tasks.attachExecution(b,task.id,linked.revision,denied.id,'denied')).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(linked.conversationIds).toEqual([own.id]);
 const removed=tasks.removeExecution(p,task.id,linked.revision,tasks.getTask(p,task.id).executions.find(e=>e.conversationId===foreign.id)!.id,'remove-foreign');expect(removed.conversationIds).toEqual([own.id]);
 const cleared=tasks.removeExecution(p,task.id,removed.revision,removed.executions[0].id,'remove-own');tasks.updateTask(p,task.id,cleared.revision,{participantAgentIds:[]},'revoke');
 expect(()=>tasks.attachExecution(b,task.id,1,own.id,'link-own')).toThrow(expect.objectContaining({code:'forbidden'}));
});
test('execution attachment transactions roll back relation, revision, receipt and outbox on failure',()=>{
 const{tasks,store,chat}=setup(),a=chat(),task=tasks.createTask(p,{goal:'Goal'},'create'),before=store.listOutbox(0);
 store.database.exec("CREATE TRIGGER fail_link_outbox BEFORE INSERT ON outbox WHEN NEW.type='task.execution_added' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(()=>tasks.attachExecution(p,task.id,1,a.id,'link')).toThrow();expect(tasks.getTask(p,task.id)).toEqual(task);expect(store.listOutbox(0)).toEqual(before);
 expect(store.database.prepare('SELECT command_key FROM task_command_dedup WHERE command_key=?').get('link')).toBeUndefined();
});
