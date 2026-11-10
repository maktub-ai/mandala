import { ensureMandalaConversation } from './mandala';
import { workspacePrincipal } from './workspace-identity';
import { createHash, randomUUID } from "node:crypto";
import {isDeepStrictEqual} from 'node:util';
import { readFile } from "node:fs/promises";
import { createTasks } from "./tasks";
import { DomainError } from "../shared/workspace-contracts";
import { join } from "node:path";
import type { Automation as PublicAutomation, AutomationInput, AutomationRun, AutomationState, Schedule } from "../shared/automations";
import type { Config } from "../shared/types";
import { enabledRuntimes } from "../shared/runtimes";
import { projectWorkspaces, selectedWorkspace } from "../shared/workspaces";
import type { Store } from "./store";
import type { SessionManager } from "./sessions";

// Unmaterialized enabled windows only; clients cannot supply these server-owned cursors.
type Automation=PublicAutomation & {pendingWindows?:{nextRunAt:string;throughAt:string}[]};

function validateSchedule(value: Schedule) {
  if (!value || typeof value !== "object") throw new Error("invalid schedule");
  if (value.kind === 'interval') {
    if (!Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 525600 ||
        typeof value.anchor !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.anchor) || !Number.isFinite(Date.parse(value.anchor)))
      throw new Error('invalid schedule');
  } else if (value.kind === "once") {
    if (typeof value.at !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.at) || !Number.isFinite(Date.parse(value.at)))
      throw new Error("invalid schedule");
  } else if (!["daily", "weekly"].includes(value.kind) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.timeZone !== "string" || value.kind === "weekly" && (value.weekdays === undefined ? !Number.isInteger(value.weekday) || value.weekday! < 0 || value.weekday! > 6 : !Array.isArray(value.weekdays) || !value.weekdays.length || new Set(value.weekdays).size !== value.weekdays.length || value.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6) || value.weekday !== undefined && (value.weekdays.length !== 1 || value.weekdays[0] !== value.weekday))) {
    throw new Error("invalid schedule");
  } else {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(); }
    catch { throw new Error("invalid schedule time zone"); }
  }
}

// UTC minute traversal keeps named time zones correct through skipped and repeated local times.
export function nextScheduledTime(schedule: Schedule, after: Date, previous?: string): string | null {
  validateSchedule(schedule);
  if (schedule.kind === "once") return Date.parse(schedule.at) > after.getTime() ? new Date(schedule.at).toISOString() : null;
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchor), period = schedule.minutes * 60000;
    return new Date(anchor + Math.max(0, Math.floor((after.getTime() - anchor) / period) + 1) * period).toISOString();
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const local = (date: Date) => Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  const dateKey = (parts: ReturnType<typeof local>) => `${parts.year}-${parts.month}-${parts.day}`;
  const previousDay = previous ? dateKey(local(new Date(previous))) : "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const first = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let at = first; at <= first + (schedule.kind === "weekly" ? 15 : 3) * 86400000; at += 60000) {
    const parts = local(new Date(at));
    if (`${parts.hour}:${parts.minute}` === schedule.time && dateKey(parts) !== previousDay &&
        (schedule.kind === "daily" || (schedule.weekdays??[schedule.weekday!]).some(day=>weekdays[day] === parts.weekday))) return new Date(at).toISOString();
  }
  throw new Error("invalid schedule: no upcoming occurrence");
}

// Calendar lookback is bounded independently of the offline window. Unknown counts retain the honest range.
function dueCoverage(schedule:Schedule,firstDueAt:string,time:Date):NonNullable<AutomationRun['coverage']>{
  if(schedule.kind==='interval'){
    const count=Math.floor((time.getTime()-Date.parse(firstDueAt))/(schedule.minutes*60000))+1;
    return {firstDueAt,latestDueAt:new Date(Date.parse(firstDueAt)+(count-1)*schedule.minutes*60000).toISOString(),count};
  }
  if(schedule.kind==='once')return {firstDueAt,latestDueAt:firstDueAt,count:1};
  const cutoff=time.getTime()-16*86400000,complete=Date.parse(firstDueAt)>=cutoff;
  let latest=complete?firstDueAt:nextScheduledTime(schedule,new Date(cutoff))!,count=1;
  for(let i=0;i<17;i++){
    const next=nextScheduledTime(schedule,new Date(latest),latest);
    if(!next||Date.parse(next)>time.getTime())break;
    latest=next;count++;
  }
  return {firstDueAt,latestDueAt:latest,...(complete?{count}:{})};
}

function validateInput(value: AutomationInput, config: Config) {
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 ||
      typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > 50000 ||
      typeof value.enabled !== "boolean" || typeof value.projectId !== "string" || typeof value.agentId !== "string" ||
      !enabledRuntimes(config).includes(value.cli)) throw new Error("invalid automation");
  if([value.taskId,value.goalId,value.conversationId].some(id=>id!==undefined&&id!==null&&(typeof id!=='string'||!id.trim())))throw new Error('invalid automation binding');
  if(value.goalId&&value.taskId)throw new Error('invalid automation binding');
  if(value.missedPolicy!==undefined&&!['manual','latest','each'].includes(value.missedPolicy)||value.overlapPolicy!==undefined&&!['queue','coalesce'].includes(value.overlapPolicy)||value.missedPolicy==='each'&&value.overlapPolicy==='coalesce')throw new Error('invalid automation policy');
  if(value.executionMode!==undefined&&!['continuous','independent'].includes(value.executionMode))throw new Error('invalid execution mode');
  if(value.executionMode==='independent'&&value.conversationId)throw new Error('invalid automation binding');
  const main=config.agents.find(a=>a.id===value.agentId&&a.id===config.mandala?.agentId&&a.systemRole==='mandala');
  if(value.goalId&&value.conversationId&&value.executionMode===undefined)throw new Error('invalid automation binding');
  const project = config.projects.find(p => p.id === value.projectId);
  if (value.projectId && !project || value.agentId && !config.agents.some(a => a.id === value.agentId) || project && value.agentId && !main && !project.agentIds.includes(value.agentId))
    throw new Error("invalid automation Project or Agent");
  if (value.workspaceId !== undefined && value.workspaceId !== null && !projectWorkspaces(project).some(w => w.id === value.workspaceId))
    throw new Error("invalid automation workspace");
  validateSchedule(value.schedule);
}
const fields = ['executionMode','goalId','missedPolicy','overlapPolicy','taskId','conversationId','name','instructions','projectId','agentId','cli','workspaceId','enabled','schedule'];
function input(value:unknown):Partial<AutomationInput>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))throw new Error('invalid automation');
 return value as Partial<AutomationInput>;
}
const fail=(code:string,status=409):never=>{throw new DomainError(code,status,code);};
function validatedCommandKey(value:unknown):string|undefined {
 if(value===undefined)return undefined;
 if(typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value))return value;
 return fail('invalid_command_key',422);
}
export function createAutomations({home,store,manager,loadConfig,now=()=>new Date()}:{home:string;store:Store;manager:SessionManager;loadConfig:()=>Promise<Config>;now?:()=>Date}){
 const db=store.database,tasks=createTasks(store),root=workspacePrincipal(store);
 store.transaction(()=>db.exec(`CREATE TABLE IF NOT EXISTS automation_rules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS automation_occurrences(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automation_rules(id),scheduled_at TEXT,command_key TEXT UNIQUE,task_id TEXT UNIQUE REFERENCES work_tasks(id),disposition TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(automation_id,scheduled_at));
 CREATE TABLE IF NOT EXISTS automation_create_receipts(command_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS automation_legacy_import(id INTEGER PRIMARY KEY CHECK(id=1),raw TEXT NOT NULL,imported_at TEXT NOT NULL);`));
 store.transaction(()=>{
  const key='task_execution_002_rule_tasks';if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec(`ALTER TABLE automation_occurrences RENAME TO automation_occurrences_old;
   CREATE TABLE automation_occurrences(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automation_rules(id),scheduled_at TEXT,command_key TEXT UNIQUE,task_id TEXT REFERENCES work_tasks(id),disposition TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(automation_id,scheduled_at));
   INSERT INTO automation_occurrences SELECT * FROM automation_occurrences_old;
   DROP TABLE automation_occurrences_old;`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,now().toISOString());
 });
 store.transaction(()=>{
  const key='task_execution_003_legacy_run_links';if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  for(const row of db.prepare("SELECT * FROM automation_occurrences WHERE task_id IS NOT NULL AND json_extract(data,'$.runId') IS NULL").all()){
   const linked=db.prepare('SELECT id FROM task_runs WHERE task_id=? ORDER BY attempt').all(row.task_id as string);
   if(!linked.length)continue;
   const exact=db.prepare('SELECT DISTINCT run_id FROM task_command_dedup WHERE task_id=? AND command_key=? AND run_id IS NOT NULL').all(row.task_id as string,`dispatch:${row.task_id}`);
   const uniqueOccurrence=db.prepare('SELECT COUNT(*) n FROM automation_occurrences WHERE task_id=?').get(row.task_id as string)!.n===1;
   const runId=uniqueOccurrence&&(exact.length===1?exact[0].run_id:linked.length===1?linked[0].id:null);
   if(runId){const data=JSON.parse(row.data as string);db.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify({...data,runId}),row.id as string);}
   else db.prepare("UPDATE automation_occurrences SET disposition='unknown' WHERE id=? AND disposition='queued'").run(row.id as string);
  }
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,now().toISOString());
 });
 let ticking:Promise<void>|undefined;
 let chain:Promise<unknown>=Promise.resolve(),closed=false,timer:ReturnType<typeof setInterval>|undefined;
 const emit=(type:string,id:string,revision:number,payload:unknown)=>store.enqueueOutbox({type,aggregateId:id,aggregateRevision:revision,causationId:id,payload});
 let imported:Promise<void>|undefined;
 const migration=()=>imported??=(async()=>{
  if(db.prepare("SELECT key FROM schema_migrations WHERE key='durable_tasks_005_automations'").get())return;
  let raw:string|null=null;try{raw=await readFile(join(home,'automations.json'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const legacy=raw===null?{version:1,automations:[],runs:[]}:JSON.parse(raw);
  if(legacy.version!==1||!Array.isArray(legacy.automations)||!Array.isArray(legacy.runs))throw new Error('invalid automation storage');
  for(const a of legacy.automations){validateSchedule(a.schedule);if(typeof a.id!=='string'||typeof a.enabled!=='boolean')throw new Error('invalid automation storage');}
  store.transaction(()=>{
   if(raw!==null)db.prepare('INSERT INTO automation_legacy_import VALUES (1,?,?)').run(raw,now().toISOString());
   for(const a of legacy.automations)db.prepare('INSERT INTO automation_rules VALUES (?,1,0,?)').run(a.id,JSON.stringify({...a,revision:1}));
   for(const r of legacy.runs){
    if(!db.prepare('SELECT id FROM automation_rules WHERE id=?').get(r.automationId))db.prepare('INSERT INTO automation_rules VALUES (?,1,1,?)').run(r.automationId,JSON.stringify({id:r.automationId,revision:1,enabled:false,name:r.name}));
    db.prepare("INSERT INTO automation_occurrences VALUES (?,?,NULL,?,NULL,'legacy_unverified',?)").run(r.id,r.automationId,`legacy:${r.id}`,JSON.stringify({...r,status:'legacy_unverified',legacyStatus:r.status}));
   }
   db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('durable_tasks_005_automations',now().toISOString());
  });
 })();
 const serial=<T,>(fn:()=>T|Promise<T>):Promise<T>=>{const result=chain.then(async()=>{await migration();if(closed)throw new Error('Automation service closed');return fn();});chain=result.catch(()=>{});return result;};
 const rule=(id:string):Automation=>{const row=db.prepare('SELECT * FROM automation_rules WHERE id=? AND archived=0').get(id);if(!row)return fail('automation_not_found',404);return JSON.parse(row.data as string);};
 const save=(a:Automation)=>db.prepare('UPDATE automation_rules SET revision=?,data=? WHERE id=?').run(a.revision,JSON.stringify(a),a.id);
 const project=(row:Record<string,unknown>):AutomationRun=>{
  const base=JSON.parse(row.data as string) as AutomationRun;
  if(!row.task_id)return {...base,status:row.disposition as AutomationRun['status']};
  const task=tasks.getTask(root,row.task_id as string),run=base.runId?tasks.getRunControl(root,base.runId):undefined;
  return {...base,taskId:task.id,taskState:task.state,waitingReason:task.waitingReason,status:run?.state??(task.state==='cancelled'&&row.disposition==='queued'?'interrupted':row.disposition) as AutomationRun['status'],...(run?.routing?{conversationId:run.routing.executionConversationId}:{}),...(run?{runId:run.id}:{})};
 };
 const occurrence=(id:string)=>{const row=db.prepare('SELECT * FROM automation_occurrences WHERE id=?').get(id);if(!row)return fail('automation_occurrence_not_found',404);return row;};
 const goalTask=(a:Automation)=>a.goalId?tasks.getTask(root,a.goalId):undefined;
 const executionTask=(a:Automation,_id:string,persistBinding=true,snapshot?:AutomationRun)=>{
  const target=a.goalId??a.executionTaskId??a.taskId;
  if(target){const task=tasks.getTask(root,target);if(a.goalId&&!manager.coordination.ownership(target))fail('goal_not_owned');if(['cancelled','completed'].includes(task.state))fail('goal_not_active');return task;}
  const recipient=a.reportConversationId?store.getConversation(a.reportConversationId)?.agentId:undefined;
  const task=tasks.prepareCreate(root,{goal:snapshot?.goal??a.instructions,criteria:snapshot?.criteria??[],acceptance:snapshot?.acceptance??'human',projectId:a.projectId||null,assigneeAgentId:a.agentId||null,originConversationId:a.reportConversationId??null,...(recipient?{participantAgentIds:[recipient]}:{})},'automation-task:'+a.id+':'+(a.bindingGeneration??'initial')).commit();
  a.executionTaskId=task.id;if(persistBinding)save(a);return task;
 };
 const enqueue=(a:Automation,at:string,kind:'scheduled'|'manual',commandKey?:string,missed=false,coverage?:AutomationRun['coverage'])=>{
  const previous=kind==='scheduled'?db.prepare('SELECT * FROM automation_occurrences WHERE automation_id=? AND scheduled_at=?').get(a.id,at):db.prepare('SELECT * FROM automation_occurrences WHERE command_key=?').get(commandKey!);
  if(previous){if(previous.automation_id!==a.id)fail('idempotency_conflict');return project(previous);}
  const id=randomUUID(),data:AutomationRun={id,automationId:a.id,name:a.name,projectId:a.projectId,agentId:a.agentId,cli:a.cli,instructions:a.instructions,workspaceId:a.workspaceId,scheduledAt:at,createdAt:now().toISOString(),status:missed?'missed':'queued',...(a.reportConversationId?{reportConversationId:a.reportConversationId}:{}),...(coverage?{coverage}:{}),...(a.goalId?{goalId:a.goalId}:{}),...(a.taskId?{sourceTaskId:a.taskId}:{}),...(a.executionMode?{executionMode:a.executionMode}:{}),...(a.bindingGeneration?{bindingGeneration:a.bindingGeneration}:{}),...(a.executionTaskId?{executionTaskId:a.executionTaskId}:{}),overlapPolicy:a.overlapPolicy,schedule:a.schedule,ruleRevision:a.revision,...((a.conversationId||a.executionConversationId)?{conversationId:(a.conversationId||a.executionConversationId)!}:{})};
  if(!missed&&!a.agentId)fail('assignee_required',422);
  const goal=goalTask(a)??(a.taskId?tasks.getTask(root,a.taskId):undefined);if(goal&&['cancelled','completed'].includes(goal.state))fail('goal_not_active');
  let task=missed?undefined:executionTask(a,id);
  if(task&&['cancelled','completed'].includes(task.state))fail('goal_not_active');
  if(!missed&&!task){task=tasks.prepareCreate(root,{goal:a.instructions,acceptance:'human',projectId:a.projectId||null,assigneeAgentId:a.agentId||null},`automation-task:${a.id}`).commit();a.taskId=task.id;save(a);}
  if(task||goal){const snapshot=task??goal!;data.goal=snapshot.goal;if(!a.executionMode)data.instructions=snapshot.goal;data.criteria=snapshot.criteria;data.acceptance=snapshot.acceptance;}
  db.prepare('INSERT INTO automation_occurrences VALUES (?,?,?,?,?,?,?)').run(id,a.id,kind==='scheduled'?at:null,commandKey??null,task?.id??null,missed?'missed':'queued',JSON.stringify(data));
  emit('automation.occurrence_created',id,1,{automationId:a.id,occurrenceId:id,taskId:task?.id??null,disposition:data.status});
  return project(occurrence(id));
 };
 const validateBinding=(a:AutomationInput & Pick<Automation,'executionTaskId'|'executionConversationId'>)=>{
  if(a.goalId){const goal=tasks.getTask(root,a.goalId);if(!manager.coordination.ownership(goal.id)||goal.projectId!==(a.projectId||null))fail('rule_goal_binding_conflict',422);}

  for(const id of [a.taskId,a.executionTaskId])if(id){const task=tasks.getTask(root,id);if(task.projectId!==(a.projectId||null)||task.assigneeAgentId!==(a.agentId||null))fail('rule_task_binding_conflict',422);}
  for(const id of [a.conversationId,a.executionConversationId])if(id){const c=store.getConversation(id);if(c?.purpose==='mandala-main')fail('primary_conversation',422);if(!c||c.agentId!==a.agentId||(c.projectId||null)!==(a.projectId||null)||a.executionMode&&(c.cli!==a.cli||(c.workspaceId??null)!==(a.workspaceId??null)))fail('invalid_conversation_scope',422);}
 };
 const service={
  list:()=>serial(()=>({version:1 as const,automations:db.prepare('SELECT data FROM automation_rules WHERE archived=0 ORDER BY rowid').all().map(r=>{const a=JSON.parse(r.data as string) as Automation;const {pendingWindows,...publicRule}=a;return {...publicRule,...(pendingWindows?.length?{pendingFromAt:pendingWindows[0].nextRunAt,pendingThroughAt:pendingWindows[0].throughAt}:{}),catchingUp:!!pendingWindows?.length||!!a.nextRunAt&&a.enabled&&Date.parse(a.nextRunAt)<=now().getTime()};}),runs:db.prepare('SELECT * FROM automation_occurrences ORDER BY rowid').all().map(project)})),
  create:(value:unknown,key?:string,assertActive?:()=>void,origin?:{agentId:string;projectId:string;conversationId?:string})=>serial(async()=>{
   assertActive?.();const checkedKey=validatedCommandKey(key),body=input(value) as AutomationInput;
   const requestHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
   if(checkedKey){const receipt=db.prepare('SELECT request_hash,response FROM automation_create_receipts WHERE command_key=?').get(checkedKey);if(receipt){if(receipt.request_hash!==requestHash)fail('idempotency_conflict');return JSON.parse(receipt.response as string) as Automation;}}
   const config=await loadConfig();validateInput(body,config);assertActive?.();const nextRunAt=nextScheduledTime(body.schedule,now());
   const coordinator=config.mandala?.agentId;
   const source=origin?.conversationId?store.getConversation(origin.conversationId):undefined;
   if(origin?.conversationId&&(!source||source.agentId!==origin.agentId||source.projectId!==origin.projectId))fail('invalid_report_source',422);
   const reportConversationId=body.goalId?manager.coordination.ownership(body.goalId)?.conversationId:
    source&&origin?.agentId===coordinator?source.id:!origin&&body.agentId===coordinator?ensureMandalaConversation(store,config).id:undefined;
   const a:Automation={...body,...(reportConversationId?{reportConversationId}:{}),bindingGeneration:randomUUID(),...(origin?{createdByAgentId:origin.agentId,createdFromProjectId:origin.projectId}:{}),workspaceId:selectedWorkspace(config.projects.find(p=>p.id===body.projectId),body.workspaceId)?.id??null,executionMode:body.executionMode??(body.taskId?'continuous':'independent'),missedPolicy:body.missedPolicy??'latest',overlapPolicy:body.overlapPolicy??(body.missedPolicy==='each'?'queue':'coalesce'),enabled:false,name:body.name.trim(),instructions:body.instructions.trim(),id:randomUUID(),revision:1,createdAt:now().toISOString(),updatedAt:now().toISOString(),nextRunAt};
   validateInput(a,config);validateBinding(a);
   store.transaction(()=>{if(a.taskId){tasks.getTask(root,a.taskId);if(db.prepare("SELECT id FROM automation_rules WHERE archived=0 AND json_extract(data,'$.taskId')=?").get(a.taskId))fail('task_rule_exists');}db.prepare('INSERT INTO automation_rules VALUES (?,1,0,?)').run(a.id,JSON.stringify(a));emit('automation.created',a.id,1,{automationId:a.id});if(checkedKey)db.prepare('INSERT INTO automation_create_receipts VALUES (?,?,?)').run(checkedKey,requestHash,JSON.stringify(a));});return a;
  }),
  update:(id:string,value:unknown,assertActive?:()=>void)=>serial(async()=>{
   const config=await loadConfig();const {expectedRevision,...body}=(value??{}) as Record<string,unknown>;const old=rule(id);if(expectedRevision!==old.revision)fail('revision_conflict');
   const patch=input(body),a={...old,...patch,...(patch.overlapPolicy==='coalesce'&&patch.missedPolicy===undefined&&old.missedPolicy===undefined?{missedPolicy:'latest' as const}:{}),revision:old.revision+1,updatedAt:now().toISOString()};validateInput(a,config);assertActive?.();
   if(patch.taskId!==undefined&&patch.taskId!==old.taskId||patch.goalId!==undefined&&patch.goalId!==old.goalId)fail('rule_task_immutable');
   const changedScope=['executionMode','projectId','agentId','cli','workspaceId','conversationId'].some(key=>JSON.stringify(a[key as keyof Automation]??null)!==JSON.stringify(old[key as keyof Automation]??null));
   if(changedScope){
    if((a.executionMode||old.executionMode)&&db.prepare("SELECT 1 FROM automation_occurrences o WHERE o.automation_id=? AND (o.disposition='unknown' OR o.disposition='queued' AND (json_extract(o.data,'$.runId') IS NULL OR EXISTS(SELECT 1 FROM task_runs r WHERE r.id=json_extract(o.data,'$.runId') AND r.state IN ('queued','starting','running','approval','unknown')))) LIMIT 1").get(id))fail('automation_work_pending');
    a.bindingGeneration=randomUUID();delete a.executionTaskId;delete a.executionConversationId;
   }
   validateBinding(a);
   if(a.enabled&&!a.agentId)fail('assignee_required',422);
   const changedSchedule=patch.schedule!==undefined&&JSON.stringify(patch.schedule)!==JSON.stringify(old.schedule);
   const backlog=!!old.pendingWindows?.length||!!old.nextRunAt&&old.enabled&&Date.parse(old.nextRunAt)<=now().getTime();
   if(backlog&&(changedSchedule||patch.missedPolicy!==undefined&&patch.missedPolicy!==(old.missedPolicy??'manual')||patch.overlapPolicy!==undefined&&patch.overlapPolicy!==(old.overlapPolicy??'queue')))fail('automation_catchup_pending');
   if(old.enabled&&patch.enabled===false){
    if(old.nextRunAt&&Date.parse(old.nextRunAt)<=now().getTime())a.pendingWindows=[...(old.pendingWindows??[]),{nextRunAt:old.nextRunAt,throughAt:now().toISOString()}];
    a.nextRunAt=nextScheduledTime(a.schedule,now());
   }
   if(changedSchedule||patch.enabled===true&&!old.enabled)a.nextRunAt=nextScheduledTime(a.schedule,now());
   if(a.enabled&&!a.nextRunAt&&(changedSchedule||patch.enabled===true&&!old.enabled))throw new Error('one-time schedule must be in the future');
   store.transaction(()=>{if(rule(id).revision!==expectedRevision)fail('revision_conflict');save(a);emit('automation.updated',id,a.revision,{automationId:id});});return {...a,unchanged:isDeepStrictEqual({...old,revision:a.revision,updatedAt:a.updatedAt},a)};
  }),
  remove:(id:string,expectedRevision:number)=>serial(()=>store.transaction(()=>{const a=rule(id);if(a.revision!==expectedRevision)fail('revision_conflict');db.prepare('UPDATE automation_rules SET archived=1,revision=revision+1 WHERE id=?').run(id);emit('automation.archived',id,a.revision+1,{automationId:id});})),
  runNow:(id:string,commandKey:string=randomUUID(),assertActive?:()=>void)=>serial(async()=>{const key=validatedCommandKey(commandKey);assertActive?.();const previous=db.prepare('SELECT * FROM automation_occurrences WHERE command_key=?').get(key!);if(previous){if(previous.automation_id!==id)fail('idempotency_conflict');return project(previous);}const a=rule(id);validateInput(a,await loadConfig());assertActive?.();validateBinding(a);return store.transaction(()=>enqueue(a,now().toISOString(),'manual',key));}),
  catchUp:(id:string,commandKey:string)=>serial(()=>store.transaction(()=>{
   const row=occurrence(id);if(row.task_id)return project(row);if(row.disposition!=='missed')fail('occurrence_not_missed');
   const frozen=JSON.parse(row.data as string) as AutomationRun;
   const current=rule(frozen.automationId);
   const sameScope=['executionMode','projectId','agentId','cli','workspaceId'].every(key=>JSON.stringify(current[key as keyof Automation]??null)===JSON.stringify(frozen[key as keyof AutomationRun]??null));
   const sameBinding=sameScope&&!!frozen.bindingGeneration&&frozen.bindingGeneration===current.bindingGeneration&&(!frozen.executionTaskId||!current.executionTaskId||frozen.executionTaskId===current.executionTaskId);
   const historical=frozen.executionMode==='continuous'&&frozen.bindingGeneration?db.prepare("SELECT task_id,data FROM automation_occurrences WHERE automation_id=? AND task_id IS NOT NULL AND json_extract(data,'$.executionMode')='continuous' AND json_extract(data,'$.bindingGeneration')=? ORDER BY rowid LIMIT 1").get(frozen.automationId,frozen.bindingGeneration):undefined;
   const historicalChat=historical?(JSON.parse(historical.data as string) as AutomationRun).conversationId:undefined;
   const a:Automation=frozen.executionMode?{...current,...frozen,id:current.id,taskId:frozen.sourceTaskId,goalId:frozen.goalId,reportConversationId:frozen.reportConversationId,executionTaskId:frozen.executionTaskId??(historical?.task_id as string|undefined)??(sameBinding?current.executionTaskId:undefined),executionConversationId:frozen.conversationId??historicalChat??(sameBinding?current.executionConversationId:undefined),conversationId:frozen.conversationId,schedule:frozen.schedule!}:current;
   if(!frozen.executionMode&&!a.taskId&&!a.goalId)fail('rule_task_missing');validateBinding(a);
   const task=executionTask(a,id,false,frozen)!;if(['cancelled','completed'].includes(task.state))fail('goal_not_active');if(!task.assigneeAgentId)fail('assignee_required',422);
   if(frozen.executionMode==='continuous'){frozen.executionTaskId=task.id;if(sameBinding){current.executionTaskId=a.executionTaskId;save(current);}}if(a.executionConversationId)frozen.conversationId=a.executionConversationId;
   frozen.goal??=frozen.instructions;frozen.criteria??=[];frozen.acceptance??='human';db.prepare("UPDATE automation_occurrences SET task_id=?,disposition='queued',data=? WHERE id=?").run(task.id,JSON.stringify(frozen),id);emit('automation.catchup_requested',id,1,{occurrenceId:id,taskId:task.id});return project(occurrence(id));
  })),
  stopRun:(id:string)=>serial(async()=>{const row=occurrence(id),data=JSON.parse(row.data as string) as AutomationRun;
   if(data.runId){const run=tasks.getRunControl(root,data.runId);if(['queued','starting','running','approval','unknown'].includes(run.state))await manager.stopDurableTask(row.task_id as string);}
   else if(row.disposition==='queued')store.transaction(()=>{db.prepare("UPDATE automation_occurrences SET disposition='interrupted' WHERE id=?").run(id);emit('automation.occurrence_stopped',id,1,{occurrenceId:id});});
   return project(occurrence(id));}),
  tick():Promise<void>{
   if(ticking)return ticking;
   ticking=(async()=>{
   const jobs=await serial(()=>{
    const currentTime=now();
    store.transaction(()=>{
     for(const row of db.prepare('SELECT data FROM automation_rules WHERE archived=0').all()){
      const a=JSON.parse(row.data as string) as Automation;if(!a.enabled&&!a.pendingWindows?.length)continue;
      if([a.goalId,a.taskId,a.executionTaskId].some(id=>id&&['cancelled','completed'].includes(tasks.getTask(root,id).state))){a.enabled=false;delete a.pendingWindows;save(a);continue;}
      try{validateBinding(a);}catch{a.enabled=false;save(a);emit('automation.attention',a.id,a.revision,{automationId:a.id,reason:'binding_changed'});continue;}
      const policy=a.missedPolicy??'manual',merge=a.overlapPolicy==='coalesce';
      if(policy==='latest'&&!merge&&a.pendingWindows?.length){
       if(a.enabled&&a.nextRunAt&&Date.parse(a.nextRunAt)<=currentTime.getTime())delete a.pendingWindows;
       else a.pendingWindows=[a.pendingWindows.at(-1)!];
      }
      for(let budget=100;budget>0;){
       const window=a.pendingWindows?.[0],cursor=window?.nextRunAt??(a.enabled?a.nextRunAt:null),time=window?new Date(window.throughAt):currentTime;
       if(!cursor||Date.parse(cursor)>time.getTime()){if(window){a.pendingWindows!.shift();continue;}break;}
       const minute=Math.floor(currentTime.getTime()/60000)*60000;
       let next:string|null;
       if(policy==='latest'||merge){
        const coverage=dueCoverage(a.schedule,cursor,time),missed=policy==='manual'&&Date.parse(coverage.latestDueAt)<minute;
        const pending=merge?db.prepare("SELECT o.* FROM automation_occurrences o WHERE o.automation_id=? AND o.disposition=? AND (?=0 OR o.scheduled_at IS NOT NULL) AND (json_extract(o.data,'$.runId') IS NULL OR EXISTS(SELECT 1 FROM task_runs r WHERE r.id=json_extract(o.data,'$.runId') AND r.task_id=o.task_id AND r.state='queued')) ORDER BY o.rowid").all(a.id,missed?'missed':'queued',a.executionMode?1:0).find(row=>{
         if(!a.executionMode)return true; // Legacy coalescing keeps its current-goal semantics.
         const frozen=JSON.parse(row.data as string) as AutomationRun;
         const contract=a.executionMode==='continuous'&&!missed&&(a.executionTaskId||a.taskId)?tasks.getTask(root,(a.executionTaskId||a.taskId)!):goalTask(a)??(a.taskId?tasks.getTask(root,a.taskId):undefined);
         return (!contract||(['goal','criteria','acceptance'] as const).every(key=>JSON.stringify(frozen[key])===JSON.stringify(contract[key])))&&
           ['bindingGeneration','executionMode','projectId','agentId','cli','workspaceId','instructions','schedule','overlapPolicy','goalId'].every(key=>JSON.stringify(frozen[key as keyof AutomationRun]??null)===JSON.stringify(a[key as keyof Automation]??null))&&
          (frozen.sourceTaskId??null)===(a.taskId??null)&&
          ((!frozen.conversationId&&!a.conversationId)||(frozen.conversationId??null)===(a.conversationId??a.executionConversationId??null));
        }):undefined;
        if(pending){const data=JSON.parse(pending.data as string) as AutomationRun,old=data.coverage??{firstDueAt:data.scheduledAt,latestDueAt:data.scheduledAt,count:1};
         data.coverage={firstDueAt:old.firstDueAt,latestDueAt:coverage.latestDueAt,...(old.count!==undefined&&coverage.count!==undefined?{count:old.count+coverage.count}:{})};
         db.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify(data),pending.id as string);emit('automation.occurrence_coalesced',pending.id as string,1,{coverage:data.coverage});
        }else enqueue(a,coverage.latestDueAt,'scheduled',undefined,missed,coverage);
        next=nextScheduledTime(a.schedule,new Date(coverage.latestDueAt),coverage.latestDueAt);
       }else{
        enqueue(a,cursor,'scheduled',undefined,policy==='manual'&&Date.parse(cursor)<minute);next=nextScheduledTime(a.schedule,new Date(cursor),cursor);
       }
       budget--;
       if(window){if(!next||Date.parse(next)>time.getTime())a.pendingWindows!.shift();else window.nextRunAt=next;}
       else a.nextRunAt=next;
      }
      if(!a.pendingWindows?.length)delete a.pendingWindows;
      save(a);
     }
    });
    return db.prepare("SELECT o.* FROM automation_occurrences o WHERE task_id IS NOT NULL AND disposition='queued' AND json_extract(o.data,'$.runId') IS NULL AND NOT EXISTS(SELECT 1 FROM work_tasks t WHERE t.id=o.task_id AND t.state='cancelled') ORDER BY rowid").all();
   });
   for(const row of jobs){if(closed)return;
    const frozen=JSON.parse(row.data as string) as AutomationRun;
    if([frozen.goalId,frozen.sourceTaskId,row.task_id as string].some(id=>id&&['completed','cancelled'].includes(tasks.getTask(root,id).state))){db.prepare("UPDATE automation_occurrences SET disposition='interrupted' WHERE id=?").run(row.id as string);continue;}

    const blocked=db.prepare("SELECT 1 FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown') LIMIT 1").get(row.task_id as string)||db.prepare("SELECT 1 FROM automation_occurrences o JOIN task_runs r ON r.task_id=o.task_id WHERE o.automation_id=? AND o.id<>? AND r.id=json_extract(o.data,'$.runId') AND r.state IN ('queued','starting','running','approval','unknown') LIMIT 1").get(row.automation_id as string,row.id as string);if(blocked)continue;
    try{const data=JSON.parse(row.data as string) as AutomationRun;
     if(!data.executionMode&&data.overlapPolicy==='coalesce')store.transaction(()=>{const current=tasks.getTask(root,data.goalId??row.task_id as string);data.goal=current.goal;data.instructions=current.goal;data.criteria=current.criteria;data.acceptance=current.acceptance;
      if(data.goalId){const child=tasks.getTask(root,row.task_id as string);tasks.prepareUpdate(root,child.id,child.revision,{goal:current.goal,criteria:current.criteria},'automation-refresh:'+data.id).commit();}
      db.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify(data),row.id as string);
     });
     const run=await manager.startAutomationTask(row.task_id as string,data);store.transaction(()=>{data.runId=run.id;db.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify(data),row.id as string);});}catch{
    if(occurrence(row.id as string).disposition!=='queued')continue;
    // Preparation failure has not sent native work. Expose input-required, do not retry each tick.
    await serial(()=>store.transaction(()=>{db.prepare("UPDATE work_tasks SET state='waiting',waiting_reason='input',revision=revision+1 WHERE id=? AND state='todo'").run(row.task_id as string);db.prepare("UPDATE automation_occurrences SET disposition='unknown' WHERE id=?").run(row.id as string);emit('task.execution_attention',row.task_id as string,1,{taskId:row.task_id,occurrenceId:row.id,reason:'input',state:'input'});}));
   }}
   })().finally(()=>{ticking=undefined;});return ticking;
  },
  start(){if(timer||closed)return;const check=()=>{if(!closed)void service.tick().catch(()=>{if(!closed)console.error('Automation scheduler failed');});};timer=setInterval(check,1000);timer.unref();check();},
  hasActiveWork(){return !!ticking;},
  close(){closed=true;if(timer)clearInterval(timer);},
 };
 manager.setAutomationService?.(service);
 return service;
}
export type Automations=ReturnType<typeof createAutomations>;
