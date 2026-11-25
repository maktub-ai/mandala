import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {taskNotifications} from '../server/task-notifications';
import {DomainError} from '../shared/workspace-contracts';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(fn=>fn()));
function fixture(){const home=mkdtempSync(join(tmpdir(),'task-notices-')),store=openStore(home),tasks=createTasks(store);clean.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});return {store,tasks};}
test('notification titles use only the exact authorized execution without exposing long instructions',()=>{
 const {store,tasks}=fixture(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'Long original instructions'},'title-task');
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});store.renameConversation(chat.id,'Billing collection check');
 const cursor=taskNotifications(store,tasks,p).cursor;
 const execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:task.goal},'execution');
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at) VALUES (?,?,?,1,'succeeded',?,?)").run('title-run',task.id,execution.id,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),new Date().toISOString());
 store.enqueueOutbox({type:'task.run_terminal',aggregateId:task.id,aggregateRevision:1,causationId:'title-result',payload:{taskId:task.id,runId:'title-run',state:'completed'}});
 expect(taskNotifications(store,tasks,p,cursor,()=>{}).items[0]).toMatchObject({title:'Billing collection check',state:'completed'});
 expect(taskNotifications(store,tasks,p,cursor,()=>{throw new DomainError('forbidden',403,'Forbidden');}).items[0].title).toBe('Long original instructions');
});
test('only meaningful authorized task transitions produce notices; cursor prevents repeats',()=>{
 const {store,tasks}=fixture(),p={userId:'u'},task=tasks.createTask(p,{goal:'Verify release',acceptance:'human'},'create');
 store.database.prepare("UPDATE work_tasks SET state='review' WHERE id=?").run(task.id);
 const first=taskNotifications(store,tasks,p);expect(first.items).toEqual([]);
 for(const [type,state] of [['task.progress','running'],['task.run_terminal','review'],['task.execution_attention','approval']] as const)store.enqueueOutbox({type,aggregateId:task.id,aggregateRevision:2,causationId:type,payload:{taskId:task.id,runId:'run',state,secret:'do not expose'}});
 const result=taskNotifications(store,tasks,p,first.cursor);expect(result.items.map(n=>n.state)).toEqual(['review','approval']);expect(JSON.stringify(result)).not.toContain('secret');
 expect(taskNotifications(store,tasks,{userId:'other'},first.cursor).items).toEqual([]);
 expect(taskNotifications(store,tasks,p,result.cursor).items).toEqual([]);
});
test('invalid cursors cannot trigger unbounded or historical notification reads',()=>{
 const {store,tasks}=fixture();for(const cursor of [-1,NaN,1.5])expect(()=>taskNotifications(store,tasks,{userId:'u'},cursor)).toThrow();
 expect(taskNotifications(store,tasks,{userId:'u'},999).items).toEqual([]);
});

test('approval notices point to their authorized execution, never an unrelated run',()=>{
 const {store,tasks}=fixture(),p={userId:'u'},task=tasks.createTask(p,{goal:'Approve task tool'},'approval-task'),other=tasks.createTask({userId:'other'},{goal:'Private'},'private-task');
 const cursor=taskNotifications(store,tasks,p).cursor;
 const chats=new Map<string,string>();
 for(const [id,ownedTask,userId] of [['own',task,'u'],['foreign',other,'other']] as const){
  const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});chats.set(id,chat.id);
  const execution=tasks.createExecution({userId},ownedTask.id,{conversationId:chat.id,agentId:'a',projectId:null,request:ownedTask.goal},id);
  store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at) VALUES (?,?,?,1,'approval',?,?)").run(id,ownedTask.id,execution.id,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),new Date().toISOString());
  store.enqueueOutbox({type:'task.execution_attention',aggregateId:task.id,aggregateRevision:1,causationId:id,payload:{taskId:task.id,runId:id,state:'approval'}});
 }
 const notices=taskNotifications(store,tasks,p,cursor);expect(notices.items.find(item=>item.runId==='own')).toMatchObject({executionConversationId:chats.get('own')});expect(notices.items.find(item=>item.runId==='foreign')?.executionConversationId).toBeUndefined();expect(JSON.stringify(notices)).not.toContain(chats.get('foreign'));
});

test('each outstanding result has one review action, its authorized summary, and retires after acceptance',()=>{
 const {store,tasks}=fixture(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'核对账单',acceptance:'human'},'review-task');
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:task.goal},'execution');
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,summary,created_at) VALUES (?,?,?,1,'succeeded',?,?,?)").run('result',task.id,execution.id,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),'已核对 3 张账单。',new Date().toISOString());
 store.database.prepare("UPDATE work_tasks SET state='review' WHERE id=?").run(task.id);
 const cursor=taskNotifications(store,tasks,p).cursor;
 for(const key of ['first','repeat'])store.enqueueOutbox({type:'task.run_terminal',aggregateId:task.id,aggregateRevision:4,causationId:key,payload:{taskId:task.id,runId:'result',state:'review'}});
 const notices=taskNotifications(store,tasks,p,cursor);
 expect(notices.items).toHaveLength(1);
 expect(notices.items[0]).toMatchObject({state:'review',detail:'已核对 3 张账单。'});
 expect(taskNotifications(store,tasks,p,cursor,()=>{throw new DomainError('forbidden',403,'Forbidden');}).items[0].detail).toBeUndefined();
 store.enqueueOutbox({type:'asset.access_changed',aggregateId:'billing',aggregateRevision:2,causationId:'revoke',payload:{assetId:'billing'}});
 const shown=notices.items[0].sequence!;
 const denied=taskNotifications(store,tasks,p,notices.cursor,()=>{throw new DomainError('forbidden',403,'Forbidden');},[shown]);
 expect(denied.rechecked).toEqual([shown]);
 expect(denied.items).toHaveLength(1);
 expect(denied.items[0].detail).toBeUndefined();
 tasks.userCommand(p,task.id,tasks.getTask(p,task.id).revision,'accept');
 expect(taskNotifications(store,tasks,p,notices.cursor).retired).toContain(notices.items[0].decisionScope);
 expect(taskNotifications(store,tasks,p,cursor).items).toEqual([]);
});

test('the actual coordination question opens the asking chat and a changed task retires the question',()=>{
 const {store,tasks}=fixture(),p={userId:store.ownerUserId},chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const task=tasks.createTask(p,{goal:'核对账单',originConversationId:chat.id},'question'),cursor=taskNotifications(store,tasks,p).cursor;
 const asking=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const updated=tasks.updateTask(p,task.id,task.revision,{state:'waiting'},'question-key');
 const event=store.appendEvent(asking.id,'metadata',{mandalaRequestKey:'question-key',mandalaRequest:{taskId:task.id,text:'请确认使用哪一个账期？',blocked:false},mandalaRequestRevision:updated.revision});
 store.enqueueOutbox({type:'task.input_requested',aggregateId:task.id,aggregateRevision:updated.revision,causationId:'question-key',payload:{taskId:task.id,conversationId:asking.id,eventId:event.id}});
 const edited=tasks.updateTask(p,task.id,updated.revision,{automaticProgress:false},'edit');
 const result=taskNotifications(store,tasks,p,cursor);
 expect(result.items).toHaveLength(1);
 expect(result.items[0]).toMatchObject({state:'input',detail:'请确认使用哪一个账期？',replyConversationId:asking.id});
 expect(taskNotifications(store,tasks,p,cursor,()=>{throw new DomainError('forbidden',403,'Forbidden');}).items).toHaveLength(0);
 tasks.updateTask(p,task.id,edited.revision,{state:'running'},'answered');
 expect(taskNotifications(store,tasks,p,result.cursor).retired).toContain(result.items[0].decisionScope);
});

test('a native question uses the exact active approval, and a second decision in the same run gets a fresh notice',()=>{
 const {store,tasks}=fixture(),p={userId:store.ownerUserId},task=tasks.createTask(p,{goal:'Choose the billing period'},'native-question');
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const execution=tasks.createExecution(p,task.id,{conversationId:chat.id,agentId:'a',projectId:null,request:task.goal},'execution');
 const identity={runId:'run',hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'};
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,created_at,host_id,native_session_id,native_turn_id) VALUES (?,?,?,1,'running',?,?,'local','session','turn')").run('run',task.id,execution.id,JSON.stringify({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}),new Date().toISOString());
 let cursor=taskNotifications(store,tasks,p).cursor;
 for(const id of ['first','second']){
  const question='Which month for '+id+'?';
  store.appendEvent(chat.id,'approval',{runId:'run',id,method:'item/tool/requestUserInput',params:{questions:[{id:'month',header:'Period',question}]}});
  tasks.setRunApproval(identity,true,id);
  const notices=taskNotifications(store,tasks,p,cursor);
  expect(notices.items).toHaveLength(1);
  expect(notices.items[0]).toMatchObject({state:'input',detail:question,executionConversationId:chat.id});
  tasks.setRunApproval(identity,false);
  const cleared=taskNotifications(store,tasks,p,notices.cursor);
  expect(cleared.retired).toContain(notices.items[0].decisionScope);
  expect(taskNotifications(store,tasks,p,cursor).items).toHaveLength(0);
  cursor=cleared.cursor;
 }
 tasks.setRunApproval(identity,true,'third');
 const pending=taskNotifications(store,tasks,p,cursor);
 tasks.markUnknown('run');
 const recovery=taskNotifications(store,tasks,p,pending.cursor);
 expect(recovery.items.map(item=>item.state)).toEqual(['unknown']);
 expect(recovery.retired).toContain(pending.items[0].decisionScope);
});
