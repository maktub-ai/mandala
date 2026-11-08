import {createTaskWithExecutions} from './helpers/task-executions';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../server/store';
import { createTaskProgress, type ProgressTaskService } from '../server/task-progress';
import type { Config } from '../shared/types';
import { getUsage } from '../server/usage';
let home:string,store:Store,config:Config,id:string,task:any,tasks:ProgressTaskService;
const services: ReturnType<typeof createTaskProgress>[]=[];
const round=()=>{store.appendEvent(id,'user',{text:'Build the report'});return {sourceEventId:store.appendEvent(id,'status',{status:'idle'}).id,user:'Build the report',reply:'The report is verified.'};};
const result=(state='review', evidence='Report matches the stated goal')=>JSON.stringify([{taskId:'t',state,evidence}]);
function setup(generate:any){const service=createTaskProgress({store,loadConfig:async()=>config,tasks,generate});services.push(service);return service;}
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'task-progress-'));store=openStore(home);config={version:2,agents:[],projects:[],system:{cli:'codex',model:'default'}};
 id=store.createConversation({cli:'codex',projectId:'p',agentId:'a',model:null}).id;
 task={task:{id:'t',goal:'Verified report',criteria:[],state:'todo',revision:1,conversationIds:[id]},executions:[]};
 tasks={applyTaskProgressBatch:vi.fn((principal:Parameters<ProgressTaskService['applyTaskProgressBatch']>[0],entries:Parameters<ProgressTaskService['applyTaskProgressBatch']>[1])=>entries.map(entry=>tasks.applyTaskProgress(principal,entry.snapshot,entry.state,entry.guard))),snapshotProgress:vi.fn(()=>[structuredClone(task)]),applyTaskProgress:vi.fn((_principal,snapshot,state,guard)=>{if(!guard?.()||JSON.stringify(snapshot)!==JSON.stringify(task))return false;task.task.state=state;task.task.revision++;return true;})};
});
afterEach(()=>{services.splice(0).forEach(s=>s.close());store.close();rmSync(home,{recursive:true,force:true});});
it('no explicit links or completed final round means no model invocation',async()=>{const generate=vi.fn();tasks.snapshotProgress=()=>[];await setup(generate).evaluate(id,round());expect(generate).not.toHaveBeenCalled();await setup(generate).evaluate(id,undefined);expect(generate).not.toHaveBeenCalled();});
it('passes only captured final input, linked goals/criteria and execution context; achieved is review',async()=>{
 task.executions=[{id:'execution',conversationId:'execution-chat',request:'Collect source',latestRun:null}];task.task.criteria=[{id:'c',text:'Verify all data',checkRef:null}];
 const generate=vi.fn().mockResolvedValue(result());await setup(generate).evaluate(id,round());
 const source=JSON.parse(generate.mock.calls[0][1].split('SOURCE_JSON:\n')[1]);
 expect(source).toEqual({user:'Build the report',reply:'The report is verified.',tasks:[{taskId:'t',goal:'Verified report',criteria:task.task.criteria,state:'todo',executions:[{conversationId:'execution-chat',state:null}]}]});
 expect(task.task.state).toBe('review');expect(task.task.state).not.toBe('completed');
 const recorded=store.database.prepare('SELECT snapshot FROM task_progress_evaluations').get()!;expect(JSON.parse(recorded.snapshot as string)[0]).toMatchObject({task:{revision:1,conversationIds:[id]},executions:[{id:'execution',conversationId:'execution-chat'}]});
});
it.each(['completed','cancelled','invalid'])('rejects model state %s without changes and retains diagnostics',async state=>{
 await setup(vi.fn().mockResolvedValue(result(state))).evaluate(id,round());expect(task.task.state).toBe('todo');
 expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({systemTask:'taskProgress',status:'failed',code:'invalid-output'});
});
it('no evidence keeps state even if model claims review',async()=>{await setup(vi.fn().mockResolvedValue(result('review',''))).evaluate(id,round());expect(task.task.state).toBe('todo');});
it('deduplicates concurrent and restarted calls including failed attempts',async()=>{
 const generate=vi.fn().mockRejectedValue(new Error('native failed')),source=round(),service=setup(generate);
 await Promise.all([service.evaluate(id,source),service.evaluate(id,source)]);await setup(generate).evaluate(id,source);expect(generate).toHaveBeenCalledOnce();expect(task.task.state).toBe('todo');
 expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({systemTask:'taskProgress',status:'failed',code:'generation-failed'});
});
it.each(['edit','unlink','execution','accept','cancel','source'])('discards stale results after %s',async kind=>{
 let resolve!:(value:string)=>void;const generate=vi.fn(()=>new Promise<string>(yes=>resolve=yes)),source=round(),pending=setup(generate).evaluate(id,source);await vi.waitFor(()=>expect(generate).toHaveBeenCalled());
 if(kind==='source')store.replaceHistory(id,store.listEvents(id,0).find(event=>event.kind==='user')!.id,'replacement');
 else if(kind==='execution')task.executions.push({id:'new',conversationId:'new-chat',request:'New work',latestRun:null});
 else {task.task.revision++;if(kind==='unlink')task.task.conversationIds=[];if(kind==='accept')task.task.state='completed';if(kind==='cancel')task.task.state='cancelled';}
 const before=task.task.state;resolve(result());await pending;expect(task.task.state).toBe(before);
 expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({systemTask:'taskProgress',status:'completed',applied:0,stale:1});
});
it('newer parallel conversation source supersedes old result even when newer reports no progress',async()=>{
 const second=store.createConversation({cli:'codex',projectId:'p',agentId:'a',model:null}).id;task.task.conversationIds.push(second);
 let resolve!:(value:string)=>void;const generate=vi.fn().mockImplementationOnce(()=>new Promise<string>(yes=>resolve=yes)).mockResolvedValue('[]'),service=setup(generate),first=round(),pending=service.evaluate(id,first);await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 await service.evaluate(second,{sourceEventId:store.appendEvent(second,'status',{status:'idle'}).id,user:'More',reply:'Nothing new'});resolve(result());await pending;expect(task.task.state).toBe('todo');
});
it('dedicated profile and inherited system fallback use the restricted generator',async()=>{
 const generate=vi.fn().mockResolvedValue('[]');config.system!.tasks={taskProgress:{cli:'omp',model:'judge'}};await setup(generate).evaluate(id,round());expect(generate.mock.calls[0][0]).toEqual({cli:'omp',model:'judge'});
 delete config.system!.tasks;await setup(generate).evaluate(id,round());expect(generate.mock.calls[1][0]).toEqual({cli:'codex',model:'default'});
 const usage=getUsage(store,{period:'today',timeZone:'UTC'});expect(usage.coverage.unknown).toBe(2);expect(usage.recent.every(row=>row.category==='taskProgress'&&row.conversationId===id&&row.projectId==='p')).toBe(true);
});
it('disabled profile never invokes a model and persists actionable failure',async()=>{
 config.runtimes=['codex'];config.system!.tasks={taskProgress:{cli:'omp'}};const generate=vi.fn();await setup(generate).evaluate(id,round());expect(generate).not.toHaveBeenCalled();expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({status:'failed',code:'runtime-disabled'});
});

it('completed and cancelled tasks are excluded before model invocation',async()=>{const generate=vi.fn();for(const state of ['completed','cancelled']){task.task.state=state;await setup(generate).evaluate(id,round());}expect(generate).not.toHaveBeenCalled();});

it('independent execution snapshots apply review coherently in one batch',async()=>{
 const {createTasks}=await import('../server/tasks');const real=createTasks(store),principal={userId:'local'},other=store.createConversation({agentId:'a',projectId:'p',cli:'codex',model:null});
 const first=createTaskWithExecutions(store,real,principal,{goal:'Complete report'},[id],'first'),second=createTaskWithExecutions(store,real,principal,{goal:'Complete collection'},[other.id],'second');
 const entries=[...real.snapshotProgress(principal,other.id),...real.snapshotProgress(principal,id)].map(snapshot=>({snapshot,state:'review' as const,guard:()=>true}));
 expect(real.applyTaskProgressBatch(principal,entries)).toEqual([true,true]);expect(real.getTask(principal,first.id).state).toBe('review');expect(real.getTask(principal,second.id).state).toBe('review');
});

it.each(['{}','not JSON',JSON.stringify([{taskId:'unlinked',state:'review',evidence:'Claimed'}]),JSON.stringify([{taskId:'t',state:'review',evidence:'One'},{taskId:'t',state:'review',evidence:'Two'}])])('invalid batch %s never partially applies',async output=>{
 await setup(vi.fn().mockResolvedValue(output)).evaluate(id,round());expect(tasks.applyTaskProgress).not.toHaveBeenCalled();expect(task.task.state).toBe('todo');expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({status:'failed',code:'invalid-output'});
});
it('closing aborts a generator that ignores cancellation and persists a failed diagnostic',async()=>{
 const generate=vi.fn((_config:unknown,_prompt:string,_signal:AbortSignal)=>new Promise<string>(()=>{})),service=setup(generate),pending=service.evaluate(id,round());await vi.waitFor(()=>expect(generate).toHaveBeenCalled());service.close();await pending;
 expect(generate.mock.calls[0][2].aborted).toBe(true);expect(task.task.state).toBe('todo');expect(store.listEvents(id,0).at(-1)?.data).toMatchObject({status:'failed',code:'cancelled'});
});

it('a failure writing the second Task progress result rolls back all states, revisions and outbox',async()=>{
 const {createTasks}=await import('../server/tasks');const real=createTasks(store),principal={userId:'local'},other=store.createConversation({agentId:'a',projectId:'p',cli:'codex',model:null});
 const first=createTaskWithExecutions(store,real,principal,{goal:'First goal'},[id],'first'),second=createTaskWithExecutions(store,real,principal,{goal:'Second goal'},[other.id],'second'),outbox=store.listOutbox(0);
 store.database.exec(`CREATE TRIGGER fail_second_progress BEFORE INSERT ON outbox WHEN NEW.type='task.progress_updated' AND NEW.aggregate_id='${second.id}' BEGIN SELECT RAISE(ABORT,'injected'); END`);
 const entries=[...real.snapshotProgress(principal,id),...real.snapshotProgress(principal,other.id)].map(snapshot=>({snapshot,state:'review' as const,guard:()=>true}));
 expect(()=>real.applyTaskProgressBatch(principal,entries)).toThrow();expect(real.getTask(principal,first.id)).toEqual(first);expect(real.getTask(principal,second.id)).toEqual(second);expect(store.listOutbox(0)).toEqual(outbox);
});

it('global progress switch skips generation and ignores an in-flight result after disabling',async()=>{
 config.system!.automaticTaskProgress=false;
 const generate=vi.fn().mockResolvedValue(result());
 const service=setup(generate);await service.evaluate(id,round());expect(generate).not.toHaveBeenCalled();
 config.system!.automaticTaskProgress=true;
 let resolve!:(value:string)=>void;generate.mockImplementationOnce(()=>new Promise<string>(yes=>resolve=yes));
 const pending=service.evaluate(id,round());await vi.waitFor(()=>expect(generate).toHaveBeenCalledOnce());
 config.system!.automaticTaskProgress=false;resolve(result());await pending;expect(task.task.state).toBe('todo');
});

it('disabling and re-enabling invalidates generation already in flight',async()=>{
 let epoch=0,resolve!:(value:string)=>void;const generate=vi.fn(()=>new Promise<string>(yes=>resolve=yes));
 const service=createTaskProgress({store,loadConfig:async()=>config,tasks,generate,settingsRevision:()=>epoch});services.push(service);
 const pending=service.evaluate(id,round());await vi.waitFor(()=>expect(generate).toHaveBeenCalled());
 epoch++;resolve(result());await pending;expect(task.task.state).toBe('todo');
});
