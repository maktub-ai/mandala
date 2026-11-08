// Synthetic local benchmark: npx tsx scripts/performance-backend.ts
// Index removal is confined to this script's fresh temporary database.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';

const home=mkdtempSync(join(tmpdir(),'mandala-performance-'));
let store=openStore(home),tasks=createTasks(store);
const principal={userId:store.ownerUserId},chatIds:string[]=[];
const activitySql='SELECT MAX(created_at) AS at FROM outbox WHERE aggregate_id=?';
const routingSql="SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? UNION SELECT run_id AS id FROM conversation_task_provenance WHERE conversation_id=?";
const relatedSql="SELECT task_id,continuation FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? OR json_extract(continuation,'$.conversationId')=?";
const sourceSql='SELECT data FROM events WHERE conversationId=? AND id=? AND superseded=0';
const historySql='SELECT id,conversationId,kind,data,createdAt FROM events WHERE conversationId=? AND id>? AND superseded=0 ORDER BY id LIMIT ?';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function measure(read:()=>unknown){
 const milliseconds:number[]=[];let result:unknown;
 for(let round=0;round<6;round++){const start=performance.now();result=read();milliseconds.push(Number((performance.now()-start).toFixed(3)));}
 return {milliseconds,resultDigest:digest(result)};
}
function plan(sql:string,...args:(string|number)[]){return store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail);}
try{
 store.transaction(()=>{
  for(let index=0;index<500;index++){
   const task=tasks.prepareCreate(principal,{goal:'Synthetic task '+index},'task-'+index).commit();
   const chat=store.createConversation({projectId:'',agentId:'agent',cli:'codex',model:null});chatIds.push(chat.id);
   for(let revision=0;revision<40;revision++)store.enqueueOutbox({type:'task.changed',aggregateId:task.id,aggregateRevision:revision,causationId:'change-'+index+'-'+revision,payload:{taskId:task.id}});
   const execution=tasks.createExecution(principal,task.id,{conversationId:chat.id,agentId:chat.agentId,projectId:null,request:task.goal},'execution-'+index);
   for(let attempt=0;attempt<4;attempt++)store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at,routing,continuation) VALUES (?,?,?,?,'succeeded','2026-11-04T00:00:00Z',?,?)")
    .run('run-'+index+'-'+attempt,task.id,execution.id,attempt,JSON.stringify({executionConversationId:chat.id,destinationConversationId:chat.id,mode:'dedicated'}),JSON.stringify({conversationId:chat.id,taskId:task.id}));
  }
 });
 const request=store.appendEvent(chatIds[0],'user',{text:'Synthetic request'});
 store.transaction(()=>{for(let index=0;index<20000;index++)store.appendEvent(chatIds[0],'text',{text:'Synthetic stream delta '.repeat(40),runId:'synthetic-run',itemId:'answer'});});
 const firstTaskId=store.database.prepare('SELECT id FROM work_tasks LIMIT 1').get()!.id as string;
 const queries=(indexed:boolean)=>({activity:plan(activitySql,firstTaskId),routing:plan(routingSql,chatIds[0],chatIds[0]),related:plan(relatedSql,chatIds[0],chatIds[0]),source:indexed?plan(sourceSql,chatIds[0],request.id):plan(historySql,chatIds[0],0,-1)});
 const benchmark=(indexed:boolean)=>({
  taskList:measure(()=>tasks.listTasks(principal)),
  conversationRunLookup:measure(()=>chatIds.map(id=>store.listConversationTaskRuns(id))),
  relatedRunLookup:measure(()=>{const query=store.database.prepare(relatedSql);return chatIds.map(id=>query.all(id,id));}),
  // This measures only the source lookup used by Agent-message lifecycle checks.
  messageSourceLookup:measure(()=>indexed?JSON.parse(store.database.prepare(sourceSql).get(chatIds[0],request.id)!.data as string):store.listEvents(chatIds[0],0).find(event=>event.id===request.id)!.data),
  queryPlans:queries(indexed),
 });
 store.database.exec('DROP INDEX IF EXISTS outbox_aggregate_created; DROP INDEX IF EXISTS task_runs_execution_chat; DROP INDEX IF EXISTS task_runs_continuation_chat');
 const before=benchmark(false);
 store.close();store=openStore(home);tasks=createTasks(store);
 const after=benchmark(true);
 const metrics=['taskList','conversationRunLookup','relatedRunLookup','messageSourceLookup'] as const;
 const unchanged=metrics.every(key=>before[key].resultDigest===after[key].resultDigest);
 if(!unchanged)throw new Error('Benchmark result changed');
 console.log(JSON.stringify({node:process.version,data:'Synthetic temporary database',scope:'Synchronous data access only; not end-to-end UI or model latency',scenario:{tasks:500,outbox:20500,chats:500,runs:2000,streamEvents:20000},unchanged,before,after},null,2));
}finally{store.close();rmSync(home,{recursive:true,force:true});}
