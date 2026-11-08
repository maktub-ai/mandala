import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {createTasks} from '../server/tasks';
import {createAgentMessages} from '../server/agent-messages';
import type {QueuedInput} from '../shared/tasks';

let home:string,store:Store;
afterEach(()=>{vi.restoreAllMocks();store?.close();if(home)rmSync(home,{recursive:true,force:true});});
function setup(){home=mkdtempSync(join(tmpdir(),'mana-backend-performance-'));store=openStore(home);return createTasks(store);}
const chat=()=>store.createConversation({projectId:'',agentId:'agent',cli:'codex',model:null});
const details=(sql:string,...args:string[])=>store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail as string).join('\n');

test.each([false,true])('task activity uses an indexed aggregate lookup after reopening=%s',reopen=>{
 let tasks=setup();const principal={userId:store.ownerUserId};
 const task=tasks.createTask(principal,{goal:'Synthetic task'},'create');
 store.database.prepare("UPDATE work_tasks SET created_at='2026-11-04T00:00:00Z' WHERE id=?").run(task.id);
 store.enqueueOutbox({type:'task.updated',aggregateId:task.id,aggregateRevision:2,causationId:'change',payload:{taskId:task.id}});
 store.database.prepare("UPDATE outbox SET created_at='2026-11-04T12:00:00Z' WHERE aggregate_id=?").run(task.id);
 if(reopen){store.database.exec('DROP INDEX IF EXISTS outbox_aggregate_created');store.close();store=openStore(home);tasks=createTasks(store);}
 const prepared=vi.spyOn(store.database,'prepare');
 expect(tasks.listTasks(principal)).toContainEqual(expect.objectContaining({id:task.id,activityAt:'2026-11-04T12:00:00Z'}));
 const query=prepared.mock.calls.map(([sql])=>sql).find(sql=>sql.includes('MAX(created_at)')&&sql.includes('outbox'))!;
 prepared.mockRestore();
 expect(details(query,task.id)).toMatch(/USING (?:COVERING )?INDEX/);
});

test.each([false,true])('conversation run lookup stays indexed and current after reopening=%s',reopen=>{
 let tasks=setup();const principal={userId:store.ownerUserId};
 const task=tasks.createTask(principal,{goal:'Synthetic task'},'create'),a=chat(),b=chat(),fork=chat();
 const execution=tasks.createExecution(principal,task.id,{conversationId:a.id,agentId:a.agentId,projectId:null,request:'Synthetic task'},'execution');
 store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at,routing,continuation) VALUES ('run',?,?,1,'succeeded','2026-11-04T00:00:00Z',?,?)")
  .run(task.id,execution.id,JSON.stringify({executionConversationId:a.id,mode:'dedicated'}),JSON.stringify({conversationId:b.id,taskId:task.id}));
 store.inheritConversationTaskRuns(fork.id,['run']);
 if(reopen){store.database.exec('DROP INDEX IF EXISTS task_runs_execution_chat; DROP INDEX IF EXISTS task_runs_continuation_chat');store.close();store=openStore(home);tasks=createTasks(store);}
 const prepared=vi.spyOn(store.database,'prepare');
 expect(store.listConversationTaskRuns(a.id)).toEqual(['run']);
 expect(store.listConversationTaskRuns(fork.id)).toEqual(['run']);
 const query=prepared.mock.calls.map(([sql])=>sql).find(sql=>sql.includes('UNION SELECT run_id'))!;
 prepared.mockRestore();
 expect(details(query,a.id,a.id)).not.toContain('SCAN task_runs');
 const related="SELECT task_id,continuation FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? OR json_extract(continuation,'$.conversationId')=?";
 expect(details(related,a.id,b.id)).not.toContain('SCAN task_runs');
 store.database.prepare("UPDATE task_runs SET routing=json_set(routing,'$.executionConversationId',?) WHERE id='run'").run(b.id);
 expect(store.listConversationTaskRuns(a.id)).toEqual([]);
 expect(store.listConversationTaskRuns(b.id)).toEqual(['run']);
 expect(store.listConversationTaskRuns(fork.id)).toEqual(['run']);
});

function messageFixture(){
 setup();const source=chat(),target=chat(),queued:QueuedInput[]=[];
 const messages=createAgentMessages(store,(conversationId,text)=>{const input:QueuedInput={id:'input-'+queued.length,conversationId,text,state:'queued',createdAt:'2026-11-04T00:00:00Z'};queued.push(input);return input;});
 const request=store.appendEvent(source.id,'user',{text:'Original synthetic request'});
 const unrelated=store.appendEvent(source.id,'text',{text:'Unrelated historical delta '.repeat(1000)});
 const payload=store.database.prepare('SELECT data FROM events WHERE id=?').get(unrelated.id)!.data;
 const message=messages.create(source.id,target.id,{targetAgentId:'helper',text:'Question'},{eventId:request.id,invocationId:'invocation'},'ask');
 return {source,target,request,payload,messages,message,queued};
}

test('Agent inquiry eligibility and reply delivery do not parse unrelated transcript payloads',()=>{
 const {source,payload,messages,message,queued}=messageFixture(),parse=vi.spyOn(JSON,'parse');
 expect(messages.eligible(queued[0])).toBe(true);
 expect(messages.finish(queued[0].id,'succeeded','Synthetic answer')).toEqual([message.id]);
 messages.queueReplies(source.id);
 expect(queued[1].text).toContain('Original synthetic request');
 expect(queued[1].text).toContain('Synthetic answer');
 expect(messages.eligible(queued[1])).toBe(true);
 messages.finish(queued[1].id,'succeeded','Final answer');
 expect(messages.get(message.id).replyState).toBe('consumed');
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(0);
});

test.each(['superseded','foreign','missing'] as const)('Agent inquiry refuses a %s source request and never queues its reply',invalid=>{
 const {source,target,request,messages,message,queued}=messageFixture();
 if(invalid==='superseded')store.replaceHistory(source.id,request.id,null);
 else if(invalid==='foreign')store.database.prepare('UPDATE events SET conversationId=? WHERE id=?').run(target.id,request.id);
 else store.database.prepare('DELETE FROM events WHERE id=?').run(request.id);
 expect(messages.eligible(queued[0])).toBe(false);
 messages.finish(queued[0].id,'succeeded','Late answer');
 messages.queueReplies(source.id);
 expect(queued).toHaveLength(1);
 expect(messages.get(message.id).replyState).toBe('parked');
});
