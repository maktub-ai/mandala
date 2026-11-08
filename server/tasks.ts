import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store';
import { retainNativeOccupancy } from './task-recovery';
import {taskActivity} from './task-progress-view';
import type { createAssets } from './assets';
import { initializeTaskSchema } from './task-schema';
import type { TaskExecution, TaskExecutionInput, Criterion, ContextSnapshot, Continuation, Receipt, Run, RunControl, RunIdentity, RunRouting, Task, TaskInput, TaskPatch, TaskProgressSnapshot, TaskProgressState, PlanStepInput, TerminalRunEvent, ExpectedOutput } from '../shared/tasks';
import {isHumanInput} from '../shared/tasks';
import { DomainError, type Principal, type VersionRef } from '../shared/workspace-contracts';

// Supplied by the trusted configuration/context service, never by a model tool argument.
export type TaskResolver = (principal: Principal, task: Task) => {
 agentId: string; projectId: string | null; hostId: string; input: string;
 sourceVersions: VersionRef[]; requiredOutputAssetIds: string[];
 effectiveCapabilities: ContextSnapshot['effectiveCapabilities']; nativeVisibility: 'partial';
 continuation?: Continuation;
 reportRule?: NonNullable<Run['snapshot']>['rule'];
};
type TaskOptions = { authorizeObservation?: (principal: Principal) => Promise<void>; resolve?: TaskResolver; authorizeConversation?: (principal: Principal, id: string) => void; assets?: Pick<ReturnType<typeof createAssets>, 'getAuthorizedVersion' | 'getAuthorizedAsset' | 'readAssetFile'> };
const fail = (code: string, status: number): never => { throw new DomainError(code, status, code); };
function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
 return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const terminalStates = new Set(['succeeded', 'failed', 'interrupted', 'legacy_unverified']);
const parse = <T>(value: unknown): T => JSON.parse(value as string) as T;

export function createTasks(store: Store, options: TaskOptions = {}) {
 const db = store.database;
 initializeTaskSchema(store);
 const taskRow = (row: Record<string, unknown>): Task => ({
  ...taskActivity(store,row.id as string,row.created_at as string),
  creationSource:(db.prepare('SELECT source FROM task_creation_sources WHERE task_id=?').get(row.id as string)?.source??(row.creator_agent_id?'agent':'unknown')) as Task['creationSource'],
  id: row.id as string, ownerUserId: row.owner_user_id as string, creatorAgentId: row.creator_agent_id as string | null,
  automaticProgress: Boolean(row.automatic_progress), goal: row.goal as string, criteria: parse(row.criteria), acceptance: row.acceptance as Task['acceptance'],
  projectId: row.project_id as string | null, assigneeAgentId: row.assignee_agent_id as string | null, originConversationId: row.origin_conversation_id as string | null, executions: executionRows(row.id as string),
  participantAgentIds: db.prepare('SELECT agent_id FROM task_participants WHERE task_id=? ORDER BY agent_id').all(row.id as string).map(r=>r.agent_id as string),
  conversationIds: executionRows(row.id as string).filter(execution=>!execution.supersededByExecutionId).map(execution=>execution.conversationId),
  state: row.state as Task['state'], waitingReason: row.waiting_reason as Task['waitingReason'], revision: Number(row.revision),
  continuationEpoch: Number(row.continuation_epoch), futureAutoResume: Boolean(row.future_auto_resume), completion: row.completion ? parse(row.completion) : null,
  legacyId: row.legacy_id as string | null, createdAt: row.created_at as string,
 });
 const loadTask = (id: string): Task => { const row = db.prepare('SELECT * FROM work_tasks WHERE id=?').get(id); return row ? taskRow(row) : fail('task_not_found', 404); };
 const authorize = (p: Principal, task: Pick<Task, 'ownerUserId' | 'creatorAgentId' | 'assigneeAgentId' | 'participantAgentIds' | 'executions'>) => {
  if (!p.userId || p.userId !== task.ownerUserId || p.agentId !== undefined && p.agentId !== task.creatorAgentId && p.agentId !== task.assigneeAgentId && !task.participantAgentIds.includes(p.agentId) && !task.executions.some(execution=>execution.agentId===p.agentId)) fail('forbidden', 403);
 };
 const getTask = (p: Principal, id: string) => { const task = loadTask(id); authorize(p, task); return task; };
 const waitingForDirectory=(id:string,state:unknown)=>state==='queued'&&Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='task_directory_waits'").get()&&db.prepare("SELECT owner_id FROM task_directory_waits WHERE kind='run' AND owner_id=?").get(id));
 const monitor=(r:Record<string,unknown>):import('../shared/tasks').ExecutionMonitor=>{
  const event=db.prepare("SELECT createdAt FROM events WHERE json_extract(data,'$.runId')=? AND kind IN ('text','tool','approval','error') ORDER BY id DESC LIMIT 1").get(r.id as string);
  const lastProgressAt=event?.createdAt as string|undefined,state=r.state as string;
  const observed=db.prepare("SELECT name FROM sqlite_master WHERE name='task_run_observations'").get()?db.prepare('SELECT * FROM task_run_observations WHERE run_id=?').get(r.id as string):undefined;
  const observation=observed&&(!lastProgressAt||Date.parse(observed.checked_at as string)>=Date.parse(lastProgressAt))?observed:undefined;
  const reason=observation?.native_state==='unreachable'?'host_offline':observation?.native_state==='failed'?'run_failed':waitingForDirectory(r.id as string,state)?'directory':state==='queued'?'queued':state==='approval'?'approval':state==='unknown'?'unknown':state==='failed'?'run_failed':state==='interrupted'?'interrupted':null;
  return {lastProgressAt:lastProgressAt??null,reason,attention:['approval','unknown','failed'].includes(state)||Boolean(observation&&['failed','unknown','unreachable'].includes(observation.native_state as string)),...(observation?{lastCheckedAt:observation.checked_at as string,nativeState:observation.native_state as import('./task-monitor').NativeObservation}:{})};
 };
 const runRow = (r: Record<string, unknown>): Run => ({
  monitor:monitor(r),
  ...(r.execution_snapshot ? {snapshot:parse<NonNullable<Run['snapshot']>>(r.execution_snapshot)} : {}), completion:r.completion?parse(r.completion):null,
  id: r.id as string, waitingForDirectory:waitingForDirectory(r.id as string,r.state), taskId: r.task_id as string, executionId: r.execution_id as string, attempt: Number(r.attempt), state: r.state as Run['state'], hostId: r.host_id as string | null,
  nativeSessionId: r.native_session_id as string | null, nativeTurnId: r.native_turn_id as string | null, contextSnapshotId: r.context_snapshot_id as string | null,
  routing: r.routing ? parse(r.routing) : null, continuation: r.continuation ? parse(r.continuation) : null, terminalEventKey: r.terminal_event_key as string | null,
  summary: r.summary as string | null, artifactVersions: parse(r.artifact_versions), legacyId: r.legacy_id as string | null, createdAt: r.created_at as string,
 });
 const executionRow = (row:Record<string,unknown>):TaskExecution => {
  const latest=db.prepare('SELECT * FROM task_runs WHERE execution_id=? ORDER BY attempt DESC LIMIT 1').get(row.id as string);
  return {id:row.id as string,taskId:row.task_id as string,supersededByExecutionId:row.superseded_by_execution_id as string|null,conversationId:row.conversation_id as string,agentId:row.agent_id as string,projectId:row.project_id as string|null,request:row.request as string,criteria:parse(row.criteria),createdByAgentId:row.created_by_agent_id as string|null,commandKey:row.command_key as string|null,createdAt:row.created_at as string,title:store.getConversation(row.conversation_id as string)?.title??null,latestRun:latest?{...controlRow(latest)}:null};
 };
 const executionRows = (taskId:string):TaskExecution[] => db.prepare('SELECT * FROM task_executions WHERE task_id=? ORDER BY created_at,id').all(taskId).map(executionRow);
 const loadExecution = (id:string):TaskExecution => {const row=db.prepare('SELECT * FROM task_executions WHERE id=?').get(id);return row?executionRow(row):fail('execution_not_found',404);};
 const writeExecution = (p:Principal,taskId:string,input:TaskExecutionInput,commandKey:string|null):TaskExecution => {
  const task=getTask(p,taskId);
  if(['completed','cancelled'].includes(task.state))fail('task_terminal',409);
  const criteria=input.criteria??[];
  if(!nonempty(input.conversationId)||!nonempty(input.agentId)||!nonempty(input.request)||input.projectId!==null&&!nonempty(input.projectId)||!Array.isArray(criteria)||criteria.some(c=>!c||!nonempty(c.id)||!nonempty(c.text)||c.checkRef!==null&&!nonempty(c.checkRef)))fail('invalid_execution',422);
  const chat=store.getConversation(input.conversationId);
  if(!chat||chat.agentId!==input.agentId||(chat.projectId||null)!==input.projectId)fail('invalid_route',422);
  const prior=commandKey?db.prepare('SELECT * FROM task_executions WHERE task_id=? AND command_key=?').get(taskId,commandKey):undefined;
  if(prior){const execution=executionRow(prior);if(canonical({conversationId:execution.conversationId,agentId:execution.agentId,projectId:execution.projectId,request:execution.request,criteria:execution.criteria,createdByAgentId:execution.createdByAgentId})!==canonical({...input,criteria,createdByAgentId:input.createdByAgentId??p.agentId??null}))fail('idempotency_conflict',409);return execution;}
  if(db.prepare('SELECT id FROM task_executions WHERE conversation_id=?').get(input.conversationId))fail('execution_conversation_in_use',409);
  const id=randomUUID();db.prepare('INSERT INTO task_executions(id,task_id,conversation_id,agent_id,project_id,request,criteria,created_by_agent_id,command_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,taskId,input.conversationId,input.agentId,input.projectId,input.request,JSON.stringify(criteria),input.createdByAgentId??p.agentId??null,commandKey,new Date().toISOString());
  return loadExecution(id);
 };
 const loadRun = (id: string): Run => { const row = db.prepare('SELECT * FROM task_runs WHERE id=?').get(id); return row ? runRow(row) : fail('run_not_found', 404); };
 const receiptRow = (r: Record<string, unknown>): Receipt => ({
  id: r.id as string, taskId: r.task_id as string | null, sourceRunId: r.source_run_id as string | null,
  destinationConversationId: r.destination_conversation_id as string | null, executionId: r.execution_id as string | null,
  capturedEpoch: r.captured_epoch === null ? null : Number(r.captured_epoch), policy: r.policy as Receipt['policy'], deliveryState: r.delivery_state as Receipt['deliveryState'],
  claimError: r.claim_error as string | null, claimEpoch: r.claim_epoch == null ? null : Number(r.claim_epoch), claimedByRunId: r.claimed_by_run_id as string | null, summary: r.summary as string, artifactVersions: parse(r.artifact_versions), legacyId: r.legacy_id as string | null, createdAt: r.created_at as string,
 });
 const insertReceipt = (r: Receipt) => db.prepare('INSERT INTO task_receipts(id,task_id,source_run_id,destination_conversation_id,execution_id,captured_epoch,policy,delivery_state,claimed_by_run_id,summary,artifact_versions,legacy_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
  r.id, r.taskId, r.sourceRunId, r.destinationConversationId, r.executionId, r.capturedEpoch, r.policy, r.deliveryState, r.claimedByRunId, r.summary, JSON.stringify(r.artifactVersions), r.legacyId, r.createdAt,
 );
 const replay = (p: Principal, key: string, body: unknown) => {
  if (!nonempty(p.userId)) fail('forbidden', 403);
  if (!nonempty(key) || key.length > 200) fail('invalid_command_key', 422);
  const principal = canonical(p), payloadHash = hash(canonical(body));
  const row = db.prepare('SELECT * FROM task_command_dedup WHERE principal=? AND command_key=?').get(principal, key);
  if (row && row.payload_hash !== payloadHash) fail('idempotency_conflict', 409);
  return { row, principal, payloadHash };
 };
 const saveCommand = (p: Principal, key: string, body: unknown, taskId: string, runId: string | null) => {
  const { principal, payloadHash } = replay(p, key, body);
  db.prepare('INSERT INTO task_command_dedup VALUES (?,?,?,?,?)').run(principal, key, payloadHash, taskId, runId);
 };
 const context = (runId: string): ContextSnapshot | null => {
  const r = db.prepare('SELECT * FROM context_snapshots WHERE run_id=?').get(runId);
  return r ? { id: r.id as string, runId, input: r.input as string, inputHash: r.input_hash as string, sourceVersions: parse(r.source_versions),
   effectiveCapabilities: parse(r.effective_capabilities), nativeVisibility: 'partial', requiredOutputAssetIds: parse(r.required_output_asset_ids), createdAt: r.created_at as string } : null;
 };
 const authorizeVersions = (p: Principal, refs: VersionRef[]) => {
  for (const ref of refs) {
   if (!options.assets) fail('assets_required', 422);
   options.assets!.getAuthorizedVersion(p, ref);
  }
 };
 const readRun = (p: Principal, run: Run): Run => {
  getTask(p, run.taskId);
  // Queued metadata has no result body. Terminal text inherits its fixed sources' scope.
  if (run.summary !== null || run.artifactVersions.length) {
   authorizeVersions(p, context(run.id)?.sourceVersions ?? []);
   authorizeVersions(p, run.artifactVersions);
  }
  return run;
 };
 const controlColumns='id,task_id,execution_id,attempt,state,host_id,native_session_id,native_turn_id,routing,continuation,created_at';
 const authorizeControl = (p:Principal,taskId:string) => {
  getTask(p,taskId);
 };
 const controlRow = (r:Record<string,unknown>):RunControl => ({monitor:monitor(r),id:r.id as string,waitingForDirectory:waitingForDirectory(r.id as string,r.state),taskId:r.task_id as string,executionId:r.execution_id as string,attempt:Number(r.attempt),state:r.state as Run['state'],hostId:r.host_id as string|null,nativeSessionId:r.native_session_id as string|null,nativeTurnId:r.native_turn_id as string|null,routing:r.routing?parse(r.routing):null,continuation:r.continuation?parse(r.continuation):null,createdAt:r.created_at as string});
 const planVersions = (p: Principal, taskId: string): VersionRef[] => {
  getTask(p,taskId);
  if(!db.prepare('SELECT task_id FROM task_plan_steps WHERE task_id=? LIMIT 1').get(taskId))return [];
  const refs=db.prepare('SELECT DISTINCT v.asset_id,v.id FROM task_plan_steps s JOIN asset_versions v ON v.id=s.plan_version_id WHERE s.task_id=?').all(taskId).map(r=>({assetId:r.asset_id as string,versionId:r.id as string}));
  authorizeVersions(p,refs);return refs;
 };
 // Execution instructions and chat titles are content, unlike Run control facts.
 const visibleExecutions = (p:Principal,task:Task):TaskExecution[] => task.executions.filter(execution=>{
  if(p.agentId===undefined&&!options.assets&&!options.authorizeConversation)return true;
  if(p.agentId!==undefined&&p.agentId!==execution.agentId&&p.agentId!==execution.createdByAgentId&&p.agentId!==task.creatorAgentId)return false;
  try{
   options.authorizeConversation?.(p,execution.conversationId);
   for(const row of db.prepare('SELECT id,artifact_versions FROM task_runs WHERE execution_id=?').all(execution.id)){
    authorizeVersions(p,context(row.id as string)?.sourceVersions??[]);
    authorizeVersions(p,parse<VersionRef[]>(row.artifact_versions));
   }
   return true;
  }catch(error){if(error instanceof DomainError&&(error.status===403||error.code==='assets_required'))return false;throw error;}
 });
 const taskView = <T extends Task>(p:Principal,task:T):T => {const executions=visibleExecutions(p,task);return {...task,executions,conversationIds:executions.filter(execution=>!execution.supersededByExecutionId).map(execution=>execution.conversationId)};};
 const executionView = (p:Principal,execution:TaskExecution):TaskExecution => visibleExecutions(p,{...getTask(p,execution.taskId),executions:[execution]})[0]??fail('forbidden',403);
 // Execution state changes do not invalidate a sibling's suspended inquiry.
 // Goal edits and explicit task control deliberately leave its marker stale.
 const advanceInquiryRevision=(taskId:string,revision:number,excludeExecutionId:string|null=null)=>{
  db.prepare('UPDATE task_inquiry_waits SET task_revision=task_revision+1 WHERE task_revision=? AND resumed_by_run_id IS NULL AND run_id IN (SELECT id FROM task_runs WHERE task_id=? AND (? IS NULL OR execution_id<>?))').run(revision,taskId,excludeExecutionId,excludeExecutionId);
  db.prepare('UPDATE task_completion_intents SET task_revision=task_revision+1 WHERE task_revision=? AND run_id IN (SELECT id FROM task_runs WHERE task_id=?)').run(revision,taskId);
 };
 const startBody = (taskId:string,expectedRevision:number) => ({action:'start',taskId,expectedRevision});
 const assertStartable = (task:Task,commandKey:string,explicit=false) => {
  const scheduled=commandKey.startsWith('automation:')||Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='automation_rules'").get()&&db.prepare("SELECT id FROM automation_rules WHERE json_extract(data,'$.taskId')=? OR json_extract(data,'$.executionTaskId')=?").get(task.id,task.id));
  if(!['todo','running','waiting'].includes(task.state)&&!(task.state==='review'&&(scheduled||explicit)))fail('task_not_startable',409);
 };
 const prepareStart = (p: Principal, taskId: string, expectedRevision: number, commandKey: string, runId: string = randomUUID(), inquiry?:{selection?:ReturnType<TaskResolver>;executionId?:string;agentId?:string;projectId?:string|null;request?:string;criteria?:Criterion[];createdByAgentId?:string|null;supersedesExecutionId?:string;allowStaleContinuation?:boolean;continuation?:Continuation}) => {
   const body = startBody(taskId,expectedRevision), previous = replay(p, commandKey, body).row;
   if (previous) return { commit: (_routing?:RunRouting) => readRun(p, loadRun(previous.run_id as string)) };
   const task = getTask(p, taskId),execution=inquiry?.executionId?loadExecution(inquiry.executionId):null;
   if(execution&&execution.taskId!==taskId)fail('execution_task_mismatch',409);
   const executionTask={...task,assigneeAgentId:execution?.agentId??inquiry?.agentId??task.assigneeAgentId,projectId:execution?execution.projectId:inquiry?.projectId!==undefined?inquiry.projectId:task.projectId,goal:execution?.request??inquiry?.request??task.goal,criteria:execution?.criteria??inquiry?.criteria??task.criteria};
   if (task.revision !== expectedRevision) fail('revision_conflict', 409);
   if (!executionTask.assigneeAgentId) fail('assignee_required', 422);
   assertStartable(task,commandKey,Boolean(inquiry));
   if (!options.resolve&&!inquiry?.selection) fail('resolver_required', 422);
   const selected = inquiry?.selection??options.resolve!(p, executionTask);
   if(inquiry?.continuation)selected.continuation=inquiry.continuation;
   if (!selected || selected.agentId !== executionTask.assigneeAgentId || selected.projectId !== executionTask.projectId || !nonempty(selected.hostId) || !nonempty(selected.input) ||
    !Array.isArray(selected.sourceVersions) || selected.sourceVersions.some(r => !r || !nonempty(r.assetId) || !nonempty(r.versionId)) ||
    !Array.isArray(selected.requiredOutputAssetIds) || selected.requiredOutputAssetIds.some(id => !nonempty(id)) ||
    !Array.isArray(selected.effectiveCapabilities) || selected.effectiveCapabilities.some(c => !nonempty(c.name) || !['saved', 'materialized', 'verified', 'unverified'].includes(c.state)) || selected.nativeVisibility !== 'partial') fail('invalid_run_input', 422);
   const snapshotId = randomUUID(), now = new Date().toISOString();
   return { commit: (routing?: RunRouting) => {
    if (!db.isTransaction) fail('transaction_required', 500);
    const repeated = replay(p, commandKey, body).row;
    if (repeated) return readRun(p, loadRun(repeated.run_id as string));
    const current = getTask(p, taskId);
    if (current.revision !== expectedRevision) fail('revision_conflict', 409);
    assertStartable(current,commandKey,Boolean(inquiry));
    const continuation = selected.continuation ?? null;
    if (continuation) {
     if (continuation.taskId!==current.id || continuation.conversationId!==current.originConversationId || !['notify', 'resume'].includes(continuation.policy)) fail('invalid_continuation', 422);
     if (!inquiry?.allowStaleContinuation&&current.continuationEpoch!==continuation.epoch || ['cancelled','completed'].includes(current.state)) fail('continuation_conflict',409);
    }
    let target=execution;
    if(!target&&routing){const row=db.prepare('SELECT * FROM task_executions WHERE conversation_id=?').get(routing.executionConversationId);target=row?executionRow(row):null;if(target&&target.taskId!==taskId)fail('execution_conversation_in_use',409);}
    if(!target&&!routing&&!inquiry){target=executionRows(taskId).find(item=>item.agentId===selected.agentId&&item.projectId===selected.projectId)??null;}
    if(!target){
     const conversationId=routing?.executionConversationId??store.createConversation({agentId:selected.agentId,projectId:selected.projectId??'',cli:'codex',model:null}).id;
     target=writeExecution(p,taskId,{conversationId,agentId:selected.agentId,projectId:selected.projectId,request:executionTask.goal,criteria:executionTask.criteria,createdByAgentId:inquiry?.createdByAgentId},commandKey);
    }
    if(target.supersededByExecutionId)fail('execution_superseded',409);
    if(routing&&routing.executionConversationId!==target.conversationId||target.agentId!==selected.agentId||target.projectId!==selected.projectId)fail('invalid_route',422);
    if(db.prepare("SELECT id FROM task_runs WHERE execution_id=? AND state IN ('queued','starting','running','approval','unknown')").get(target.id))fail('task_not_startable',409);
    if(inquiry?.supersedesExecutionId&&inquiry.supersedesExecutionId!==target.id){
     const replaced=loadExecution(inquiry.supersedesExecutionId);
     if(replaced.taskId!==taskId||replaced.supersededByExecutionId&&replaced.supersededByExecutionId!==target.id||target.supersededByExecutionId)fail('execution_superseded',409);
     if(db.prepare("SELECT id FROM task_runs WHERE execution_id=? AND state IN ('queued','starting','running','approval','unknown')").get(replaced.id))fail('execution_active',409);
     db.prepare('UPDATE task_executions SET superseded_by_execution_id=? WHERE id=?').run(target.id,replaced.id);
    }
    const route=routing??{executionConversationId:target.conversationId,mode:'dedicated' as const,destinationConversationId:current.originConversationId};
    const attempt = Number(db.prepare('SELECT COALESCE(MAX(attempt),0)+1 AS n FROM task_runs WHERE task_id=?').get(taskId)!.n);
    db.prepare(`INSERT INTO task_runs(id,task_id,execution_id,attempt,state,host_id,continuation,created_at) VALUES (?,?,?,?,'queued',?,?,?)`).run(runId, taskId, target.id, attempt, selected.hostId, continuation ? JSON.stringify(continuation) : null, now);
    const occurrence=commandKey.startsWith('automation:')&&db.prepare("SELECT name FROM sqlite_master WHERE name='automation_occurrences'").get()?db.prepare('SELECT data FROM automation_occurrences WHERE id=?').get(commandKey.slice('automation:'.length)):undefined;
    const frozen=occurrence?parse<import('../shared/automations').AutomationRun>(occurrence.data):undefined;
    const ruleRow=!frozen&&db.prepare("SELECT name FROM sqlite_master WHERE name='automation_rules'").get()?db.prepare("SELECT data FROM automation_rules WHERE archived=0 AND (json_extract(data,'$.taskId')=? OR json_extract(data,'$.executionTaskId')=?)").get(taskId,taskId):undefined;
    const linkedRule=ruleRow?parse<import('../shared/automations').Automation>(ruleRow.data):undefined;
    db.prepare('UPDATE task_runs SET execution_snapshot=? WHERE id=?').run(JSON.stringify({goal:frozen?.goal??current.goal,criteria:frozen?.criteria??current.criteria,acceptance:frozen?.acceptance??current.acceptance,...(frozen?.schedule?{rule:{...(frozen.reportConversationId?{reportConversationId:frozen.reportConversationId}:{}),automationId:frozen.automationId,revision:frozen.ruleRevision,schedule:frozen.schedule,...(frozen.executionMode?{executionMode:frozen.executionMode}:{})}}:selected.reportRule?{rule:selected.reportRule}:linkedRule?{rule:{automationId:linkedRule.id,revision:linkedRule.revision,schedule:linkedRule.schedule,...(linkedRule.executionMode?{executionMode:linkedRule.executionMode}:{})}}:{})}),runId);
    db.prepare('UPDATE task_runs SET routing=? WHERE id=?').run(JSON.stringify(route), runId);
    // Register first so the asset service's trusted project resolver can identify this Run.
    const fixed=[...new Map([...selected.sourceVersions,...planVersions(p,taskId)].map(ref=>[ref.versionId,ref])).values()];
    const sourceVersions = fixed.map(ref => {
     if (!options.assets) return fail('assets_required', 422);
     const v = options.assets.getAuthorizedVersion({ userId: p.userId, agentId: selected.agentId, runId }, ref);
     return { ...ref, files: v.files, accessRevision: v.accessRevision };
    });
    db.prepare('INSERT INTO context_snapshots VALUES (?,?,?,?,?,?,?,?,?)').run(snapshotId, runId, selected.input, hash(selected.input), JSON.stringify(sourceVersions), JSON.stringify(selected.effectiveCapabilities), 'partial', JSON.stringify(selected.requiredOutputAssetIds), now);
    db.prepare('UPDATE task_runs SET context_snapshot_id=? WHERE id=?').run(snapshotId, runId);
    for (const ref of sourceVersions) {
     db.prepare('INSERT OR IGNORE INTO task_context_versions VALUES (?,?)').run(runId, ref.versionId);
     db.prepare('INSERT OR IGNORE INTO artifact_links VALUES (?,?)').run(runId, ref.versionId);
    }
    db.prepare("UPDATE work_tasks SET state='running',waiting_reason=NULL,revision=revision+1 WHERE id=?").run(taskId);
    advanceInquiryRevision(taskId,current.revision,target.id);
    saveCommand(p, commandKey, body, taskId, runId);
    store.enqueueOutbox({ type: 'task.run_queued', aggregateId: taskId, aggregateRevision: current.revision + 1, causationId: commandKey, payload: { taskId, runId } });

    return loadRun(runId);
   } };
 };
 const executionProgress = (task:Task,fallback:Task['waitingReason']=null):{state:Task['state'];reason:Task['waitingReason'];completion:Task['completion']} => {
  if(['completed','cancelled'].includes(task.state))return {state:task.state,reason:task.waitingReason,completion:task.completion};
  const latest=db.prepare('SELECT r.* FROM task_executions e JOIN task_runs r ON r.id=(SELECT id FROM task_runs WHERE execution_id=e.id ORDER BY attempt DESC LIMIT 1) WHERE e.task_id=? AND e.superseded_by_execution_id IS NULL').all(task.id);
  if(latest.some(row=>['queued','starting','running','approval','unknown'].includes(row.state as string)))return {state:'running',reason:null,completion:null};
  const failed=latest.find(row=>row.state&&row.state!=='succeeded'||row.state==='succeeded'&&!row.delivery_valid);
  if(failed)return {state:'waiting',reason:(failed.waiting_reason as Task['waitingReason'])??fallback??'run_failed',completion:null};
  if(!latest.length)return {state:'todo',reason:null,completion:null};
  const matchesGoal=(row:Record<string,unknown>)=>{const snapshot=row.execution_snapshot?parse<NonNullable<Run['snapshot']>>(row.execution_snapshot):null;return !snapshot||snapshot.goal===task.goal&&canonical(snapshot.criteria)===canonical(task.criteria)&&snapshot.acceptance===task.acceptance;};
  const checked=task.acceptance==='checks'&&latest.every(row=>matchesGoal(row)&&row.completion&&parse<NonNullable<Task['completion']>>(row.completion).completedBy==='checks');
  const agent=latest.length===1&&latest[0].completion&&parse<NonNullable<Task['completion']>>(latest[0].completion).completedBy==='agent';
  const checkedCompletions=checked?latest.map(row=>parse<NonNullable<Task['completion']>>(row.completion)):[];
  const newestChecked=checkedCompletions.sort((a,b)=>a.acceptedAt.localeCompare(b.acceptedAt)).at(-1);
  const completion=checked?{...newestChecked!,artifactVersions:[...new Map(checkedCompletions.flatMap(evidence=>evidence.artifactVersions).map(ref=>[ref.versionId,ref])).values()],checks:checkedCompletions.flatMap(evidence=>evidence.checks??[])}:agent?parse<NonNullable<Task['completion']>>(latest[0].completion):null;
  const scheduled=latest.some(row=>{const snapshot=row.execution_snapshot?parse<NonNullable<Run['snapshot']>>(row.execution_snapshot):null;return snapshot?.rule&&snapshot.rule.schedule.kind!=='once'&&!snapshot.rule.executionMode;});
  return {state:completion?(scheduled?'todo':'completed'):'review',reason:null,completion};
 };
 const refreshExecutionProgress = (id:string):void => {
  const task=loadTask(id),next=executionProgress(task);
  if(task.state===next.state&&task.waitingReason===next.reason)return;
  db.prepare('UPDATE work_tasks SET state=?,waiting_reason=?,completion=?,revision=revision+1 WHERE id=?').run(next.state,next.reason,next.completion?JSON.stringify(next.completion):null,id);
  advanceInquiryRevision(id,task.revision);
  store.enqueueOutbox({type:'task.progress_updated',aggregateId:id,aggregateRevision:task.revision+1,causationId:`executions:${id}:${task.revision}`,payload:{taskId:id,state:next.state}});
 };
 const finishRun = (run: Run, event: Pick<TerminalRunEvent, 'outcome' | 'summary' | 'artifactVersions' | 'eventKey'>, parkReason: 'native_history_changed'|'native_background_active'|'native_background_check_failed'|null = null, available = true, integrity: 'passed'|'failed'|null = null) => {
    const task = loadTask(run.taskId), snapshot = context(run.id), now = new Date().toISOString();
    const outputs: VersionRef[] = [];
    let invalidOutput = false;
    for (const ref of event.artifactVersions) {
     // artifact_links also retains inputs. Only explicit terminal output with matching publication provenance is delivery.
     const vrow = db.prepare('SELECT data FROM asset_versions WHERE id=? AND asset_id=?').get(ref.versionId, ref.assetId);
     if (!vrow || parse<{ provenance: { runId?: string } }>(vrow.data).provenance.runId !== run.id) { invalidOutput = true; continue; }
     if (!outputs.some(v => v.versionId === ref.versionId)) outputs.push(ref);
    }
    const actor={userId:task.ownerUserId,agentId:loadExecution(run.executionId).agentId,runId:run.id};
    try{authorizeVersions(actor,snapshot?.sourceVersions??[]);authorizeVersions(actor,outputs);}
    catch(error){if(!(error instanceof DomainError)||error.code!=='forbidden')throw error;available=false;}
    const delivered = available && Boolean(event.summary.trim() || outputs.length) && !invalidOutput && (snapshot?.requiredOutputAssetIds ?? []).every(id => outputs.some(v => v.assetId === id));
    const terminal=['completed','cancelled'].includes(task.state);
    const checkedRun = delivered && integrity==='passed' && event.outcome==='succeeded';
    const currentGoal = !run.snapshot || run.snapshot.goal===task.goal&&canonical(run.snapshot.criteria)===canonical(task.criteria)&&run.snapshot.acceptance===task.acceptance;
    const intent=db.prepare('SELECT * FROM task_completion_intents WHERE run_id=?').get(run.id);
    const pendingInquiries=Boolean(run.routing&&db.prepare("SELECT name FROM sqlite_master WHERE name='agent_messages'").get()&&db.prepare("SELECT id FROM agent_messages WHERE source_conversation_id=? AND auto_resume_allowed=1 AND reply_state IN ('pending','queued') LIMIT 1").get(run.routing.executionConversationId));
    const deferredInquiry=!terminal&&pendingInquiries&&event.outcome==='succeeded'&&available&&!invalidOutput&&integrity!=='failed';
    const actorAgent=loadExecution(run.executionId).agentId;
    const agentAccepted=!terminal&&!pendingInquiries&&delivered&&integrity!=='failed'&&currentGoal&&event.outcome==='succeeded'&&['running','approval','unknown'].includes(run.state)&&intent?.task_revision===task.revision&&intent.agent_id===actorAgent;
    const completion:Task['completion'] = agentAccepted?{completedBy:'agent',completedByAgentId:actorAgent,sourceRunId:run.id,artifactVersions:outputs,acceptedAt:now}:null;
    const runReason=event.outcome==='failed'?'run_failed':event.outcome==='interrupted'?parkReason?.startsWith('native_background_')?'input':'interrupted':deferredInquiry?'input':!delivered?'delivery_missing':integrity==='failed'?'check_failed':null;
    if(checkedRun)db.prepare('UPDATE task_runs SET completion=? WHERE id=?').run(JSON.stringify({completedBy:'checks',sourceRunId:run.id,artifactVersions:outputs,acceptedAt:now,checks:[{checkRef:'artifact:integrity',identity:{runId:run.id,hostId:run.hostId,nativeSessionId:run.nativeSessionId,nativeTurnId:run.nativeTurnId},artifactVersions:outputs}]}),run.id);
    if(agentAccepted)db.prepare('UPDATE task_runs SET completion=? WHERE id=?').run(JSON.stringify(completion),run.id);
    db.prepare('DELETE FROM task_completion_intents WHERE run_id=?').run(run.id);
    db.prepare('UPDATE task_runs SET state=?,terminal_event_key=?,summary=?,artifact_versions=?,delivery_valid=?,waiting_reason=? WHERE id=?').run(event.outcome, event.eventKey, event.summary, JSON.stringify(outputs),Number(delivered&&!deferredInquiry&&integrity!=='failed'),runReason, run.id);
    for (const ref of outputs) db.prepare('INSERT INTO task_output_versions VALUES (?,?)').run(run.id, ref.versionId);
    const aggregate=executionProgress(task,runReason);
    const state=aggregate.state,reason=aggregate.reason;
    const accepted=terminal?task.completion:aggregate.completion;
    if(!terminal&&state==='completed')db.prepare("UPDATE task_receipts SET policy='notify' WHERE task_id=? AND captured_epoch=? AND delivery_state IN ('pending','presented')").run(task.id,task.continuationEpoch);
    db.prepare('UPDATE work_tasks SET state=?,waiting_reason=?,completion=?,revision=revision+1 WHERE id=?').run(state,reason,accepted?JSON.stringify(accepted):null,task.id);
    advanceInquiryRevision(task.id,task.revision);
    if(deferredInquiry)db.prepare('INSERT INTO task_inquiry_waits VALUES (?,?,?,?,NULL)').run(run.id,currentGoal?task.revision+1:-1,task.continuationEpoch,intent?.task_revision===task.revision&&currentGoal?intent.agent_id as string:null);
    const continuation = run.continuation;
    const parent = continuation ? loadTask(continuation.taskId) : null;
    const parked = parent && (parent.continuationEpoch !== continuation!.epoch || terminal || parent.state==='cancelled' || continuation!.policy === 'resume' && !parent.futureAutoResume);
    const receipt: Receipt = { id: randomUUID(), taskId: task.id, sourceRunId: run.id, destinationConversationId: task.originConversationId ?? run.routing?.destinationConversationId ?? null,
     executionId: run.executionId, capturedEpoch: continuation?.epoch ?? task.continuationEpoch, policy: state==='completed'&&!terminal?'notify':continuation?.policy ?? 'notify',
     deliveryState: parked || parkReason==='native_history_changed' ? 'parked' : 'pending', claimError: parkReason, claimEpoch: null, claimedByRunId: null, summary: event.summary, artifactVersions: outputs, legacyId: null, createdAt: now };
    const selfReport=run.routing?.executionConversationId===task.originConversationId&&!run.continuation;
    if(!deferredInquiry&&!selfReport)insertReceipt(receipt);
    if (parkReason) db.prepare("UPDATE task_receipts SET claim_error=? WHERE id=?").run(parkReason, receipt.id);
    store.enqueueOutbox({ type: 'task.run_terminal', aggregateId: task.id, aggregateRevision: task.revision + 1, causationId: event.eventKey,
     payload: { taskId: task.id, runId: run.id, receiptId: deferredInquiry||selfReport?null:receipt.id, state, deliveryState: deferredInquiry||selfReport?null:receipt.deliveryState } });
    db.prepare("UPDATE task_receipts SET delivery_state=CASE WHEN ?='succeeded' THEN 'consumed' ELSE delivery_state END,claim_error=? WHERE claimed_by_run_id=?").run(event.outcome, event.outcome === 'succeeded' ? null : event.outcome, run.id);

 };
 const validateInput = (input: Required<TaskInput>) => {
  if (typeof input.automaticProgress!=='boolean' || !nonempty(input.goal) || !['delivery','checks','human'].includes(input.acceptance) ||
   !Array.isArray(input.criteria) || input.criteria.some(c=>!c||!nonempty(c.id)||!nonempty(c.text)||c.checkRef!==null&&!nonempty(c.checkRef)) ||
   new Set(input.criteria.map(c=>c.id)).size!==input.criteria.length ||
   [input.projectId,input.assigneeAgentId,input.originConversationId].some(id=>id!==null&&!nonempty(id)) ||
   [input.participantAgentIds].some(ids=>!Array.isArray(ids)||ids.some(id=>!nonempty(id))||new Set(ids).size!==ids.length))fail('invalid_task',422);
 };
 const authorizeConversation = (p:Principal,id:string) => {
  const conversation=store.getConversation(id);if(!conversation)return fail('conversation_not_found',404);
  if(options.authorizeConversation)options.authorizeConversation(p,id);
  else if(p.userId!==store.ownerUserId||p.agentId!==undefined&&p.agentId!==conversation.agentId)fail('forbidden',403);
  for(const runId of store.listConversationTaskRuns(id))readRun(p,loadRun(runId));
 };
 const validateLinks = (p:Principal,input:Required<TaskInput>,previous?:Task) => {
  if(input.originConversationId&&previous?.originConversationId!==input.originConversationId)authorizeConversation(p,input.originConversationId);
 };
 const writeLinks = (id:string,input:Required<TaskInput>) => {
  db.prepare('DELETE FROM task_participants WHERE task_id=?').run(id);
  for(const agentId of input.participantAgentIds)db.prepare('INSERT INTO task_participants VALUES (?,?)').run(id,agentId);
 };
 const progressSnapshot = (p:Principal,id:string):TaskProgressSnapshot => {
  const task=getTask(p,id);
  return {task:{id:task.id,goal:task.goal,criteria:task.criteria,state:task.state,revision:task.revision,conversationIds:task.conversationIds},executions:task.executions.map(({id,conversationId,request,latestRun})=>({id,conversationId,request,latestRun}))};
 };
 const listTasks = (p:Principal):Task[] => {
  if(!nonempty(p.userId))fail('forbidden',403);
  return db.prepare('SELECT * FROM work_tasks WHERE owner_user_id=? ORDER BY created_at DESC,id').all(p.userId).map(taskRow).filter(task=>p.agentId===undefined||p.agentId===task.creatorAgentId||p.agentId===task.assigneeAgentId||task.participantAgentIds.includes(p.agentId)||task.executions.some(execution=>execution.agentId===p.agentId));
 };
 const listLinkedTasks = (p:Principal,conversationId:string):Task[] => {authorizeConversation(p,conversationId);return listTasks(p).filter(task=>task.conversationIds.includes(conversationId));};
 const prepareCreate = (p: Principal, submitted: TaskInput, commandKey: string, creationSource?:'system') => {
   if(!submitted||typeof submitted!=='object'||Array.isArray(submitted)||Object.keys(submitted).some(key=>!['goal','criteria','acceptance','projectId','assigneeAgentId','originConversationId','participantAgentIds','automaticProgress'].includes(key)))fail('invalid_task',422);
   const {goal,criteria=[],acceptance='human',projectId=null,assigneeAgentId=null,originConversationId=null,participantAgentIds=[],automaticProgress=true}=submitted;
   const input:Required<TaskInput>={goal,criteria,acceptance,projectId,assigneeAgentId,originConversationId,participantAgentIds,automaticProgress};validateInput(input);
   const body = { action: 'create', input:submitted,...(creationSource?{creationSource}:{}) };
   return { commit: () => {
    if (!db.isTransaction) fail('transaction_required',500);
    const previous = replay(p, commandKey, body).row;
    validateLinks(p,input);
    if (previous) return getTask(p, previous.task_id as string);
    const id = randomUUID();
    db.prepare(`INSERT INTO work_tasks VALUES (?,?,?,?,?,?,?,?,?,'todo',NULL,1,0,0,NULL,NULL,?,?)`).run(id, p.userId, p.agentId ?? null,
     input.goal, JSON.stringify(input.criteria), input.acceptance, input.projectId, input.assigneeAgentId, input.originConversationId, new Date().toISOString(),Number(input.automaticProgress));
    db.prepare('INSERT INTO task_creation_sources VALUES (?,?)').run(id,p.agentId?'agent':creationSource??'user');
    writeLinks(id,input);
    saveCommand(p, commandKey, body, id, null);
    store.enqueueOutbox({ type: 'task.created', aggregateId: id, aggregateRevision: 1, causationId: commandKey, payload: { taskId: id } });

    return loadTask(id);
   } };
 };
 const commitUpdateTask = (p:Principal,id:string,revision:number,patch:TaskPatch,commandKey:string,body:unknown):Task => {
    const previous=replay(p,commandKey,body).row,task=getTask(p,id);
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['goal','criteria','projectId','assigneeAgentId','originConversationId','participantAgentIds','state','automaticProgress'].includes(key)))fail('invalid_task',422);
    const updated={...task,...patch};validateInput(updated);validateLinks(p,updated,task);
    if(patch.state!==undefined&&!['todo','running','waiting','review'].includes(patch.state))fail('invalid_task',422);
    if(previous)return task;
    if(task.revision!==revision)fail('revision_conflict',409);
    if(patch.state!==undefined&&['completed','cancelled'].includes(task.state))fail('task_terminal',409);
    if(patch.assigneeAgentId!==undefined&&patch.assigneeAgentId!==task.assigneeAgentId&&db.prepare("SELECT id FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown')").get(id))fail('assignment_unavailable',409);
    const state=patch.state??task.state,reason=state==='waiting'?(patch.state==='waiting'?'input':task.waitingReason??'input'):null;
    db.prepare('UPDATE work_tasks SET goal=?,criteria=?,project_id=?,assignee_agent_id=?,origin_conversation_id=?,state=?,waiting_reason=?,automatic_progress=?,revision=revision+1 WHERE id=?').run(updated.goal,JSON.stringify(updated.criteria),updated.projectId,updated.assigneeAgentId,updated.originConversationId,state,reason,Number(updated.automaticProgress),id);
    writeLinks(id,updated);saveCommand(p,commandKey,body,id,null);
    store.enqueueOutbox({type:'task.updated',aggregateId:id,aggregateRevision:revision+1,causationId:commandKey,payload:{taskId:id}});
    return loadTask(id);
 };
 const isMandalaOwned=(id:string)=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='mandala_ownership'").get()&&db.prepare('SELECT task_id FROM mandala_ownership WHERE task_id=?').get(id));
 const commitTaskProgress = (p:Principal,snapshot:TaskProgressSnapshot,nextState:TaskProgressState,guard?:()=>boolean):boolean => {
    if(!['todo','running','waiting','review'].includes(nextState))fail('invalid_task',422);
    const current=progressSnapshot(p,snapshot.task.id);
    if(isMandalaOwned(snapshot.task.id)||!getTask(p,snapshot.task.id).automaticProgress||['completed','cancelled'].includes(current.task.state)||canonical(current)!==canonical(snapshot)||guard&&!guard())return false;
    if(current.task.state===nextState)return false;
    db.prepare('UPDATE work_tasks SET state=?,waiting_reason=?,revision=revision+1 WHERE id=?').run(nextState,nextState==='waiting'?'input':null,current.task.id);
    store.enqueueOutbox({type:'task.progress_updated',aggregateId:current.task.id,aggregateRevision:current.task.revision+1,causationId:`progress:${current.task.id}:${current.task.revision}`,payload:{taskId:current.task.id,state:nextState}});

    return true;
 };
 const requireRoot = (p: Principal) => { if (!p.userId || p.agentId !== undefined || p.runId !== undefined) fail('forbidden', 403); };
 const pendingInquiryRun=(task:Task):Run|null=>{
  const row=db.prepare('SELECT r.* FROM task_inquiry_waits w JOIN task_runs r ON r.id=w.run_id WHERE r.task_id=? AND w.task_revision=? AND w.continuation_epoch=? AND w.resumed_by_run_id IS NULL AND NOT EXISTS(SELECT 1 FROM task_receipts x WHERE x.source_run_id=r.id) ORDER BY r.attempt DESC LIMIT 1').get(task.id,task.revision,task.continuationEpoch);
  return row?runRow(row):null;
 };
 const writeInquiryDecision=(task:Task,run:Run,summary:string)=>{
  if(db.prepare('SELECT id FROM task_receipts WHERE source_run_id=?').get(run.id))return;
  const continuation=run.continuation,parent=continuation?loadTask(continuation.taskId):null,parked=parent&&(parent.continuationEpoch!==continuation!.epoch||['completed','cancelled'].includes(parent.state)||continuation!.policy==='resume'&&!parent.futureAutoResume);
  const receipt:Receipt={id:randomUUID(),taskId:task.id,sourceRunId:run.id,destinationConversationId:task.originConversationId??run.routing?.destinationConversationId??null,executionId:run.executionId,capturedEpoch:continuation?.epoch??task.continuationEpoch,policy:continuation?.policy??'notify',deliveryState:parked?'parked':'pending',claimedByRunId:null,claimError:null,claimEpoch:null,summary,artifactVersions:run.artifactVersions,legacyId:null,createdAt:new Date().toISOString()};
  insertReceipt(receipt);store.enqueueOutbox({type:'task.decision_receipt',aggregateId:task.id,aggregateRevision:loadTask(task.id).revision,causationId:receipt.id,payload:{taskId:task.id,runId:run.id,receiptId:receipt.id}});
 };
function commitUserCommand(p:Principal,id:string,revision:number,action:'complete'|'accept'|'reopen'|'request_changes'|'assign',value:string|null=null,expectedOutput?:ExpectedOutput,commandKey?:string):Task {
    const body={action,id,revision,value,expectedOutput},previous=commandKey?replay(p,commandKey,body).row:undefined;
    const task=getTask(p,id);
    if(expectedOutput){
     if(!['reopen','request_changes'].includes(action)||!nonempty(expectedOutput.assetId)||!nonempty(expectedOutput.versionId)||!nonempty(expectedOutput.runId))fail('invalid_expected_output',422);
     if(!options.assets)fail('assets_required',422);
     options.assets!.getAuthorizedVersion(p,expectedOutput);
     const run=readRun(p,loadRun(expectedOutput.runId));
     authorizeVersions(p,context(run.id)?.sourceVersions??[]);
     const latest=db.prepare('SELECT id FROM task_runs WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(id);
     if(run.taskId!==id||run.state!=='succeeded'||latest?.id!==run.id||!run.artifactVersions.some(ref=>ref.assetId===expectedOutput.assetId&&ref.versionId===expectedOutput.versionId)||options.assets!.getAuthorizedAsset(p,expectedOutput.assetId).headVersionId!==expectedOutput.versionId)fail('output_changed',409);
    }
    if(previous)return task;
    if(task.revision!==revision)fail('revision_conflict',409);
    if(db.prepare("SELECT id FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown')").get(id))fail('task_run_active',409);
    const inquiry=pendingInquiryRun(task);
    let state=task.state,completion=task.completion,assignee=task.assigneeAgentId;
    if(action==='complete') {
     if(!['todo','running','waiting','review'].includes(state))fail('manual_completion_unavailable',409);
     state='review';completion=null;
    } else if(action==='accept') {
     if(state!=='review')fail('acceptance_unavailable',409);
     const row=db.prepare("SELECT * FROM task_runs WHERE task_id=? AND state='succeeded' ORDER BY attempt DESC LIMIT 1").get(id),run=row?readRun(p,runRow(row)):null;
     state=run?.snapshot?.rule&&run.snapshot.rule.schedule.kind!=='once'&&!run.snapshot.rule.executionMode?'todo':'completed';completion={completedBy:p.agentId?'agent':'user',...(p.agentId?{completedByAgentId:p.agentId}:{}),sourceRunId:run?.id??null,artifactVersions:run?.artifactVersions??[],acceptedAt:new Date().toISOString()};
     if(run)db.prepare('UPDATE task_runs SET completion=? WHERE id=?').run(JSON.stringify(completion),run.id);
    } else if(action==='assign') {
     if(!['todo','waiting'].includes(state)||db.prepare("SELECT id FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown')").get(id))fail('assignment_unavailable',409);
     if(value!==null&&!nonempty(value))fail('invalid_assignee',422);assignee=value;
    } else {
     if(action==='request_changes'&&!nonempty(value))fail('reason_required',422);
     if(value!==null&&typeof value!=='string')fail('invalid_reason',422);
     if(action==='reopen'?!['completed','cancelled'].includes(state):state!=='review')fail('reopen_unavailable',409);
     state='todo';completion=null;
    }
    db.prepare('UPDATE work_tasks SET state=?,waiting_reason=?,completion=?,assignee_agent_id=?,continuation_epoch=continuation_epoch+?,future_auto_resume=CASE WHEN ? THEN 0 ELSE future_auto_resume END,revision=revision+1 WHERE id=?').run(state,state==='waiting'?task.waitingReason:null,completion?JSON.stringify(completion):null,assignee,Number(action==='accept'||action==='reopen'),Number(action==='accept'||action==='reopen'),id);
    if(action==='accept'||action==='reopen')db.prepare("UPDATE task_receipts SET delivery_state='parked' WHERE task_id=? AND delivery_state<>'consumed'").run(id);
    if(action==='complete'&&inquiry)db.prepare('UPDATE task_inquiry_waits SET task_revision=? WHERE run_id=?').run(revision+1,inquiry.id);
    if(action==='accept'&&inquiry)writeInquiryDecision(task,inquiry,'Task marked completed by '+(p.agentId?'Agent '+p.agentId:'user')+' while waiting for an Agent reply');
    store.enqueueOutbox({type:'task.'+action,aggregateId:id,aggregateRevision:revision+1,causationId:`${action}:${id}:${revision}`,payload:{taskId:id,...(action==='reopen'||action==='request_changes'?{reason:value}:{})}});
    if(commandKey)saveCommand(p,commandKey,body,id,null);

    return loadTask(id);
 }
 return {
  // Observation is a separate server-verified capability; never reuse these projections for control.
  async observeTasks(p:Principal) {
   if(!options.authorizeObservation)fail('forbidden',403);await options.authorizeObservation!(p);
   return listTasks({userId:p.userId}).map(task=>({readOnly:true as const,id:task.id,goal:task.goal,projectId:task.projectId,assigneeAgentId:task.assigneeAgentId,originConversationId:task.originConversationId,state:task.state,waitingReason:task.waitingReason,revision:task.revision,createdAt:task.createdAt}));
  },
  async observeRuns(p:Principal,taskId:string) {
   if(!options.authorizeObservation)fail('forbidden',403);await options.authorizeObservation!(p);
   getTask({userId:p.userId},taskId);
   return db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY attempt').all(taskId).map(row=>{
    const run=runRow(row);let summary=run.summary;
    try{authorizeVersions(p,context(run.id)?.sourceVersions??[]);authorizeVersions(p,run.artifactVersions);}catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;summary=null;}
    const deliveries=db.prepare('SELECT * FROM task_receipts WHERE source_run_id=?').all(run.id).map(row=>{
     const receipt=receiptRow(row);let text=summary===null?null:receipt.summary;
     try{authorizeVersions(p,receipt.artifactVersions);}catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;text=null;}
     return {id:receipt.id,deliveryState:receipt.deliveryState,summary:text,createdAt:receipt.createdAt};
    });
    return {readOnly:true as const,id:run.id,taskId:run.taskId,attempt:run.attempt,state:run.state,summary,createdAt:run.createdAt,deliveries};
   });
  },
  getTask(p:Principal,id:string):Task {return taskView(p,getTask(p,id));},
  createExecution(p:Principal,taskId:string,input:TaskExecutionInput,commandKey:string):TaskExecution {return executionView(p,db.isTransaction?writeExecution(p,taskId,input,commandKey):store.transaction(()=>writeExecution(p,taskId,input,commandKey)));},
  getExecution(p:Principal,id:string):TaskExecution {const execution=loadExecution(id);getTask(p,execution.taskId);return executionView(p,execution);},
  getExecutionByCommandKey(p:Principal,taskId:string,key:string):TaskExecution|null {getTask(p,taskId);const row=db.prepare('SELECT * FROM task_executions WHERE task_id=? AND command_key=?').get(taskId,key);return row?executionView(p,executionRow(row)):null;},
  executionForConversation(p:Principal,conversationId:string):TaskExecution|null {const row=db.prepare('SELECT * FROM task_executions WHERE conversation_id=?').get(conversationId);if(!row)return null;getTask(p,row.task_id as string);return executionView(p,executionRow(row));},
  listExecutions(p:Principal,taskId:string):TaskExecution[] {return visibleExecutions(p,getTask(p,taskId));},
  planVersions,
  listTasks(p:Principal):Task[] {return listTasks(p).map(task=>taskView(p,task));},
  listLinkedTasks(p:Principal,id:string):Task[] {return listLinkedTasks(p,id).map(task=>taskView(p,task));},
  snapshotProgress(p:Principal,conversationId:string):TaskProgressSnapshot[] {return listLinkedTasks(p,conversationId).filter(task=>task.automaticProgress&&!isMandalaOwned(task.id)&&!['completed','cancelled'].includes(task.state)).map(task=>progressSnapshot(p,task.id));},
  applyTaskProgress(p:Principal,snapshot:TaskProgressSnapshot,nextState:TaskProgressState,guard?:()=>boolean):boolean {
   requireRoot(p);return store.transaction(()=>commitTaskProgress(p,snapshot,nextState,guard));
  },
  applyTaskProgressBatch(p:Principal,entries:{snapshot:TaskProgressSnapshot;state:TaskProgressState;guard?:()=>boolean}[]):boolean[] {
   requireRoot(p);return store.transaction(()=>entries.map(entry=>commitTaskProgress(p,entry.snapshot,entry.state,entry.guard)));
  },
  moveTask(p:Principal,id:string,revision:number,state:Task['state'],reason:string|null,commandKey:string):Task {
   if(!['todo','running','waiting','review','completed','cancelled'].includes(state)||!Number.isSafeInteger(revision)||revision<1)fail('invalid_task',422);
   return store.transaction(()=>{
    const body={action:'move',id,revision,state,reason},previous=replay(p,commandKey,body).row;
    let task=getTask(p,id);if(previous)return taskView(p,task);
    const inquiry=pendingInquiryRun(task);
    if(task.revision!==revision)fail('revision_conflict',409);
    if(db.prepare("SELECT id FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown')").get(id))fail('task_run_active',409);
    if(task.state!==state){
     if(['completed','cancelled'].includes(task.state)){
      db.prepare("UPDATE work_tasks SET state='todo',waiting_reason=NULL,completion=NULL,continuation_epoch=continuation_epoch+1,future_auto_resume=0,revision=revision+1 WHERE id=?").run(id);
      db.prepare("UPDATE task_receipts SET delivery_state='parked' WHERE task_id=? AND delivery_state<>'consumed'").run(id);
      task=loadTask(id);store.enqueueOutbox({type:'task.reopen',aggregateId:id,aggregateRevision:task.revision,causationId:`reopen:${id}:${revision}`,payload:{taskId:id,reason}});
     }
     if(state==='completed'){
      if(task.state!=='review')task=commitUserCommand(p,id,task.revision,'complete');
      task=commitUserCommand(p,id,task.revision,'accept');
     }else if(state==='cancelled'){
      db.prepare("UPDATE work_tasks SET continuation_epoch=continuation_epoch+1,future_auto_resume=0,state='cancelled',waiting_reason=NULL,revision=revision+1 WHERE id=?").run(id);
      db.prepare("UPDATE task_receipts SET delivery_state='parked' WHERE task_id=? AND delivery_state<>'consumed'").run(id);
      if(inquiry)writeInquiryDecision(task,inquiry,'Task cancelled while waiting for an Agent reply');
      task=loadTask(id);store.enqueueOutbox({type:'task.cancelled',aggregateId:id,aggregateRevision:task.revision,causationId:`move:${id}:${revision}`,payload:{taskId:id,runId:null}});
     }else task=commitUpdateTask(p,id,task.revision,{state},commandKey,body);
    }
    if(!replay(p,commandKey,body).row)saveCommand(p,commandKey,body,id,null);

    return taskView(p,task);
   });
  },
  findInquiryWait(p:Principal,sourceRunId:string,conversationId:string):{runId:string;taskId:string}|null {
   requireRoot(p);
   const source=db.prepare('SELECT * FROM task_runs WHERE id=?').get(sourceRunId);if(!source)return null;
   const original=runRow(source);getTask(p,original.taskId);
   if(original.routing?.executionConversationId!==conversationId)fail('inquiry_resume_unavailable',409);
   let runId=sourceRunId;
   for(;;){const wait=db.prepare('SELECT * FROM task_inquiry_waits WHERE run_id=?').get(runId);if(!wait)return fail('inquiry_resume_unavailable',409);if(!wait.resumed_by_run_id)return {runId,taskId:original.taskId};runId=wait.resumed_by_run_id as string;}
  },
  stopInquiryWait(p:Principal,runId:string):boolean {
   requireRoot(p);return store.transaction(()=>{
    const run=loadRun(runId),task=getTask(p,run.taskId),wait=db.prepare('SELECT * FROM task_inquiry_waits WHERE run_id=? AND resumed_by_run_id IS NULL').get(runId);
    if(!wait||wait.task_revision!==task.revision||wait.continuation_epoch!==task.continuationEpoch||['completed','cancelled'].includes(task.state))return false;
    db.prepare('DELETE FROM task_inquiry_waits WHERE run_id=?').run(runId);
    db.prepare("UPDATE task_runs SET delivery_valid=0,waiting_reason='interrupted' WHERE id=?").run(runId);
    writeInquiryDecision(task,run,'Execution stopped while waiting for an Agent reply');
    refreshExecutionProgress(task.id);
    return true;
   });
  },
  prepareInquiryResume(p:Principal,previousRunId:string,text:string,commandKey:string):{commit:()=>Run} {
   requireRoot(p);if(!nonempty(text))fail('invalid_run_input',422);
   const previous=readRun(p,loadRun(previousRunId)),wait=db.prepare('SELECT * FROM task_inquiry_waits WHERE run_id=?').get(previousRunId),task=getTask(p,previous.taskId),snapshot=context(previousRunId);
   if(!wait||!snapshot||!previous.routing)return fail('inquiry_resume_unavailable',409);
   const replayed=replay(p,commandKey,startBody(task.id,Number(wait.task_revision))).row;
   if(replayed&&replayed.run_id===wait.resumed_by_run_id)return {commit:()=>readRun(p,loadRun(replayed.run_id as string))};
   const validate=()=>{
    const current=getTask(p,task.id),marker=db.prepare('SELECT * FROM task_inquiry_waits WHERE run_id=?').get(previousRunId),chat=store.getConversation(previous.routing!.executionConversationId);
    if(!marker||marker.resumed_by_run_id||current.revision!==marker.task_revision||current.continuationEpoch!==marker.continuation_epoch||!['running','waiting'].includes(current.state)||current.state==='waiting'&&current.waitingReason!=='input'||previous.state!=='succeeded'||!chat||chat.agentId!==loadExecution(previous.executionId).agentId||(chat.projectId||null)!==loadExecution(previous.executionId).projectId||previous.snapshot&&(previous.snapshot.goal!==current.goal||canonical(previous.snapshot.criteria)!==canonical(current.criteria)||previous.snapshot.acceptance!==current.acceptance))fail('inquiry_resume_unavailable',409);
   };
   validate();
   const selection:ReturnType<TaskResolver>={agentId:loadExecution(previous.executionId).agentId,projectId:loadExecution(previous.executionId).projectId,hostId:previous.hostId!,input:snapshot.input+'\n\nAgent inquiry reply (data):\n'+JSON.stringify(text),sourceVersions:[...new Map([...snapshot.sourceVersions,...previous.artifactVersions].map(ref=>[ref.versionId,ref])).values()],requiredOutputAssetIds:snapshot.requiredOutputAssetIds,effectiveCapabilities:snapshot.effectiveCapabilities,nativeVisibility:'partial',...(previous.continuation?{continuation:previous.continuation}:{})};
   const prepared=prepareStart(p,task.id,task.revision,commandKey,randomUUID(),{selection,executionId:previous.executionId,allowStaleContinuation:true});
   return {commit:()=>{
    if(!db.isTransaction)fail('transaction_required',500);validate();
    const run=prepared.commit(previous.routing!);
    if(previous.snapshot)db.prepare('UPDATE task_runs SET execution_snapshot=? WHERE id=?').run(JSON.stringify(previous.snapshot),run.id);
    db.prepare('UPDATE task_inquiry_waits SET resumed_by_run_id=? WHERE run_id=?').run(run.id,previousRunId);
    if(wait.completion_agent_id===loadExecution(previous.executionId).agentId)db.prepare('INSERT INTO task_completion_intents VALUES (?,?,?)').run(run.id,task.revision+1,wait.completion_agent_id as string);
    return loadRun(run.id);
   }};
  },
  requestCompletion(p:Principal,id:string,revision:number,commandKey:string):Task & {completionRequested?:boolean} {
   return store.transaction(()=>{
    const task=getTask(p,id),run=p.runId?loadRun(p.runId):null;
    if(!p.agentId||!run||run.taskId!==id||p.agentId!==loadExecution(run.executionId).agentId)return fail('forbidden',403);
    const body={action:'request_completion',id,revision},previous=replay(p,commandKey,body).row;
    if(previous)return {...taskView(p,task),...(db.prepare('SELECT run_id FROM task_completion_intents WHERE run_id=?').get(run.id)?{completionRequested:true}:{})};
    if(task.revision!==revision)fail('revision_conflict',409);
    if(run.state!=='running')fail('task_run_active',409);
    db.prepare('INSERT INTO task_completion_intents VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET task_revision=excluded.task_revision,agent_id=excluded.agent_id').run(run.id,revision,p.agentId);
    saveCommand(p,commandKey,body,id,run.id);
    store.enqueueOutbox({type:'task.completion_requested',aggregateId:id,aggregateRevision:revision,causationId:commandKey,payload:{taskId:id,runId:run.id}});
    return {...taskView(p,loadTask(id)),completionRequested:true};
   });
  },
  prepareUpdate(p:Principal,id:string,revision:number,patch:TaskPatch,commandKey:string) {return {commit:()=>{if(!db.isTransaction)fail('transaction_required',500);return taskView(p,commitUpdateTask(p,id,revision,patch,commandKey,{action:'update',id,revision,patch}));}};},
  updateTask(p:Principal,id:string,revision:number,patch:TaskPatch,commandKey:string):Task {
   return taskView(p,store.transaction(()=>commitUpdateTask(p,id,revision,patch,commandKey,{action:'update',id,revision,patch})));
  },
  attachExecution(p:Principal,id:string,revision:number,conversationId:string,commandKey:string):Task {
   if(!Number.isSafeInteger(revision)||revision<1||!nonempty(conversationId))fail('invalid_execution',422);
   return store.transaction(()=>{
    const task=getTask(p,id),body={action:'attach_execution',id,revision,conversationId};
    if(replay(p,commandKey,body).row)return taskView(p,task);
    if(task.revision!==revision)fail('revision_conflict',409);
    authorizeConversation(p,conversationId);
    const chat=store.getConversation(conversationId)!;
    if(chat.purpose==='mandala-main')fail('primary_conversation',422);
    if(!chat.agentId)fail('execution_agent_required',422);
    const first=store.listEvents(conversationId,0).find(event=>event.kind==='user'&&isHumanInput(event.data as Record<string,unknown>));
    const request=typeof (first?.data as {text?:unknown}|undefined)?.text==='string'?(first!.data as {text:string}).text.trim():'';
    writeExecution(p,id,{conversationId,agentId:chat.agentId,projectId:chat.projectId||null,request:request||task.goal.split(/\r?\n/)[0].trim(),createdByAgentId:p.agentId??null},commandKey);
    db.prepare('UPDATE work_tasks SET revision=revision+1 WHERE id=?').run(id);
    advanceInquiryRevision(id,task.revision);
    saveCommand(p,commandKey,body,id,null);
    store.enqueueOutbox({type:'task.execution_added',aggregateId:id,aggregateRevision:revision+1,causationId:commandKey,payload:{taskId:id,conversationId}});
    return taskView(p,loadTask(id));
   });
  },
  removeExecution(p:Principal,id:string,revision:number,executionId:string,commandKey:string):Task {
   if(!Number.isSafeInteger(revision)||revision<1||!nonempty(executionId))fail('invalid_execution',422);
   return store.transaction(()=>{
    const task=getTask(p,id),body={action:'remove_execution',id,revision,executionId};
    if(replay(p,commandKey,body).row)return taskView(p,task);
    if(task.revision!==revision)fail('revision_conflict',409);
    const execution=loadExecution(executionId);
    if(execution.taskId!==id)fail('execution_not_found',404);
    authorizeConversation(p,execution.conversationId);
    const chat=store.getConversation(execution.conversationId)!,exists=(table:string)=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const inputs=exists('task_user_inputs')&&db.prepare("SELECT id FROM task_user_inputs WHERE conversation_id=? AND (state IN ('queued','running','unknown','completed') OR id IN (SELECT input_id FROM task_input_invocations)) LIMIT 1").get(chat.id);
    const history=store.listEvents(chat.id,0).some(event=>['text','tool','hook','approval','error','progress'].includes(event.kind)||event.kind==='status'&&['running','approval'].includes((event.data as {status?:string}).status??''));
    const occupied=['task_native_uncertainty','task_directory_claims','file_execution_scopes'].some(table=>exists(table)&&db.prepare(`SELECT 1 FROM ${table} WHERE conversation_id=? LIMIT 1`).get(chat.id));
    if(execution.supersededByExecutionId||chat.nativeId||chat.turnId||['running','approval','interrupted','error'].includes(chat.status)||history||inputs||occupied||
      db.prepare('SELECT id FROM task_runs WHERE execution_id=? LIMIT 1').get(executionId)||
      db.prepare("SELECT id FROM task_receipts WHERE execution_id=? OR destination_conversation_id=? AND delivery_state IN ('pending','presented') LIMIT 1").get(executionId,chat.id))fail('execution_has_history',409);
    db.prepare('DELETE FROM task_executions WHERE id=?').run(executionId);
    db.prepare('UPDATE work_tasks SET revision=revision+1 WHERE id=?').run(id);
    advanceInquiryRevision(id,task.revision);
    saveCommand(p,commandKey,body,id,null);
    store.enqueueOutbox({type:'task.execution_removed',aggregateId:id,aggregateRevision:revision+1,causationId:commandKey,payload:{taskId:id,executionId}});
    return taskView(p,loadTask(id));
   });
  },
  userCommand(p:Principal,id:string,revision:number,action:'complete'|'accept'|'reopen'|'request_changes'|'assign',value:string|null=null,expectedOutput?:ExpectedOutput,commandKey?:string):Task {

   return taskView(p,store.transaction(()=>commitUserCommand(p,id,revision,action,value,expectedOutput,commandKey)));
  },
  adoptPlan(p:Principal,plan:VersionRef,steps:PlanStepInput[],commandKey:string):Task[] {
   requireRoot(p);
   if(!plan||!nonempty(plan.assetId)||!nonempty(plan.versionId)||!Array.isArray(steps)||!steps.length||steps.length>100||steps.some(s=>!s||!nonempty(s.key)||!nonempty(s.goal)||s.taskId!==null&&!nonempty(s.taskId))||new Set(steps.map(s=>s.key)).size!==steps.length)fail('invalid_plan',422);
   const body={plan,steps},check=replay(p,commandKey,body);
   return store.transaction(()=>{
    authorizeVersions(p,[plan]);
    const old=db.prepare('SELECT * FROM task_plan_commands WHERE principal=? AND command_key=?').get(check.principal,commandKey);
    if(old){if(old.payload_hash!==check.payloadHash)fail('idempotency_conflict',409);return parse<string[]>(old.task_ids).map(id=>taskView(p,getTask(p,id)));}
    const selected=new Map<string,Task>(),changedExisting=new Set<string>();
    for(const step of steps){
     const prior=db.prepare('SELECT * FROM task_plan_steps WHERE plan_version_id=? AND step_key=?').get(plan.versionId,step.key);
     if(prior){if(prior.input!==canonical(step))fail('plan_step_conflict',409);selected.set(step.key,getTask(p,prior.task_id as string));continue;}
     const task=step.taskId?getTask(p,step.taskId):prepareCreate(p,{goal:step.goal,criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null},`plan:${plan.versionId}:${step.key}`).commit();
     db.prepare('INSERT INTO task_plan_steps VALUES (?,?,?,?)').run(plan.versionId,step.key,task.id,canonical(step));selected.set(step.key,task);if(step.taskId)changedExisting.add(task.id);
    }
    for(const id of changedExisting){db.prepare('UPDATE work_tasks SET revision=revision+1 WHERE id=?').run(id);store.enqueueOutbox({type:'task.plan_adopted',aggregateId:id,aggregateRevision:loadTask(id).revision,causationId:commandKey,payload:{taskId:id,plan}});}
    const result=steps.map(s=>taskView(p,loadTask(selected.get(s.key)!.id)));db.prepare('INSERT INTO task_plan_commands VALUES (?,?,?,?)').run(check.principal,commandKey,check.payloadHash,JSON.stringify(result.map(t=>t.id)));return result;
   });
  },
  getRunControl(p:Principal,id:string):RunControl { const row=db.prepare(`SELECT ${controlColumns} FROM task_runs WHERE id=?`).get(id);if(!row)return fail('run_not_found',404);authorizeControl(p,row.task_id as string);return controlRow(row); },
  listRunControls(p:Principal,taskId:string):RunControl[] { authorizeControl(p,taskId);return db.prepare(`SELECT ${controlColumns} FROM task_runs WHERE task_id=? ORDER BY attempt`).all(taskId).map(controlRow); },
  getRun(p: Principal, id: string): Run { return readRun(p, loadRun(id)); },
  listRuns(p: Principal, taskId: string): Run[] { getTask(p, taskId); return db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY attempt').all(taskId).map(row => readRun(p, runRow(row))); },
  listReceipts(p: Principal, taskId: string): Receipt[] {
   getTask(p, taskId);
   const receipts = db.prepare('SELECT * FROM task_receipts WHERE task_id=? ORDER BY created_at,id').all(taskId).map(receiptRow);
   for (const receipt of receipts) {
    if (receipt.sourceRunId) authorizeVersions(p, context(receipt.sourceRunId)?.sourceVersions ?? []);
    authorizeVersions(p, receipt.artifactVersions);
   }
   return receipts;
  },
  getContextSnapshot(p: Principal, runId: string): ContextSnapshot | null {
   getTask(p, loadRun(runId).taskId);
   const snapshot = context(runId);
   authorizeVersions(p, snapshot?.sourceVersions ?? []);
   return snapshot;
  },
  prepareCreate,
  createTask(p: Principal, input: TaskInput, commandKey: string, creationSource?:'system'): Task {
   const prepared = prepareCreate(p,input,commandKey,creationSource);
   return taskView(p,store.transaction(() => prepared.commit()));
  },
  markUnknown(runId: string) {
   store.transaction(() => {
    const run=loadRun(runId);
    if (!['starting','running','approval','unknown'].includes(run.state)) return;
    if(run.routing)retainNativeOccupancy(store,'run',run.id,run.routing.executionConversationId);
    db.prepare("UPDATE task_runs SET state='unknown' WHERE id=?").run(runId);
    const task=loadTask(run.taskId);
    const changed=db.prepare("UPDATE work_tasks SET state='waiting',waiting_reason='input',revision=revision+1 WHERE id=? AND state='running'").run(run.taskId);
    if(changed.changes)advanceInquiryRevision(run.taskId,task.revision);
    store.enqueueOutbox({type:'task.recovery_unknown',aggregateId:run.taskId,aggregateRevision:loadTask(run.taskId).revision,causationId:runId,payload:{runId}});

   });
  },
  abandonUnknown(p: Principal, runId: string, expectedRevision: number) {
   requireRoot(p);
   store.transaction(() => {
    const run=loadRun(runId),task=getTask(p,run.taskId);
    if(task.revision!==expectedRevision) fail('revision_conflict',409);
    if(run.state!=='unknown') fail('run_not_unknown',409);
    if(run.routing)retainNativeOccupancy(store,'run',run.id,run.routing.executionConversationId);
    finishRun(run,{outcome:'interrupted',summary:'',artifactVersions:[],eventKey:`abandon:${runId}`});
   });
  },
  findStart(p: Principal, taskId: string, commandKey: string, expectedRevision?: number): Run | null {
   getTask(p, taskId);
   const row = expectedRevision===undefined ? db.prepare('SELECT * FROM task_command_dedup WHERE principal=? AND command_key=?').get(canonical(p), commandKey) : replay(p,commandKey,startBody(taskId,expectedRevision)).row;
   if (!row) return null;
   if (row.task_id !== taskId || !row.run_id) fail('idempotency_conflict', 409);
   return readRun(p, loadRun(row.run_id as string));
  },
  // Trusted service helper: resolver runs now, commit must run within the caller's short transaction.
  prepareStart,
  startTask(p: Principal, taskId: string, expectedRevision: number, commandKey: string): Run {
   const prepared = prepareStart(p, taskId, expectedRevision, commandKey);
   return store.transaction(() => prepared.commit());
  },
  authorizeReceipt(p: Principal, id: string): Receipt {
   const row = db.prepare('SELECT * FROM task_receipts WHERE id=?').get(id);
   if (!row) return fail('receipt_not_found', 404);
   const receipt = receiptRow(row);
   // Delivery to an assigned coordinator does not grant access to input/output assets.
   if (receipt.taskId && p.runId) {
    const coordinator = loadRun(p.runId), parent = getTask(p, receipt.taskId);
    if (coordinator.taskId !== parent.id || loadExecution(coordinator.executionId).agentId !== p.agentId) fail('forbidden', 403);
   } else if (receipt.taskId) getTask(p, receipt.taskId);
   else { requireRoot(p); if (p.userId !== store.ownerUserId) fail('forbidden', 403); }
   if (receipt.sourceRunId) authorizeVersions(p, context(receipt.sourceRunId)?.sourceVersions ?? []);
   authorizeVersions(p, receipt.artifactVersions);
   return receipt;
  },
  authorizeReceiptDelivery(p: Principal, id: string, conversationId: string): Receipt {
   const receipt=this.authorizeReceipt(p,id);
   if(receipt.destinationConversationId!==conversationId)fail('receipt_scope_changed',409);
   if(receipt.taskId){
    const parent=getTask(p,receipt.taskId);
    const finalNotify=parent.state==='completed'&&receipt.policy==='notify'&&(parent.completion?.completedBy==='agent'&&parent.completion.sourceRunId===receipt.sourceRunId||parent.completion?.completedBy==='checks'&&Boolean(db.prepare("SELECT r.id FROM task_runs r JOIN task_executions e ON e.id=r.execution_id WHERE r.id=? AND e.superseded_by_execution_id IS NULL AND r.id=(SELECT id FROM task_runs WHERE execution_id=e.id ORDER BY attempt DESC LIMIT 1) AND json_extract(r.completion,'$.completedBy')='checks'").get(receipt.sourceRunId)));
    if(parent.state==='cancelled'||parent.state==='completed'&&!finalNotify||receipt.capturedEpoch!==parent.continuationEpoch)fail('receipt_scope_changed',409);
   }else{
    const run=receipt.sourceRunId?loadRun(receipt.sourceRunId):null;
    if(!run||run.snapshot?.rule?.reportConversationId!==conversationId||run.routing?.destinationConversationId!==conversationId||getTask(p,run.taskId).state==='cancelled')fail('receipt_scope_changed',409);
   }
   return receipt;
  },
  appendReceiptContext(p: Principal, runId: string, receipts: Receipt[]) {
   if (!db.isTransaction) fail('transaction_required', 500);
   const run = loadRun(runId), task = getTask(p, run.taskId), snapshot = context(runId);
   if (p.runId !== runId || p.agentId !== loadExecution(run.executionId).agentId || run.state !== 'queued' || !snapshot) fail('forbidden', 403);
   const refs = [...snapshot!.sourceVersions];
   for (const receipt of receipts) {
    const sources = [...(receipt.sourceRunId ? context(receipt.sourceRunId)?.sourceVersions ?? [] : []), ...receipt.artifactVersions];
    for (const ref of sources) {
     if (refs.some(v => v.versionId === ref.versionId)) continue;
     if (!options.assets) fail('assets_required', 422);
     const v = options.assets!.getAuthorizedVersion(p, ref);
     refs.push({ ...ref, files: v.files, accessRevision: v.accessRevision });
     db.prepare('INSERT OR IGNORE INTO task_context_versions VALUES (?,?)').run(runId, ref.versionId);
     db.prepare('INSERT OR IGNORE INTO artifact_links VALUES (?,?)').run(runId, ref.versionId);
    }
   }
   const text = snapshot!.input + '\n\nTask receipts (data):\n' + JSON.stringify(receipts.map(r => ({ id: r.id, sourceRunId: r.sourceRunId, summary: r.summary, artifactVersions: r.artifactVersions })));
   db.prepare('UPDATE context_snapshots SET input=?,input_hash=?,source_versions=? WHERE run_id=?').run(text, hash(text), JSON.stringify(refs), runId);
  },
  rejectQueuedRun(p: Principal, runId: string, reason: 'forbidden'|'native_history_changed'|'native_background_active'|'native_background_check_failed') {
   requireRoot(p);
   if (!db.isTransaction) fail('transaction_required', 500);
   const run = loadRun(runId); getTask(p, run.taskId);
   const changedHistory=reason==='native_history_changed',backgroundBlocked=reason.startsWith('native_background_'),unsubmitted=changedHistory||backgroundBlocked;
   if (run.state !== 'queued' && !(unsubmitted && run.state === 'starting')) fail('run_not_queued', 409);
   if (unsubmitted && (run.nativeSessionId || run.nativeTurnId)) fail('run_already_submitted', 409);
   finishRun(run, { outcome: 'interrupted', summary:backgroundBlocked?'Task was not submitted: background commands are running or could not be checked. Wait and retry explicitly.':changedHistory?'Native session context changed; explicit re-preparation is required':'Input access revoked', artifactVersions: [], eventKey: `${changedHistory ? 'context' : 'access'}:${run.id}` }, reason==='forbidden'?null:reason);
   db.prepare("UPDATE task_receipts SET delivery_state='parked',claim_error=? WHERE claimed_by_run_id=?").run(reason, run.id);
  },
  stopTask(p: Principal, taskId: string, expectedRevision: number, cancel = false): { status: 'stopped' | 'cancelled' | 'already_finished'; run: Run | null; runs?: Run[] } {
   requireRoot(p);
   return store.transaction(() => {
    const task = getTask(p, taskId);
    const row = db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(taskId);
    const run = row ? runRow(row) : null;
    const activeRuns=db.prepare("SELECT * FROM task_runs WHERE task_id=? AND state IN ('queued','starting','running','approval','unknown') ORDER BY attempt").all(taskId).map(runRow);
    const active = activeRuns.length>0;
    const inquiryWait=!active&&run?pendingInquiryRun(task):null;
    // Accept only the single intervening revision proved to be this attempt's native terminal.
    // A successor attempt or any unrelated edit still requires the caller to refresh its revision.
    const terminalWon = task.revision === expectedRevision + 1 && run && !active && run.nativeSessionId && run.nativeTurnId && run.terminalEventKey &&
     db.prepare("SELECT sequence FROM outbox WHERE type='task.run_terminal' AND aggregate_id=? AND aggregate_revision=? AND causation_id=? AND json_extract(payload,'$.runId')=?")
      .get(taskId, task.revision, run.terminalEventKey, run.id);
    if (task.revision !== expectedRevision && !terminalWon) fail('revision_conflict', 409);
    const pendingContinuation = task.futureAutoResume || db.prepare("SELECT id FROM task_receipts WHERE task_id=? AND delivery_state IN ('pending','presented') LIMIT 1").get(taskId);
    if (task.state === 'cancelled' || task.state === 'completed' && !terminalWon && !pendingContinuation) return { status: 'already_finished', run: null };
    for (const activeRun of activeRuns) {
     const outputs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_versions'").get()
      ? db.prepare("SELECT id,asset_id FROM asset_versions WHERE json_extract(data,'$.provenance.runId')=?").all(activeRun.id).map(r => ({ assetId: r.asset_id as string, versionId: r.id as string })) : [];
     finishRun(activeRun, { outcome: 'interrupted', summary: 'Execution stopped', artifactVersions: outputs, eventKey: `stop:${activeRun.id}` });
    }
    const state = task.state === 'completed' ? 'completed' : cancel ? 'cancelled' : active || !run || inquiryWait ? 'waiting' : task.state;
    const reason = state === 'waiting' ? active || !run || inquiryWait ? 'interrupted' : task.waitingReason : null;
    db.prepare('UPDATE work_tasks SET continuation_epoch=continuation_epoch+1,future_auto_resume=0,state=?,waiting_reason=?,revision=revision+1 WHERE id=?').run(state, reason, taskId);
    db.prepare("UPDATE task_receipts SET delivery_state='parked' WHERE task_id=? AND delivery_state<>'consumed'").run(taskId);
    if(inquiryWait&&run)writeInquiryDecision(task,run,cancel?'Task cancelled while waiting for an Agent reply':'Execution stopped while waiting for an Agent reply');
    store.enqueueOutbox({ type: state === 'cancelled' ? 'task.cancelled' : 'task.stopped', aggregateId: taskId, aggregateRevision: loadTask(taskId).revision, causationId: `stop:${taskId}:${expectedRevision}`, payload: { taskId, runId: active ? activeRuns.at(-1)!.id : null } });

    return { status: task.state === 'completed' ? 'already_finished' : cancel ? 'cancelled' : active || !run || inquiryWait ? 'stopped' : 'already_finished', run: active ? loadRun(activeRuns.at(-1)!.id) : null,...(active?{runs:activeRuns.map(item=>loadRun(item.id))}:{}) };
   });
  },
  // Internal adapter boundary: only an observed native start may establish this mapping.
  bindRunIdentity(identity: RunIdentity): 'applied' | 'duplicate' | 'unmatched' {
   if (![identity.runId, identity.hostId, identity.nativeSessionId, identity.nativeTurnId].every(nonempty)) return 'unmatched';
   return store.transaction(() => {
    const row = db.prepare('SELECT * FROM task_runs WHERE id=?').get(identity.runId);
    if (!row) return 'unmatched';
    const run = runRow(row);
    if (run.hostId !== identity.hostId) return 'unmatched';
    if (run.nativeSessionId !== null || run.nativeTurnId !== null) return run.nativeSessionId === identity.nativeSessionId && run.nativeTurnId === identity.nativeTurnId ? 'duplicate' : 'unmatched';
    if (!['queued', 'starting'].includes(run.state)) return 'unmatched';
    if (db.prepare('SELECT id FROM task_runs WHERE host_id=? AND native_session_id=? AND native_turn_id=?').get(identity.hostId, identity.nativeSessionId, identity.nativeTurnId)) return 'unmatched';
    db.prepare("UPDATE task_runs SET state='running',native_session_id=?,native_turn_id=? WHERE id=?").run(identity.nativeSessionId, identity.nativeTurnId, run.id);
    const task = loadTask(run.taskId);
    store.enqueueOutbox({ type: 'task.run_started', aggregateId: task.id, aggregateRevision: task.revision, causationId: run.id, payload: { taskId: task.id, runId: run.id } });
    return 'applied';
   });
  },
  // Internal adapter boundary; stale identities and terminal states cannot be revived.
  setRunApproval(identity:RunIdentity,approval:boolean):void {
   store.transaction(()=>{
    const before=db.prepare('SELECT task_id,state FROM task_runs WHERE id=?').get(identity.runId);
    const changed=db.prepare("UPDATE task_runs SET state=? WHERE id=? AND host_id=? AND native_session_id=? AND native_turn_id=? AND state IN ('running','approval')").run(approval?'approval':'running',identity.runId,identity.hostId,identity.nativeSessionId,identity.nativeTurnId);
    if(changed.changes&&approval&&before?.state!=='approval')store.enqueueOutbox({type:'task.execution_attention',aggregateId:before!.task_id as string,aggregateRevision:1,causationId:`${identity.runId}:approval`,payload:{taskId:before!.task_id,runId:identity.runId,reason:'approval',state:'approval'}});
    if(changed.changes)refreshExecutionProgress(before!.task_id as string);
   });
  },
  applyRunEvent(event: TerminalRunEvent): 'applied' | 'duplicate' | 'unmatched' {
   if (!event || ![event.runId, event.hostId, event.nativeSessionId, event.nativeTurnId, event.eventKey].every(nonempty) ||
    !['succeeded', 'failed', 'interrupted'].includes(event.outcome) || typeof event.summary !== 'string' || !Array.isArray(event.artifactVersions) ||
    event.artifactVersions.some(ref => !ref || !nonempty(ref.assetId) || !nonempty(ref.versionId))) fail('invalid_terminal_event', 422);
   // Physical availability is observed outside the terminal transaction. The immutable
   // version and current recursive authority are checked again in finishRun below.
   let available=true, integrity:'passed'|'failed'|null=null;
   const candidate=db.prepare('SELECT * FROM task_runs WHERE id=?').get(event.runId);
   if(candidate && candidate.host_id===event.hostId && candidate.native_session_id===event.nativeSessionId && candidate.native_turn_id===event.nativeTurnId && !terminalStates.has(candidate.state as string)){
    const task=loadTask(candidate.task_id as string),actor={userId:task.ownerUserId,agentId:loadExecution(candidate.execution_id as string).agentId,runId:event.runId};
    const verifyIntegrity=event.outcome==='succeeded'&&(runRow(candidate).snapshot?.acceptance??task.acceptance)==='checks'&&(runRow(candidate).snapshot?.criteria??task.criteria).length>0&&(runRow(candidate).snapshot?.criteria??task.criteria).every(c=>c.checkRef==='artifact:integrity')&&event.artifactVersions.length>0;
    if(verifyIntegrity)integrity='passed';
    let checkedBytes=0;
    for(const ref of event.artifactVersions){
     const published=db.prepare('SELECT data FROM asset_versions WHERE id=? AND asset_id=?').get(ref.versionId,ref.assetId);
     if(!published||parse<{provenance:{runId?:string}}>(published.data).provenance.runId!==event.runId)continue;
     try{
      if(!options.assets)fail('assets_required',422);
      const version=options.assets!.getAuthorizedVersion(actor,ref);
      for(let index=0;index<version.files.length;index++){
       const file=options.assets!.readAssetFile(actor,ref,String(index));
       if(!verifyIntegrity)continue;
       checkedBytes+=file.size;
       if(checkedBytes>250*1024*1024){integrity=null;continue;}
       const descriptor=openSync(file.blobPath,constants.O_RDONLY|constants.O_NOFOLLOW);
       try{
        const before=fstatSync(descriptor),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0,read=0;
        while((read=readSync(descriptor,buffer,0,buffer.length,null))>0){size+=read;if(size>file.size)break;hash.update(buffer.subarray(0,read));}
        const after=fstatSync(descriptor);
        if(!before.isFile()||size!==file.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||hash.digest('hex')!==version.files[index].blobHash)integrity='failed';
       }finally{closeSync(descriptor);}
      }
     }catch(error){if(!(error instanceof DomainError)||!['forbidden','blob_missing'].includes(error.code))throw error;available=false;}
    }
   }
   return store.transaction(() => {
    const row = db.prepare('SELECT * FROM task_runs WHERE id=?').get(event.runId);
    const run = row ? runRow(row) : null;
    if (!run || run.hostId !== event.hostId || run.nativeSessionId !== event.nativeSessionId || run.nativeTurnId !== event.nativeTurnId || !['running', 'approval', 'unknown', ...terminalStates].includes(run.state)) {
     db.prepare('INSERT OR IGNORE INTO task_event_diagnostics(run_id,event_key,reason,created_at) VALUES (?,?,?,?)').run(event.runId, event.eventKey, 'identity_unmatched', new Date().toISOString());
     return 'unmatched';
    }
    if (terminalStates.has(run.state)) return 'duplicate';
    finishRun(run, event, null, available, integrity);
    return 'applied';
   });
  },
 };
}
