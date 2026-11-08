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
