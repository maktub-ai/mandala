import type {Store} from './store';
import type {Task} from '../shared/tasks';
import type {BlueprintRecordInput} from '../shared/blueprint';
import {DomainError} from '../shared/workspace-contracts';

export type WorkerBlueprint={conversationId:string;invocationId:string;projectId:string;planId:string;agentId:string;taskId?:string};
type RecordContent=BlueprintRecordInput;
type Contributor={project:string;agent:string;explicit:boolean};
type Candidate={projectId:string;entries:RecordContent[];authors:Contributor[];fallback:RecordContent};
type WriteRecord=(projectId:string,record:RecordContent,key:string,expectedPlanId:string,assertAuthorized:()=>void)=>Promise<{id:string}>;

function internalReference(text:string,ids:string[]){
 const tagged=/(?:\b(?:task|project|agent|conversation|execution|invocation|nativeSession|nativeTurn|run)[_-]?id\b|(?:任务|项目|智能体|会话|执行)\s*(?:ID|标识符?))["']?\s*[:=：]/i;
 const labels=new Set(text.match(/[a-z0-9_:-]+/ig)??[]);
 return tagged.test(text)||/(?:[?&](?:conversation|agent|project|task)=|\/(?:tasks|projects|agents)\/[^\s]+|mandala:\/\/)/i.test(text)||ids.some(id=>id.length>=8&&/[-_:0-9]/.test(id)&&labels.has(id));
}
function content(input:Record<string,unknown>,internalIds:string[]):RecordContent {
 const valid=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
 if(Object.keys(input).some(k=>!['result','decisions','lanes'].includes(k))||!valid(input.result,4000))throw new DomainError('invalid_blueprint_record',422,'A project result is required');
 const list=(key:string,limit:number)=>{
  const value=input[key]??[];
  if(!Array.isArray(value)||value.length>12||!value.every(item=>valid(item,limit)))throw new DomainError('invalid_blueprint_record',422,'Invalid decisions or lanes');
  return [...new Set((value as string[]).map(item=>item.trim()))];
 };
 const entry={result:input.result.trim(),decisions:list('decisions',600),lanes:list('lanes',120)};
 const text=[entry.result,...entry.decisions,...entry.lanes].join('\n');
 if(internalReference(text,internalIds))throw new DomainError('invalid_blueprint_record',422,'Use human-readable results without Mandala identifiers or links');
 return entry;
}

export function createBlueprintRuntime(store:Store,planFor:(projectId:string)=>string|undefined,write:WriteRecord,canPublish:(projectId:string,agentId:string,explicit:boolean)=>boolean,readLanes?:(projectId:string,planId:string)=>Promise<string[]>){
 const db=store.database;
 db.exec(`CREATE TABLE IF NOT EXISTS blueprint_workers(
  invocation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,plan_id TEXT NOT NULL,
  task_id TEXT,started_at TEXT NOT NULL,finished_at TEXT,outcome TEXT,draft TEXT,accepted INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS blueprint_worker_task ON blueprint_workers(task_id);
  CREATE TABLE IF NOT EXISTS blueprint_worker_commands(invocation_id TEXT NOT NULL,command_key TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(invocation_id,command_key));
  CREATE TABLE IF NOT EXISTS blueprint_publications(
   task_id TEXT NOT NULL,revision INTEGER NOT NULL,plan_id TEXT NOT NULL,candidates TEXT NOT NULL,recorded INTEGER NOT NULL DEFAULT 0,record_id TEXT,payload TEXT,last_attempt TEXT,last_error TEXT,
   PRIMARY KEY(task_id,revision,plan_id));
  CREATE INDEX IF NOT EXISTS blueprint_pending_publications ON blueprint_publications(last_attempt) WHERE recorded=0;`);
 let flushing:Promise<void>|undefined,requested=false;
 const hasStoreId=(text:string)=>{
  const ids=text.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/ig)??[];
  return ids.some(id=>db.prepare('SELECT id FROM work_tasks WHERE id=? UNION ALL SELECT id FROM conversations WHERE id=? UNION ALL SELECT id FROM task_executions WHERE id=? UNION ALL SELECT id FROM task_runs WHERE id=? LIMIT 1').get(id,id,id,id));
 };
 const flush=()=>{
  if(flushing){requested=true;return flushing;}
  flushing=(async()=>{do{
   requested=false;
   const rows=db.prepare('SELECT * FROM blueprint_publications WHERE recorded=0 ORDER BY last_attempt, revision LIMIT 50').all();
   for(const row of rows){
    const planId=String(row.plan_id),args=[String(row.task_id),Number(row.revision),planId] as const;
    db.prepare('UPDATE blueprint_publications SET last_attempt=? WHERE task_id=? AND revision=? AND plan_id=?').run(new Date().toISOString(),...args);
    const candidates=JSON.parse(String(row.candidates)) as Candidate[];
    const available=candidates.filter(candidate=>planFor(candidate.projectId)===planId);
    if(!available.length)continue;
    let frozen=row.payload?JSON.parse(String(row.payload)) as {project:string;contributors:Contributor[];record:RecordContent}:null;
    const savePayload=(value:NonNullable<typeof frozen>)=>db.prepare('UPDATE blueprint_publications SET payload=? WHERE task_id=? AND revision=? AND plan_id=?').run(JSON.stringify(value),...args);
    if(!frozen){
     const contributing=available.filter(candidate=>candidate.entries.length);
     const entries=contributing.flatMap(candidate=>candidate.entries);
     const record=entries.length?{result:[...new Set(entries.map(e=>e.result))].join('\n'),decisions:[...new Set(entries.flatMap(e=>e.decisions))],lanes:[...new Set(entries.flatMap(e=>e.lanes))]}:available[0].fallback;
     frozen={project:available[0].projectId,contributors:(contributing.length?contributing:[available[0]]).flatMap(candidate=>candidate.authors),record};savePayload(frozen);
    }
    const delivery=frozen;
    const assertAuthorized=()=>{
     if(planFor(delivery.project)!==planId||delivery.contributors.some(c=>planFor(c.project)!==planId||!canPublish(c.project,c.agent,c.explicit)))throw new DomainError('blueprint_scope_changed',403,'Project access changed');
    };
    try{
     assertAuthorized();
     const published=await write(frozen.project,frozen.record,JSON.stringify(args),planId,assertAuthorized);
     db.prepare('UPDATE blueprint_publications SET recorded=1,record_id=?,last_error=NULL WHERE task_id=? AND revision=? AND plan_id=?').run(published.id,...args);
    }catch(error){
     const code=error instanceof DomainError?error.code:'blueprint_write_unavailable';
     db.prepare('UPDATE blueprint_publications SET last_error=? WHERE task_id=? AND revision=? AND plan_id=?').run(code,...args);
     if(code==='blueprint_lane_missing'&&readLanes){
      // An outside editor may have retired a module since the worker staged its result.
      const current=await readLanes(frozen.project,planId).catch(()=>null);
      if(!current)continue;
      const retired=frozen.record.lanes.filter(lane=>!current.includes(lane));
      if(retired.length){
       frozen.record={...frozen.record,result:frozen.record.result+'\n历史模块：'+retired.join('、'),lanes:frozen.record.lanes.filter(lane=>current.includes(lane))};
       savePayload(frozen);requested=true;
      }
     }
    }
   }
  }while(requested);})().finally(()=>{flushing=undefined;});
  return flushing;
 };
 return {
  start(scope:WorkerBlueprint){
   db.prepare('INSERT OR IGNORE INTO blueprint_workers(invocation_id,conversation_id,agent_id,project_id,plan_id,task_id,started_at) VALUES(?,?,?,?,?,?,?)').run(scope.invocationId,scope.conversationId,scope.agentId,scope.projectId,scope.planId,scope.taskId??null,new Date().toISOString());
  },
  finish(invocationId:string,outcome:string){
   db.prepare('UPDATE blueprint_workers SET finished_at=?,outcome=? WHERE invocation_id=? AND finished_at IS NULL').run(new Date().toISOString(),outcome,invocationId);
  },
  stage(scope:WorkerBlueprint,task:Task,input:Record<string,unknown>,key:string){
   if(!key?.trim()||key.length>200)throw new DomainError('invalid_command_key',422,'Command key required');
   if(['completed','cancelled'].includes(task.state)||!task.projectIds.includes(scope.projectId)||!task.executions.some(e=>!e.supersededByExecutionId&&e.conversationId===scope.conversationId&&(e.attributedProjectId??e.projectId)===scope.projectId))throw new DomainError('blueprint_task_unavailable',403,'An active execution in this Project is required');
   const value=content(input,[task.id,scope.projectId,scope.agentId,...task.projectIds,scope.conversationId,scope.invocationId,...task.executions.flatMap(e=>[e.id,e.agentId,e.conversationId,e.latestRun?.id??''])]);
   if(hasStoreId([value.result,...value.decisions,...value.lanes].join(' ')))throw new DomainError('invalid_blueprint_record',422,'Omit Mandala identifiers from the public record');
   const json=JSON.stringify(value);
   return store.transaction(()=>{
    const previous=db.prepare('SELECT content FROM blueprint_worker_commands WHERE invocation_id=? AND command_key=?').get(scope.invocationId,key);
    if(previous){
     if(previous.content!==json)throw new DomainError('idempotency_conflict',409,'This command key was already used for different results');
     return {staged:true};
    }
    const saved=db.prepare('UPDATE blueprint_workers SET task_id=?,draft=? WHERE invocation_id=? AND conversation_id=? AND project_id=? AND plan_id=? AND (task_id IS NULL OR task_id=?) AND accepted=0 AND finished_at IS NULL').run(task.id,json,scope.invocationId,scope.conversationId,scope.projectId,scope.planId,task.id);
    if(!saved.changes)throw new DomainError('blueprint_scope_expired',403,'Worker scope expired');
    const pending=db.prepare('SELECT draft FROM blueprint_workers WHERE task_id=? AND plan_id=? AND accepted=0 AND draft IS NOT NULL').all(task.id,scope.planId).map(row=>JSON.parse(String(row.draft)) as RecordContent);
    if([...new Set(pending.map(e=>e.result))].join('\n').length+pending.flatMap(e=>e.lanes).join('、').length+20>24000||new Set(pending.flatMap(e=>e.decisions)).size>64||new Set(pending.flatMap(e=>e.lanes)).size>50)throw new DomainError('blueprint_record_too_long',422,'Summarize the combined project record before staging');
    db.prepare('INSERT INTO blueprint_worker_commands VALUES(?,?,?)').run(scope.invocationId,key,json);
    return {staged:true};
   });
  },
  complete(task:Task){
   if(!db.isTransaction)throw new Error('Task acceptance transaction required');
   const byPlan=new Map<string,Candidate[]>();
   for(const projectId of task.projectIds){
    const planId=planFor(projectId);if(!planId)continue;
    const executions=task.executions.filter(e=>!e.supersededByExecutionId&&(e.attributedProjectId??e.projectId)===projectId&&canPublish(projectId,e.agentId,e.projectId===projectId));
    const dispatch=task.projectId===projectId&&(!task.creatorAgentId||canPublish(projectId,task.creatorAgentId,true));
    if(task.projectIdsMode!=='manual'&&!dispatch&&!executions.length)continue;
    const chats=new Map(executions.map(e=>[e.conversationId,e]));
    const drafts=db.prepare(`SELECT w.draft,w.conversation_id,w.agent_id FROM blueprint_workers w LEFT JOIN task_runs r ON r.id=w.invocation_id
     WHERE w.task_id=? AND w.project_id=? AND w.plan_id=? AND w.accepted=0 AND w.draft IS NOT NULL
     AND ((r.id IS NULL AND (w.outcome IS NULL OR w.outcome='succeeded')) OR r.state='succeeded') ORDER BY w.started_at,w.invocation_id`).all(task.id,projectId,planId)
     .filter(r=>chats.get(String(r.conversation_id))?.agentId===r.agent_id);
    const entries=drafts.map(r=>JSON.parse(String(r.draft)) as RecordContent);
    // Inferred work without a staged draft still depends on a verified project executor.
    const sources=drafts.length?drafts.map(r=>chats.get(String(r.conversation_id))!):!dispatch&&task.projectIdsMode!=='manual'?executions:[];
    const authors=sources.map(e=>({project:projectId,agent:e.agentId,explicit:e.projectId===projectId}));
    const lane=task.moduleRef?.projectId===projectId?task.moduleRef.lane:null;
    const acceptedBy={checks:'任务已通过配置的检查并完成验收。',agent:'智能体确认任务已完成。',user:'用户确认任务已完成。',delivery:'任务已根据交付物完成验收。'};
    const ids=[task.id,projectId,task.assigneeAgentId??'',...task.participantAgentIds,...task.executions.flatMap(e=>[e.id,e.agentId,e.conversationId])];
    const fallback={result:task.completion?acceptedBy[task.completion.completedBy]:'任务已标记完成。',decisions:[],lanes:lane&&!internalReference(lane,ids)&&!hasStoreId(lane)?[lane]:[]};
    if(!byPlan.has(planId))byPlan.set(planId,[]);
    byPlan.get(planId)!.push({projectId,entries,authors,fallback});
   }
   for(const [planId,candidates] of byPlan)db.prepare('INSERT OR IGNORE INTO blueprint_publications(task_id,revision,plan_id,candidates) VALUES(?,?,?,?)').run(task.id,task.revision,planId,JSON.stringify(candidates));
   db.prepare('UPDATE blueprint_workers SET accepted=1 WHERE task_id=?').run(task.id);
   return byPlan.size>0;
  },
  recordsFor(taskId:string,planId:string){return new Set(db.prepare('SELECT record_id FROM blueprint_publications WHERE task_id=? AND plan_id=? AND recorded=1').all(taskId,planId).map(row=>String(row.record_id)));},
  flush
 };
}
