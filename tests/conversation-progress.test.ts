import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,type Store} from '../server/store';
import {createSessionManager,type SessionManager} from '../server/sessions';
import {createConversationProgress} from '../server/conversation-progress';
import type {Config,Conversation} from '../shared/types';
let home:string,store:Store,manager:SessionManager;
const now='2026-10-22T09:00:00.000Z',old='2026-10-21T21:00:00.000Z';
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'mana-progress-'));store=openStore(home);const config:Config={version:2,projects:[],agents:[]};manager=createSessionManager(store,async()=>config);});
afterEach(async()=>{await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
function chat(title:string,status:Conversation['status']='idle',agentId=''){
 const c=store.createConversation({projectId:'',agentId,cli:'codex',model:null});store.renameConversation(c.id,title);store.appendEvent(c.id,'user',{text:title},old);store.updateConversation(c.id,{status});store.database.prepare("UPDATE conversations SET updated_at=?,data=json_set(data,'$.createdAt',?) WHERE id=?").run(old,old,c.id);return c;
}
test('unchanged progress polls do not rescan transcript activity, while edits invalidate it',()=>{
 const c=chat('Cached activity'),prepare=store.database.prepare.bind(store.database);
 const reads=vi.fn();
 const spy=vi.spyOn(store.database,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);
  if(sql.includes('AS message_at')){const get=statement.get.bind(statement);vi.spyOn(statement,'get').mockImplementation((...args)=>{reads();return get(...args);});}
  return statement;
 });
 try{
  const p=createConversationProgress(store,manager);
  expect(p.list({now})[0].activityAt).toBe(old);
  expect(p.list({now})[0].activityAt).toBe(old);
  expect(reads).toHaveBeenCalledTimes(1);
  store.database.prepare("UPDATE events SET createdAt=? WHERE conversationId=? AND kind='user'").run(now,c.id);
  expect(p.list({now})[0].activityAt).toBe(now);
  expect(reads).toHaveBeenCalledTimes(2);
  store.appendEvent(c.id,'user',{text:'Another request'},now);
  expect(p.list({now})[0].requestPreview).toBe('Another request');
  expect(reads).toHaveBeenCalledTimes(3);
  store.database.prepare('UPDATE events SET superseded=1 WHERE conversationId=?').run(c.id);
  expect(p.list({now})[0].activityAt).toBe(old);
  expect(reads).toHaveBeenCalledTimes(4);
 }finally{spy.mockRestore();}
});
test.each(['idle','running','approval','interrupted'] as const)('primary coordination chat is absent from task progress even when %s',status=>{
 const primary=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null,purpose:'mandala-main'}),execution=chat('Mandala execution','running');
 store.updateConversation(primary.id,{status});
 store.appendEvent(primary.id,'user',{text:'Keep coordinating'},now);
 const rows=createConversationProgress(store,manager).list({now});
 expect(rows.map(row=>row.id)).toEqual([execution.id]);
 expect(store.getConversation(primary.id)?.purpose).toBe('mandala-main');
 expect(store.listEvents(primary.id,0)).toContainEqual(expect.objectContaining({kind:'user',data:{text:'Keep coordinating'}}));
});
test('standalone idle and historical interrupted chats expire, actual running stays visible without Tasks',()=>{
 const a=chat('Idle'),b=chat('Running','running'),c=chat('Unknown','interrupted'),p=createConversationProgress(store,manager);
 const rows=p.list({now,windowMinutes:60});expect(rows.find(r=>r.id===a.id)).toMatchObject({active:false,state:'recent',taskIds:[]});
 expect(rows.find(r=>r.id===b.id)).toMatchObject({active:true,state:'running'});expect(rows.find(r=>r.id===c.id)).toMatchObject({active:false,state:'attention'});
 expect(store.database.prepare('SELECT count(*) n FROM work_tasks').get()!.n).toBe(0);
});
test('visiting an expired chat does not return it to the default recent window',()=>{
 const c=chat('Visited'),p=createConversationProgress(store,manager);store.appendEvent(c.id,'metadata',{heartbeat:true},now);
 expect(p.list({now,windowMinutes:60})[0]).toMatchObject({active:false,activityAt:old});
 p.update(c.id,{action:'visit'},now);expect(p.list({now,windowMinutes:60})[0]).toMatchObject({active:false,withinWindow:false,activityAt:old,state:'recent'});
 expect(createConversationProgress(store,manager).list({now,windowMinutes:60})[0]).toMatchObject({active:false,activityAt:old});
 expect(p.list({now:'2026-10-22T10:00:00.000Z',windowMinutes:60})[0]).toMatchObject({active:false,activityAt:old});
});
test('explicit reopening refreshes discovery but a later visit does not extend it',()=>{
 const c=chat('Explicit reopen'),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},old);p.update(c.id,{action:'reopen'},now);
 expect(p.list({now,windowMinutes:60})[0]).toMatchObject({active:true,state:'recent',activityAt:old});
 p.update(c.id,{action:'visit'},'2026-10-22T09:59:00.000Z');
 expect(p.list({now:'2026-10-22T10:00:00.000Z',windowMinutes:60})[0]).toMatchObject({active:false,withinWindow:false,activityAt:old});
});
test('legacy visit markers expire without losing explicit completion records on upgrade',()=>{
 const a=chat('Legacy visit'),b=chat('Legacy completed');
 store.database.exec('CREATE TABLE conversation_progress(conversation_id TEXT PRIMARY KEY,visited_at TEXT,completed_at TEXT,event_cursor INTEGER NOT NULL DEFAULT 0,user_cursor INTEGER NOT NULL DEFAULT 0,input_cursor INTEGER NOT NULL DEFAULT 0)');
 store.database.prepare('INSERT INTO conversation_progress(conversation_id,visited_at,completed_at) VALUES (?,?,NULL),(?,?,?)').run(a.id,now,b.id,now,now);
 const cursor=store.listEvents(b.id,0).at(-1)!.id;
 store.database.prepare('UPDATE conversation_progress SET event_cursor=?,user_cursor=? WHERE conversation_id=?').run(cursor,cursor,b.id);
 const rows=createConversationProgress(store,manager).list({now});
 expect(rows.find(row=>row.id===a.id)).toMatchObject({active:false,withinWindow:false,state:'recent'});
 expect(rows.find(row=>row.id===b.id)).toMatchObject({active:false,withinWindow:true,state:'completed',completedAt:now});
});
test('runtime lifecycle events keep attention current without pretending a new message arrived',()=>{
 const c=chat('Recovery','error'),p=createConversationProgress(store,manager);
 store.appendEvent(c.id,'error',{code:'service_restarted',message:'Service restarted'},now);
 store.appendEvent(c.id,'status',{status:'interrupted'},now);
 expect(p.list({now})[0]).toMatchObject({activityAt:old,active:true});
});
test('native completed-only replies advance the last message time and ordering despite later visits',()=>{
 const a=chat('Visited old chat'),b=chat('New reply'),p=createConversationProgress(store,manager);
 store.appendEvent(b.id,'tool',{method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'A complete reply'}}},now);
 p.update(a.id,{action:'visit'},'2026-10-22T09:01:00.000Z');
 const rows=p.list({now:'2026-10-22T09:02:00.000Z'});
 expect(rows.map(row=>row.id)).toEqual([b.id,a.id]);
 expect(rows[0]).toMatchObject({activityAt:now,active:true});
 expect(rows[1].activityAt).toBe(old);
});
test('notify-only helper replies advance the last message time without a resumed model turn',()=>{
 const c=chat('Helper reply'),p=createConversationProgress(store,manager);
 const agentMessage={id:'helper',direction:'reply',policy:'notify',state:'succeeded',reply:'Review complete',replyState:'parked',autoResumeAllowed:false};
 store.appendEvent(c.id,'metadata',{agentMessage},now);
 expect(p.list({now})[0]).toMatchObject({activityAt:now,active:true});
 store.appendEvent(c.id,'metadata',{agentMessage:{...agentMessage,replyState:'consumed'}},'2026-10-22T10:00:00.000Z');
 expect(p.list({now:'2026-10-22T10:00:00.000Z'})[0].activityAt).toBe(now);
});
test('manual completion survives runtime updates, injected helper inputs and recreation, explicit user work reopens it',()=>{
 const c=chat('Finished'),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},now);
 store.appendEvent(c.id,'user',{text:'helper reply',agentMessage:{id:'helper',direction:'reply'}});store.updateConversation(c.id,{status:'running'});store.appendEvent(c.id,'text',{text:'Late activity'});
 let row=createConversationProgress(store,manager).list({now})[0];expect(row).toMatchObject({state:'completed',active:false,hasNewActivity:true});
 p.update(c.id,{action:'visit'},now);expect(p.list({now})[0].state).toBe('completed');
 store.appendEvent(c.id,'user',{text:'New explicit request'});row=p.list({now})[0];expect(row.state).toBe('running');
});
test('marking a conversation complete never changes a linked Task',()=>{
 const c=chat('Related','idle','a'),task=createTaskWithExecutions(store,manager.taskService,{userId:'local'},{goal:'Deliver',projectId:null},[c.id],'task'),p=createConversationProgress(store,manager);
 p.update(c.id,{action:'complete'},now);expect(p.list({now})[0].taskIds).toContain(task.id);expect(manager.taskService.getTask({userId:'local'},task.id).state).toBe('todo');
 p.update(c.id,{action:'reopen'},now);expect(p.list({now})[0]).toMatchObject({state:'recent',active:true});
});
test('objective queued inputs and unanswered messages stay visible outside the recent window',()=>{
 const a=chat('Queued'),b=chat('Waiting'),p=createConversationProgress(store,manager);manager.enqueueUserInput(a.id,'Next','queued');
 store.database.prepare("INSERT INTO agent_messages VALUES ('m',?,?,1,'inv','Question','resume','running',NULL,'pending',1,'input',NULL,'key',?)").run(b.id,a.id,old);
 expect(p.list({now}).find(r=>r.id===a.id)).toMatchObject({state:'queued',active:true});expect(p.list({now}).find(r=>r.id===b.id)).toMatchObject({state:'waiting',active:true});
});
test('unreadable chats are filtered and mutations require conversation access',()=>{
 const c=chat('Private'),p=createConversationProgress(store,manager);manager.authorizeConversationRead=()=>{throw Object.assign(new Error('denied'),{status:403});};
 expect(p.list({now})).toEqual([]);expect(()=>p.update(c.id,{action:'complete'},now)).toThrow('denied');
});
test('an explicit queued user request reopens completed progress immediately, existing queued work does not',()=>{
 const c=chat('Queued reopen'),p=createConversationProgress(store,manager);manager.enqueueUserInput(c.id,'Already waiting','before-complete');p.update(c.id,{action:'complete'},now);
 expect(p.list({now})[0].state).toBe('completed');
 manager.enqueueUserInput(c.id,'A fresh explicit request','after-complete');expect(p.list({now})[0]).toMatchObject({state:'queued',active:true});
});
test('a native completed-only final answer after completion is shown as new activity',()=>{
 const c=chat('Completed-only reply'),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},now);
 store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'Final answer without deltas'}}});
 expect(p.list({now})[0]).toMatchObject({state:'completed',hasNewActivity:true});
});

test('old errors and interruptions expire, fresh failures and genuine pending approvals stay visible',()=>{
 const interrupted=chat('Interrupted','interrupted'),failed=chat('Failed','error'),approval=chat('Approval','approval'),p=createConversationProgress(store,manager);
 let rows=p.list({now});expect(rows.find(r=>r.id===interrupted.id)?.active).toBe(false);expect(rows.find(r=>r.id===failed.id)?.active).toBe(false);expect(rows.find(r=>r.id===approval.id)?.active).toBe(true);
 store.appendEvent(failed.id,'error',{message:'Fresh failure'},now);expect(p.list({now}).find(r=>r.id===failed.id)).toMatchObject({state:'attention',active:true});
 expect(p.list({now:'2026-10-22T15:00:00.000Z'}).find(r=>r.id===failed.id)?.active).toBe(false);
});

test('an old unknown input is historical uncertainty, not a live queue',()=>{
 const c=chat('Historical unknown','interrupted'),p=createConversationProgress(store,manager);
 manager.enqueueUserInput(c.id,'Old unresolved input','unknown');store.database.prepare("UPDATE task_user_inputs SET state='unknown',created_at=? WHERE conversation_id=?").run(old,c.id);
 expect(p.list({now})[0]).toMatchObject({state:'attention',active:false});
 p.update(c.id,{action:'visit'},now);expect(p.list({now})[0].active).toBe(false);
});

test('a stopped source does not stay active because its helper still runs independently',()=>{
 const a=chat('Stopped source','interrupted'),b=chat('Independent helper','running'),p=createConversationProgress(store,manager);
 store.database.prepare("INSERT INTO agent_messages VALUES ('parked-helper',?,?,1,'inv','Question','resume','running',NULL,'parked',0,'input',NULL,'key',?)").run(a.id,b.id,old);
 expect(p.list({now}).find(r=>r.id===a.id)?.active).toBe(false);expect(p.list({now}).find(r=>r.id===b.id)?.active).toBe(true);
});

test('newer unknown helpers do not hide an older live collaboration wait',()=>{
 const a=chat('Several helpers'),b=chat('Helper'),p=createConversationProgress(store,manager);
 for(const [id,state] of [['older','running'],['newer','unknown']])store.database.prepare("INSERT INTO agent_messages VALUES (?,?,?,1,'inv','Question','resume',?,NULL,'pending',1,?,NULL,?,?)").run(id,a.id,b.id,state,id,id,old);
 expect(p.list({now}).find(r=>r.id===a.id)).toMatchObject({state:'attention',active:true});
});

test('a stopped task no longer keeps its origin waiting for delegated executions',async()=>{
 const a=chat('Stopped coordinator'),b=chat('Execution','running','worker'),p=createConversationProgress(store,manager),root={userId:store.ownerUserId};
 const task=manager.taskService.createTask(root,{goal:'Goal',originConversationId:a.id},'goal');
 const execution=manager.taskService.createExecution(root,task.id,{conversationId:b.id,agentId:'worker',projectId:b.projectId||null,request:'Work'},'execution');
 store.database.prepare('UPDATE work_tasks SET future_auto_resume=1 WHERE id=?').run(task.id);
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at,routing,continuation) VALUES ('execution-run',?,?,1,'running',?,?,?)").run(task.id,execution.id,old,JSON.stringify({executionConversationId:b.id,mode:'dedicated',destinationConversationId:a.id}),JSON.stringify({taskId:task.id,conversationId:a.id,epoch:0,policy:'resume'}));
 expect(p.list({now}).find(r=>r.id===a.id)?.active).toBe(true);
 await manager.stop(a.id);store.database.prepare('UPDATE events SET createdAt=? WHERE conversationId=?').run(old,a.id);
 expect(p.list({now}).find(r=>r.id===a.id)?.active).toBe(false);
 expect(p.list({now}).find(r=>r.id===b.id)?.taskIds).toEqual([task.id]);
});

test('compact progress uses a bounded real request preview without helper injections',()=>{
 const c=chat('Preview'),p=createConversationProgress(store,manager);store.appendEvent(c.id,'user',{text:'请核对发布范围。'.repeat(60)},now);store.appendEvent(c.id,'user',{text:'Injected helper prompt',agentMessage:{id:'helper',direction:'reply'}});
 expect(p.list({now})[0].requestPreview).toBe(('请核对发布范围。'.repeat(60)).slice(0,240));
});

test('display completion never hides an outstanding approval and is preserved after handling it',()=>{
 const c=chat('Completed then approval'),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},now);
 store.updateConversation(c.id,{status:'approval'});
 expect(p.list({now})[0]).toMatchObject({state:'attention',active:true,completedAt:now});
 store.updateConversation(c.id,{status:'idle'});
 expect(p.list({now})[0]).toMatchObject({state:'completed',active:false,completedAt:now});
});

test('completed display records expose the exact recent-window boundary without reopening',()=>{
 const c=chat('Completed window'),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},now);
 for(const [elapsed,withinWindow] of [[3599999,true],[3600000,false],[3600001,false]] as const){
  const later=new Date(Date.parse(now)+elapsed).toISOString();
  expect(p.list({now:later,windowMinutes:60})[0]).toMatchObject({state:'completed',active:false,withinWindow,completedAt:now});
 }
});

for(const [status,expected] of [['idle','recent'],['interrupted','attention']] as const)test(`completed ${status} keeps its factual reopen destination`,()=>{
 const c=chat('Drag destination',status),p=createConversationProgress(store,manager);p.update(c.id,{action:'complete'},now);
 expect(p.list({now})[0]).toMatchObject({state:'completed',reopenState:expected});
 p.update(c.id,{action:'reopen'},now);expect(p.list({now})[0].state).toBe(expected);
});

for(const windowMinutes of [60,240,1440])for(const status of ['idle','error','interrupted','completed'] as const)test(`${windowMinutes} minute ${status} activity expires exactly at the window`,()=>{
 const c=chat('Window boundary',status==='completed'?'idle':status),p=createConversationProgress(store,manager);store.appendEvent(c.id,'user',{text:'Real activity'},now);p.update(c.id,{action:status==='completed'?'complete':'visit'},now);
 for(const [offset,withinWindow] of [[-1,true],[0,false],[1,false]] as const){
  const at=new Date(Date.parse(now)+windowMinutes*60000+offset).toISOString(),row=p.list({now:at,windowMinutes})[0];
  expect(row).toMatchObject({withinWindow,active:status==='completed'?false:withinWindow,state:status==='completed'?'completed':status==='idle'?'recent':'attention'});
  expect(row.completedAt).toBe(status==='completed'?now:null);
 }
 expect(store.database.prepare('SELECT count(*) n FROM task_runs').get()!.n).toBe(0);
});

test('default six-hour conversation window expires exactly at the threshold',()=>{
 const c=chat('Boundary'),p=createConversationProgress(store,manager);store.appendEvent(c.id,'user',{text:'Real activity'},now);p.update(c.id,{action:'visit'},now);
 expect(p.list({now:'2026-10-22T14:59:59.999Z'})[0].withinWindow).toBe(true);
 expect(p.list({now:'2026-10-22T15:00:00.000Z'})[0]).toMatchObject({withinWindow:false,active:false});
 expect(p.list({now:'2026-10-22T15:00:00.001Z'})[0].active).toBe(false);
});
test('an unknown resumed reply is actionable uncertainty but does not pretend to remain queued forever',()=>{
 const a=chat('Reply receiver'),b=chat('Peer'),p=createConversationProgress(store,manager),input=manager.enqueueUserInput(a.id,'Recovered reply','unknown-reply');
 store.database.prepare("UPDATE task_user_inputs SET state='unknown',created_at=? WHERE id=?").run(old,input.id);
 store.database.prepare("INSERT INTO agent_messages VALUES ('unknown-resume',?,?,1,'inv','Question','resume','succeeded','Answer','queued',1,'request',?,'unknown',?)").run(a.id,b.id,input.id,old);
 expect(p.list({now}).find(row=>row.id===a.id)).toMatchObject({active:false,live:false,state:'attention'});
 store.database.prepare("UPDATE task_user_inputs SET state='queued' WHERE id=?").run(input.id);
 expect(p.list({now}).find(row=>row.id===a.id)).toMatchObject({active:true,live:true,state:'queued'});
});
test('a presented receipt with an unknown coordinator is historical uncertainty rather than a permanent live wait',()=>{
 const a=chat('Uncertain coordinator','interrupted'),p=createConversationProgress(store,manager),root={userId:store.ownerUserId};
 const task=manager.taskService.createTask(root,{goal:'Goal',originConversationId:a.id},'uncertain-goal');
 const worker=store.createConversation({projectId:'',agentId:'worker',cli:'codex',model:null}),coordinator=store.createConversation({projectId:'',agentId:'coordinator',cli:'codex',model:null});
 const one=manager.taskService.createExecution(root,task.id,{conversationId:coordinator.id,agentId:'coordinator',projectId:null,request:'Summarize'},'coordinator');
 const two=manager.taskService.createExecution(root,task.id,{conversationId:worker.id,agentId:'worker',projectId:null,request:'Work'},'worker');
 store.database.prepare('UPDATE work_tasks SET future_auto_resume=1 WHERE id=?').run(task.id);
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at) VALUES ('unknown-coordinator',?,?,1,'unknown',?),('known-execution',?,?,2,'succeeded',?)").run(task.id,one.id,old,task.id,two.id,old);
 store.database.prepare("INSERT INTO task_receipts(id,task_id,source_run_id,destination_conversation_id,execution_id,captured_epoch,policy,delivery_state,claimed_by_run_id,summary,artifact_versions,created_at) VALUES ('uncertain-receipt',?,'known-execution',?,?,0,'resume','presented','unknown-coordinator','Answer','[]',?)").run(task.id,a.id,two.id,old);
 expect(p.list({now}).find(row=>row.id===a.id)).toMatchObject({active:false,live:false,state:'attention'});
 store.database.prepare("UPDATE task_receipts SET delivery_state='pending',claimed_by_run_id=NULL WHERE id='uncertain-receipt'").run();
 expect(p.list({now}).find(row=>row.id===a.id)?.live).toBe(true);
});

test('latest native commentary survives restart as history and reading appends no events',async()=>{
 const c=chat('History','running');store.appendEvent(c.id,'progress',{text:'Public checkpoint',source:'cli',runId:'old-run'},old);
 store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'comment',type:'agentMessage',text:'Native commentary',phase:'commentary'}}},now);
 await manager.close();manager=createSessionManager(store,async()=>({version:2,projects:[],agents:[]}));
 const before=store.listEvents(c.id,0).length;
 expect(createConversationProgress(store,manager).list({now})[0]).toMatchObject({state:'attention',latestProgress:{text:'Native commentary',source:'commentary',historical:true,updatedAt:now}});
 expect(store.listEvents(c.id,0)).toHaveLength(before);
 const empty=chat('No report');expect(createConversationProgress(store,manager).list({now}).find(r=>r.id===empty.id)?.latestProgress).toBeNull();
});

test('raw lifecycle survives display completion and does not confuse a live child with a running parent',()=>{
 const running=chat('Marked closed','running'),failed=chat('Failed parent','error'),approval=chat('Approval','approval'),child=chat('Child','running'),p=createConversationProgress(store,manager);
 p.update(running.id,{action:'complete'},now);
 store.database.prepare("INSERT INTO agent_messages VALUES ('raw-child',?,?,1,'inv','Question','resume','running',NULL,'pending',1,'input',NULL,'raw-key',?)").run(failed.id,child.id,old);
 const rows=p.list({now});
 expect(rows.find(r=>r.id===running.id)).toMatchObject({state:'completed',executionStatus:'running'});
 expect(rows.find(r=>r.id===failed.id)).toMatchObject({live:true,state:'attention',executionStatus:'error'});
 expect(rows.find(r=>r.id===approval.id)).toMatchObject({executionStatus:'approval'});
});


test('projects streamed current output into linked Task rows, replaces it by native commentary, and excludes final answers',()=>{
 const c=chat('Live output','running','a'),p=createConversationProgress(store,manager),principal={userId:store.ownerUserId};
 const task=createTaskWithExecutions(store,manager.taskService,principal,{goal:'Verify'},[c.id],'live-output-task');
 manager.executionId=()=> 'r';store.appendEvent(c.id,'user',{text:'Check again',runId:'r'},now);store.appendEvent(c.id,'status',{status:'running',runId:'r'},now);
 store.appendEvent(c.id,'tool',{method:'item/started',params:{item:{id:'text',type:'agentMessage',text:''}},runId:'r'},now);
 store.appendEvent(c.id,'text',{itemId:'text',text:'Checking ',runId:'r'},now);const chunk=store.appendEvent(c.id,'text',{itemId:'text',text:'the source',runId:'r'},now);
 expect(p.list({now})[0]).toMatchObject({taskIds:[task.id],latestProgress:{text:'Checking the source',source:'output',runId:'r',sourceEventId:chunk.id,historical:false}});
 const native=store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'text',type:'agentMessage',phase:'commentary',text:'Checking the authoritative source'}},runId:'r'},now);
 store.appendEvent(c.id,'tool',{method:'item/started',params:{item:{id:'final',type:'agentMessage',phase:'final_answer',text:''}},runId:'r'},now);store.appendEvent(c.id,'text',{itemId:'final',text:'Done',runId:'r'},now);
 expect(p.list({now})[0].latestProgress).toMatchObject({text:'Checking the authoritative source',source:'commentary',sourceEventId:native.id});
 store.updateConversation(c.id,{status:'idle'});store.appendEvent(c.id,'status',{status:'idle',runId:'r'},now);
 expect(p.list({now})[0].latestProgress).toMatchObject({text:'Checking the authoritative source',historical:true});expect(manager.taskService.getTask(principal,task.id).state).toBe('todo');
});
test('removes a sole unphased final answer from the latest process after normal end',()=>{
 const c=chat('Final only','running'),p=createConversationProgress(store,manager);manager.executionId=()=> 'r';
 store.appendEvent(c.id,'user',{text:'Question',runId:'r'},now);store.appendEvent(c.id,'text',{itemId:'answer',text:'Result',runId:'r'},now);
 expect(p.list({now})[0].latestProgress).toMatchObject({source:'output',text:'Result'});
 store.updateConversation(c.id,{status:'idle'});store.appendEvent(c.id,'status',{status:'idle',runId:'r'},now);expect(p.list({now})[0].latestProgress).toBeNull();
});
test('does not carry previous-turn text or late older-run commentary into the current output',()=>{
 const c=chat('New round','running'),p=createConversationProgress(store,manager);manager.executionId=()=> 'new';
 store.appendEvent(c.id,'user',{text:'Old request',runId:'old'},old);store.appendEvent(c.id,'text',{text:'Old output',itemId:'same',runId:'old'},old);store.appendEvent(c.id,'status',{status:'idle',runId:'old'},old);
 store.appendEvent(c.id,'user',{text:'New request',runId:'new'},now);store.appendEvent(c.id,'metadata',{execution:'started',runId:'new'},now);store.appendEvent(c.id,'status',{status:'running',runId:'new'},now);
 store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'same',type:'agentMessage',phase:'commentary',text:'Late old text'}},runId:'old'},now);
 expect(p.list({now})[0].latestProgress).toBeNull();
 store.appendEvent(c.id,'text',{text:'New output',itemId:'same',runId:'new'},now);expect(p.list({now})[0].latestProgress).toMatchObject({text:'New output',source:'output',runId:'new',historical:false});
});
test('polls unchanged latest output without rereading its event history and invalidates on text or lifecycle changes',()=>{
 const c=chat('Polling','running'),p=createConversationProgress(store,manager);manager.executionId=()=> 'r';
 store.appendEvent(c.id,'user',{text:'Question',runId:'r'},now);store.appendEvent(c.id,'text',{text:'Checking',itemId:'reply',runId:'r'},now);
 const read=store.listEvents;let reads=0;store.listEvents=(...args)=>{reads++;return read(...args);};
 expect(p.list({now})[0].latestProgress?.text).toBe('Checking');const first=reads;
 p.list({now});expect(reads).toBe(first);
 store.appendEvent(c.id,'text',{text:' source',itemId:'reply',runId:'r'},now);expect(p.list({now})[0].latestProgress?.text).toBe('Checking source');
 store.updateConversation(c.id,{status:'idle'});expect(p.list({now})[0].latestProgress).toBeNull();
});
test('does not promote old explicit reports into a new run that has not produced public text',()=>{
 const c=chat('Old report','running'),p=createConversationProgress(store,manager);manager.executionId=()=> 'new';
 store.appendEvent(c.id,'user',{text:'First',runId:'old'},old);store.appendEvent(c.id,'progress',{source:'cli',text:'Old checkpoint',runId:'old'},old);
 store.appendEvent(c.id,'user',{text:'Second',runId:'new'},now);store.appendEvent(c.id,'status',{status:'running',runId:'new'},now);
 expect(p.list({now})[0].latestProgress).toBeNull();
 store.appendEvent(c.id,'progress',{source:'cli',text:'Late old checkpoint',runId:'old'},now);expect(p.list({now})[0].latestProgress).toBeNull();
});
test('never projects reasoning or analysis-only text as a public current update',()=>{
 const c=chat('Public only','running'),p=createConversationProgress(store,manager);manager.executionId=()=> 'r';
 store.appendEvent(c.id,'user',{text:'Question',runId:'r'},now);
 store.appendEvent(c.id,'text',{text:'PRIVATE_ANALYSIS',phase:'analysis',runId:'r'},now);
 store.appendEvent(c.id,'tool',{method:'item/completed',params:{item:{id:'reason',type:'reasoning',content:['PRIVATE_REASONING'],summary:['Reasoning summary']}},runId:'r'},now);
 expect(p.list({now})[0].latestProgress).toBeNull();
 store.appendEvent(c.id,'text',{text:'Public update',itemId:'public',runId:'r'},now);
 expect(p.list({now})[0].latestProgress).toMatchObject({text:'Public update',source:'output'});
});
