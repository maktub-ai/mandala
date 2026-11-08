import {test,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {taskActivity} from '../server/task-progress-view';
test('task activity uses actual changes and actual runs, not a stale running label',()=>{
 const home=mkdtempSync(join(tmpdir(),'task-activity-')),store=openStore(home);
 try{
  const tasks=createTasks(store),p={userId:store.ownerUserId},t=tasks.createTask(p,{goal:'Keep changes'},'create');
  store.database.prepare('UPDATE work_tasks SET state=\'running\' WHERE id=?').run(t.id);
  expect(taskActivity(store,t.id,t.createdAt).live).toBe(false);
  const chat=store.createConversation({agentId:'agent',projectId:'',cli:'codex',model:null}),execution=tasks.createExecution(p,t.id,{conversationId:chat.id,agentId:'agent',projectId:null,request:'Keep changes'},'execution');
  store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at) VALUES ('run',?,?,1,'queued',?)").run(t.id,execution.id,t.createdAt);
  expect(taskActivity(store,t.id,t.createdAt).live).toBe(true);
  store.database.prepare("UPDATE task_runs SET state='unknown' WHERE id='run'").run();expect(taskActivity(store,t.id,t.createdAt).live).toBe(false);
  store.database.prepare("UPDATE work_tasks SET state='waiting',waiting_reason='input' WHERE id=?").run(t.id);expect(taskActivity(store,t.id,t.createdAt).live).toBe(false);
  store.database.prepare("DELETE FROM task_runs WHERE id='run'").run();expect(taskActivity(store,t.id,t.createdAt).live).toBe(true);
  store.database.prepare("UPDATE work_tasks SET waiting_reason='interrupted' WHERE id=?").run(t.id);expect(taskActivity(store,t.id,t.createdAt).live).toBe(false);
  const at='2099-10-26T00:00:00.000Z';store.database.prepare('UPDATE outbox SET created_at=? WHERE aggregate_id=?').run(at,t.id);
  expect(taskActivity(store,t.id,t.createdAt).activityAt).toBe(at);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
test('a reconciled unknown Run is historical uncertainty, not an input wait that lasts forever',()=>{
 const home=mkdtempSync(join(tmpdir(),'task-unknown-')),store=openStore(home);
 try{
  const tasks=createTasks(store,{resolve:(_p,task)=>({agentId:task.assigneeAgentId!,projectId:task.projectId,hostId:'local',input:'Check',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})}),p={userId:store.ownerUserId},t=tasks.createTask(p,{goal:'Check',assigneeAgentId:'agent'},'create'),chat=store.createConversation({agentId:'agent',projectId:'',cli:'codex',model:null}),prepared=tasks.prepareStart(p,t.id,1,'start'),run=store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:null}));
  tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'native',nativeTurnId:'turn'});tasks.markUnknown(run.id);
  expect(tasks.getTask(p,t.id)).toMatchObject({state:'waiting',waitingReason:'input'});
  expect(taskActivity(store,t.id,t.createdAt).live).toBe(false);
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
