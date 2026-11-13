import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
const p={userId:'local'},clean:(()=>void)[]=[];
afterEach(()=>clean.splice(0).forEach(f=>f()));
function setup(){const home=mkdtempSync(join(tmpdir(),'task-progress-domain-')),store=openStore(home);const tasks=createTasks(store,{authorizeConversation:(actor,id)=>{if(actor.userId!=='local'||store.getConversation(id)?.agentId==='private')throw Error('conversation denied');}});clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return {store,tasks};}
test('optional fields stay empty; participants and execution Chats have distinct ownership',()=>{
 const {store,tasks}=setup(),a=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),b=store.createConversation({projectId:'p',agentId:'b',cli:'codex',model:null});
 const task=tasks.createTask(p,{goal:'Long-term goal'},'new');expect(task).toMatchObject({criteria:[],projectId:null,assigneeAgentId:null,participantAgentIds:[],conversationIds:[]});
 const patch={participantAgentIds:['a','b'],goal:'Edited goal'};
 tasks.updateTask(p,task.id,1,patch,'edit');const first=tasks.createExecution(p,task.id,{conversationId:a.id,agentId:'a',projectId:'p',request:'First'},'first');tasks.createExecution(p,task.id,{conversationId:b.id,agentId:'b',projectId:'p',request:'Second'},'second');const registered=tasks.getTask(p,task.id);expect(registered).toMatchObject({...patch,revision:2,projectId:null,assigneeAgentId:null});
 expect([...registered.conversationIds].sort()).toEqual([a.id,b.id].sort());
 expect(tasks.updateTask(p,task.id,1,patch,'edit')).toEqual(registered);expect(tasks.listLinkedTasks(p,a.id).map(t=>t.id)).toEqual([task.id]);
 expect(tasks.getTask({...p,agentId:'b'},task.id).id).toBe(task.id);
 expect(tasks.listTasks({...p,agentId:'b'}).map(task=>task.id)).toEqual([task.id]);expect(tasks.listTasks({...p,agentId:'unrelated'})).toEqual([]);
 expect(()=>tasks.updateTask(p,task.id,1,{goal:'Stale'},'stale')).toThrow(expect.objectContaining({code:'revision_conflict'}));
 expect(()=>tasks.updateTask(p,task.id,2,{goal:'Conflicting'},'edit')).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
 tasks.removeExecution(p,task.id,2,first.id,'remove');expect(tasks.listLinkedTasks(p,a.id)).toEqual([]);
});
test('explicit user review and acceptance work without execution or criteria for every legacy acceptance',()=>{
 const {tasks}=setup();for(const acceptance of ['human','checks','delivery'] as const){const task=tasks.createTask(p,{goal:acceptance,acceptance},acceptance);
 const review=tasks.userCommand(p,task.id,1,'complete');expect(review.state).toBe('review');expect(review.completion).toBeNull();
 expect(tasks.userCommand(p,task.id,review.revision,'accept')).toMatchObject({state:'completed',completion:{completedBy:'user',sourceRunId:null,artifactVersions:[]}});}
});
test('association authorization rolls back every edit including origin changes',()=>{
 const {store,tasks}=setup(),task=tasks.createTask(p,{goal:'Goal'},'task');
 const denied=store.createConversation({projectId:'p',agentId:'private',cli:'codex',model:null});
 expect(()=>tasks.attachExecution(p,task.id,1,denied.id,'denied')).toThrow('conversation denied');expect(tasks.getTask(p,task.id).goal).toBe('Goal');
 expect(()=>tasks.updateTask(p,task.id,1,{originConversationId:denied.id},'origin-denied')).toThrow('conversation denied');
 expect(()=>tasks.attachExecution(p,task.id,1,'missing','missing')).toThrow(expect.objectContaining({code:'conversation_not_found'}));
});
test('progress applies only exact links, revision and full execution snapshot under transactional source guard',()=>{
 const {store,tasks}=setup(),chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),executionChat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const task=createTaskWithExecutions(store,tasks,p,{goal:'Goal'},[chat.id],'goal');
 const [snapshot]=tasks.snapshotProgress(p,chat.id);expect(snapshot.executions).toMatchObject([{conversationId:chat.id,latestRun:null}]);
 expect(tasks.applyTaskProgress(p,snapshot,'review',()=>{expect(store.database.isTransaction).toBe(true);return false;})).toBe(false);
 const execution=tasks.createExecution(p,task.id,{conversationId:executionChat.id,agentId:'a',projectId:'p',request:'Collect evidence'},'execution');
 expect(tasks.applyTaskProgress(p,snapshot,'review',()=>true)).toBe(false);
 const [fresh]=tasks.snapshotProgress(p,chat.id);expect(fresh.executions).toEqual(expect.arrayContaining([expect.objectContaining({id:execution.id,conversationId:executionChat.id,request:'Collect evidence',latestRun:null})]));
 expect(tasks.applyTaskProgress(p,fresh,'waiting',()=>true)).toBe(true);expect(tasks.getTask(p,task.id)).toMatchObject({state:'waiting',waitingReason:'input'});
 const [waiting]=tasks.snapshotProgress(p,chat.id);expect(tasks.applyTaskProgress(p,waiting,'review',()=>true)).toBe(true);
 const current=tasks.getTask(p,task.id);tasks.userCommand(p,task.id,current.revision,'accept');expect(tasks.applyTaskProgress(p,waiting,'running',()=>true)).toBe(false);expect(tasks.snapshotProgress(p,chat.id)).toEqual([]);
});
test('unlink, task edits and new executions invalidate progress; repeated state has no revision churn',()=>{
 const {store,tasks}=setup(),chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),task=createTaskWithExecutions(store,tasks,p,{goal:'Goal'},[chat.id],'new');
 const [initial]=tasks.snapshotProgress(p,chat.id);tasks.updateTask(p,task.id,1,{goal:'Edited'},'edit');expect(tasks.applyTaskProgress(p,initial,'review',()=>true)).toBe(false);
 const [edited]=tasks.snapshotProgress(p,chat.id),executionChat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});tasks.createExecution(p,task.id,{conversationId:executionChat.id,agentId:'a',projectId:'p',request:'New work'},'execution');expect(tasks.applyTaskProgress(p,edited,'review',()=>true)).toBe(false);
 const [current]=tasks.snapshotProgress(p,chat.id);expect(tasks.applyTaskProgress(p,current,'todo',()=>true)).toBe(false);expect(tasks.getTask(p,task.id).revision).toBe(2);
 tasks.removeExecution(p,task.id,2,task.executions[0].id,'remove');expect(tasks.applyTaskProgress(p,current,'review',()=>true)).toBe(false);
});
test('explicit links persist and additive migration never rewrites historical completed records',()=>{
 const {store,tasks}=setup(),chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),task=createTaskWithExecutions(store,tasks,p,{goal:'Old goal',participantAgentIds:['b']},[chat.id],'new');
 const historical={completedBy:'delivery',sourceRunId:null,artifactVersions:[],acceptedAt:'2025-01-01T00:00:00Z'};
 store.database.prepare("UPDATE work_tasks SET state='completed',completion=? WHERE id=?").run(JSON.stringify(historical),task.id);
 const reopened=createTasks(store);expect(reopened.getTask(p,task.id)).toMatchObject({state:'completed',completion:historical,revision:1,participantAgentIds:['b'],conversationIds:[chat.id]});
 expect(reopened.snapshotProgress(p,chat.id)).toEqual([]);
});
test('Agent may explicitly select review but cannot complete or resurrect user-terminal task',()=>{
 const {tasks}=setup(),agent={...p,agentId:'a'},task=tasks.createTask(agent,{goal:'Goal'},'new');
 const review=tasks.updateTask(agent,task.id,1,{state:'review'},'review');expect(review.state).toBe('review');
 expect(()=>tasks.updateTask(agent,task.id,review.revision,{state:'completed'} as never,'completed')).toThrow(expect.objectContaining({code:'invalid_task'}));
 const accepted=tasks.userCommand(p,task.id,review.revision,'accept');expect(()=>tasks.updateTask(agent,task.id,accepted.revision,{state:'running'},'wake')).toThrow(expect.objectContaining({code:'task_terminal'}));
});
test('participant metadata edits do not require reading existing other-Agent conversations, but new links do',()=>{
 const {store}=setup(),a=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),other=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const tasks=createTasks(store,{authorizeConversation:(actor,id)=>{if(actor.agentId&&store.getConversation(id)?.agentId!==actor.agentId)throw Error('conversation denied');}});
 const task=createTaskWithExecutions(store,tasks,p,{goal:'Shared goal',participantAgentIds:['a','b']},[a.id],'create'),b={...p,agentId:'b'};
 expect(tasks.updateTask(b,task.id,1,{goal:'Progressed shared goal'},'edit')).toMatchObject({goal:'Progressed shared goal',conversationIds:[]});
 expect(()=>tasks.attachExecution(b,task.id,2,other.id,'attach')).toThrow('conversation denied');
 expect(tasks.getTask(b,task.id).revision).toBe(2);
});

test('per-task progress preference persists and invalidates already running evaluations',()=>{
 const {store,tasks}=setup(),chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const task=createTaskWithExecutions(store,tasks,p,{goal:'Manual progress',automaticProgress:false},[chat.id],'manual');
 expect(task.automaticProgress).toBe(false);expect(tasks.snapshotProgress(p,chat.id)).toEqual([]);
 const enabled=tasks.updateTask(p,task.id,task.revision,{automaticProgress:true},'enable');
 const [snapshot]=tasks.snapshotProgress(p,chat.id);expect(snapshot).toBeDefined();
 const disabled=tasks.updateTask(p,task.id,enabled.revision,{automaticProgress:false},'disable');
 expect(tasks.applyTaskProgress(p,snapshot,'review')).toBe(false);
 expect(createTasks(store).getTask(p,task.id).automaticProgress).toBe(false);
 expect(()=>tasks.updateTask(p,task.id,disabled.revision,{automaticProgress:'yes'} as never,'bad')).toThrow();
});

test('board transitions are atomic, revision guarded, and do not create execution',()=>{
 const {store,tasks}=setup(),task=tasks.createTask(p,{goal:'Board goal'},'board');
 store.database.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON outbox WHEN NEW.type='task.accept' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(()=>tasks.moveTask(p,task.id,1,'completed',null,'move')).toThrow();expect(tasks.getTask(p,task.id)).toEqual(task);
 store.database.exec('DROP TRIGGER fail_accept');
 const done=tasks.moveTask(p,task.id,1,'completed',null,'move');expect(done.state).toBe('completed');
 expect(tasks.moveTask(p,task.id,1,'completed',null,'move')).toEqual(done);
 const reopened=tasks.moveTask(p,task.id,done.revision,'running',null,'reopen');expect(reopened.state).toBe('running');expect(tasks.listRuns(p,task.id)).toEqual([]);
 expect(()=>tasks.moveTask({...p,agentId:'a'},task.id,reopened.revision,'completed',null,'agent')).toThrow();
 expect(()=>tasks.moveTask(p,task.id,1,'waiting',null,'stale')).toThrow(expect.objectContaining({code:'revision_conflict'}));
});
