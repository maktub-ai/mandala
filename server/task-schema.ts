import {mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import {preserveTaskMemory} from './task-memory-cutover';

// The task model changed incompatibly. A coherent SQLite snapshot must succeed
// before the task-only cutover; native chat queues and unrelated data survive.
export function initializeTaskSchema(store:Store){
 const db=store.database;
 const exists=(name:string)=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
 const old=exists('task_conversation_links')||exists('work_tasks')&&!db.prepare('PRAGMA table_info(work_tasks)').all().some(row=>row.name==='origin_conversation_id');
 if(old){
  const source=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file as string;
  if(!source)throw new Error('Task schema upgrade requires a file-backed database backup');
  const directory=join(dirname(source),'backups');mkdirSync(directory,{recursive:true});
  const backup=join(directory,`tasks-executions-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`);
  db.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);
  const oldTasks=new Set(db.prepare('SELECT id FROM work_tasks').all().map(row=>row.id as string));
  const oldRuns=new Set(exists('task_runs')?db.prepare('SELECT id FROM task_runs').all().map(row=>row.id as string):[]);
  const oldReceipts=new Set(exists('task_receipts')?db.prepare('SELECT id FROM task_receipts').all().map(row=>row.id as string):[]);
  db.exec('PRAGMA foreign_keys=OFF');
  try{store.transaction(()=>{
   if(exists('task_user_inputs')){
    const columns=db.prepare('PRAGMA table_info(task_user_inputs)').all();
    if(columns.some(row=>row.name==='source')){
     if(exists('task_input_invocations'))db.exec("DELETE FROM task_input_invocations WHERE input_id IN (SELECT id FROM task_user_inputs WHERE json_extract(source,'$.kind')='coordination')");
     db.exec("DELETE FROM task_user_inputs WHERE json_extract(source,'$.kind')='coordination'");
    }
   }
   if(exists('task_native_uncertainty'))db.exec("DELETE FROM task_native_uncertainty WHERE kind='run'");
   for(const name of ['task_directory_claims','task_directory_waits'])if(exists(name))db.exec(`DELETE FROM ${name} WHERE kind='run'`);
   if(exists('automation_rules'))db.exec("UPDATE automation_rules SET data=json_remove(data,'$.taskId','$.executionTaskId','$.goalId')");
   if(exists('automation_occurrences'))db.exec("UPDATE automation_occurrences SET task_id=NULL,data=json_remove(data,'$.taskId','$.executionTaskId','$.goalId','$.sourceTaskId','$.runId','$.executionId')");
   if(exists('automation_create_receipts'))db.exec('DELETE FROM automation_create_receipts');
   db.exec("DELETE FROM outbox WHERE type LIKE 'task.%'; DELETE FROM tasks");
   const cleanReferences=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(cleanReferences);
    if(!value||typeof value!=='object')return value;
    const object=value as Record<string,unknown>,coordination=typeof object.coordinationTaskId==='string'&&oldTasks.has(object.coordinationTaskId),taskEvent=typeof object.taskId==='string'&&oldTasks.has(object.taskId);
    return Object.fromEntries(Object.entries(object).filter(([key,item])=>{
     if(key==='task'&&item&&typeof item==='object'&&oldTasks.has((item as {id:string}).id))return false;
     if(coordination&&['coordinationTaskId','sourceUserEventId'].includes(key))return false;
     if(['taskId','parentTaskId'].includes(key)&&typeof item==='string'&&oldTasks.has(item))return false;
     if(key==='runId'&&typeof item==='string'&&(oldRuns.has(item)||taskEvent))return false;
     if(key==='receiptId'&&typeof item==='string'&&oldReceipts.has(item))return false;
     return !['taskIds','receiptIds','receiptContext'].includes(key);
    }).map(([key,item])=>[key,key==='source'&&item&&typeof item==='object'&&(item as {kind?:string}).kind==='coordination'?{kind:'coordination',receiptIds:[]}:cleanReferences(item)]));
   };
   const beforeEvents=new Map<number,Record<string,unknown>>();
   for(const event of db.prepare('SELECT id,conversationId,kind,data,createdAt FROM events').all()){
    const data=JSON.parse(event.data as string),cleanedData=cleanReferences(data) as Record<string,unknown>;
    if(event.kind==='user'&&data.task&&oldTasks.has(data.task.id)&&!cleanedData.source)cleanedData.source={kind:'coordination',receiptIds:[]};
    const cleaned=JSON.stringify(cleanedData);
    if(cleaned!==event.data){beforeEvents.set(event.id as number,event);db.prepare('UPDATE events SET data=? WHERE id=?').run(cleaned,event.id as number);}
   }
   preserveTaskMemory(store,beforeEvents);
   if(exists('artifact_links'))for(const runId of oldRuns)db.prepare('DELETE FROM artifact_links WHERE run_id=?').run(runId);

   const tables=['task_receipt_inputs','task_run_observations','task_progress_evaluations','task_progress_heads','mandala_ownership','mandala_delegations','task_completion_intents','task_inquiry_waits','task_plan_commands','task_plan_steps','task_creation_sources','task_participants','task_conversation_links','conversation_task_provenance','task_event_diagnostics','task_legacy_sources','task_command_dedup','task_dependencies','task_context_versions','task_output_versions','context_snapshots','task_receipts','task_runs','task_executions','work_tasks'];
   for(const table of tables)db.exec(`DROP TABLE IF EXISTS ${table}`);
   db.exec("DELETE FROM schema_migrations WHERE key IN ('durable_tasks_001_schema','durable_tasks_001_legacy','durable_tasks_002_scheduler','durable_tasks_005_native_uncertainty','durable_tasks_006_conversation_provenance','durable_tasks_007_explicit_links','durable_tasks_008_participants','task_execution_001_snapshots','task_progress_002_preference','flat_tasks_001_schema','flat_tasks_002_schema')");
  });}finally{db.exec('PRAGMA foreign_keys=ON');}
 }
 store.transaction(() => {
  const key = 'flat_tasks_002_schema';
  if (db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key)) return;
  db.exec(`CREATE TABLE work_tasks (
   id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, creator_agent_id TEXT,
   goal TEXT NOT NULL, criteria TEXT NOT NULL, acceptance TEXT NOT NULL CHECK(acceptance IN ('delivery','checks','human')),
   project_id TEXT, assignee_agent_id TEXT, origin_conversation_id TEXT REFERENCES conversations(id),
   state TEXT NOT NULL CHECK(state IN ('todo','running','waiting','review','completed','cancelled')),
   waiting_reason TEXT, revision INTEGER NOT NULL CHECK(revision>0), continuation_epoch INTEGER NOT NULL DEFAULT 0,
   future_auto_resume INTEGER NOT NULL DEFAULT 0, completion TEXT, legacy_id TEXT UNIQUE, created_at TEXT NOT NULL,
   CHECK((state='waiting')=(waiting_reason IS NOT NULL))
  );
  CREATE TABLE task_executions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id),conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),agent_id TEXT NOT NULL,project_id TEXT,request TEXT NOT NULL,criteria TEXT NOT NULL,created_by_agent_id TEXT,command_key TEXT,created_at TEXT NOT NULL,superseded_by_execution_id TEXT REFERENCES task_executions(id),UNIQUE(task_id,command_key));
  CREATE TABLE task_runs (
   id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id), execution_id TEXT NOT NULL REFERENCES task_executions(id), attempt INTEGER NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('queued','starting','running','approval','unknown','succeeded','failed','interrupted','legacy_unverified')),
   host_id TEXT, native_session_id TEXT, native_turn_id TEXT, context_snapshot_id TEXT REFERENCES context_snapshots(id),
   continuation TEXT, terminal_event_key TEXT, summary TEXT, delivery_valid INTEGER, waiting_reason TEXT, artifact_versions TEXT NOT NULL DEFAULT '[]',
   legacy_id TEXT UNIQUE, created_at TEXT NOT NULL, UNIQUE(task_id,attempt),
   UNIQUE(host_id,native_session_id,native_turn_id)
  );
  CREATE UNIQUE INDEX task_one_active_run ON task_runs(execution_id) WHERE state IN ('queued','starting','running','approval','unknown');
  CREATE TABLE context_snapshots (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id), input TEXT NOT NULL,
   input_hash TEXT NOT NULL, source_versions TEXT NOT NULL, effective_capabilities TEXT NOT NULL,
   native_visibility TEXT NOT NULL CHECK(native_visibility='partial'), required_output_asset_ids TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE task_context_versions (run_id TEXT NOT NULL REFERENCES task_runs(id), version_id TEXT NOT NULL REFERENCES asset_versions(id), PRIMARY KEY(run_id,version_id));
  CREATE TABLE task_output_versions (run_id TEXT NOT NULL REFERENCES task_runs(id), version_id TEXT NOT NULL REFERENCES asset_versions(id), PRIMARY KEY(run_id,version_id));
  CREATE TABLE task_receipts (
   id TEXT PRIMARY KEY, task_id TEXT REFERENCES work_tasks(id), source_run_id TEXT UNIQUE REFERENCES task_runs(id),
   destination_conversation_id TEXT, execution_id TEXT REFERENCES task_executions(id), captured_epoch INTEGER,
   policy TEXT NOT NULL CHECK(policy IN ('notify','resume')), delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','presented','consumed','parked')),
   claimed_by_run_id TEXT REFERENCES task_runs(id), summary TEXT NOT NULL, artifact_versions TEXT NOT NULL,
   legacy_id TEXT UNIQUE, created_at TEXT NOT NULL,
   CHECK(source_run_id IS NOT NULL OR legacy_id IS NOT NULL)
  );
  CREATE TABLE task_command_dedup (principal TEXT NOT NULL, command_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
   task_id TEXT NOT NULL REFERENCES work_tasks(id), run_id TEXT REFERENCES task_runs(id), PRIMARY KEY(principal,command_key));
  CREATE TABLE task_legacy_sources (legacy_id TEXT PRIMARY KEY, task_id TEXT REFERENCES work_tasks(id), run_id TEXT REFERENCES task_runs(id), receipt_id TEXT REFERENCES task_receipts(id), source_json TEXT NOT NULL);
  CREATE TABLE task_event_diagnostics (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, event_key TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,event_key,reason));`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key, new Date().toISOString());
 });
 store.transaction(() => {
  const key = 'durable_tasks_002_scheduler';
  if (db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key)) return;
  db.exec(`ALTER TABLE task_runs ADD COLUMN routing TEXT;
   ALTER TABLE task_receipts ADD COLUMN claim_error TEXT;
   ALTER TABLE task_receipts ADD COLUMN claim_epoch INTEGER;`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key, new Date().toISOString());
 });
 db.exec(`CREATE INDEX IF NOT EXISTS task_runs_execution_chat ON task_runs(json_extract(routing,'$.executionConversationId'));
  CREATE INDEX IF NOT EXISTS task_runs_continuation_chat ON task_runs(json_extract(continuation,'$.conversationId'));`);
 store.transaction(() => {
  const key='durable_tasks_005_native_uncertainty';
  if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec("CREATE TABLE IF NOT EXISTS task_native_uncertainty(kind TEXT NOT NULL CHECK(kind IN ('run','input')),claim_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),PRIMARY KEY(kind,claim_id)); CREATE INDEX IF NOT EXISTS task_native_uncertainty_conversation ON task_native_uncertainty(conversation_id);");
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 store.transaction(() => {
  const key='durable_tasks_006_conversation_provenance';
  if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_task_provenance(conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES task_runs(id),PRIMARY KEY(conversation_id,run_id));
   WITH RECURSIVE ancestors(conversation_id,ancestor_id) AS (
    SELECT id,json_extract(data,'$.branchedFrom.conversationId') FROM conversations WHERE json_extract(data,'$.branchedFrom.conversationId') IS NOT NULL
    UNION SELECT a.conversation_id,json_extract(c.data,'$.branchedFrom.conversationId') FROM ancestors a JOIN conversations c ON c.id=a.ancestor_id WHERE json_extract(c.data,'$.branchedFrom.conversationId') IS NOT NULL
   ), inherited(conversation_id,run_id) AS (
    SELECT a.conversation_id,r.id FROM ancestors a JOIN task_runs r ON json_extract(r.routing,'$.executionConversationId')=a.ancestor_id
    UNION SELECT a.conversation_id,p.run_id FROM ancestors a JOIN conversation_task_provenance p ON p.conversation_id=a.ancestor_id
   ) INSERT OR IGNORE INTO conversation_task_provenance SELECT conversation_id,run_id FROM inherited;`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 store.transaction(() => {
  const key='durable_tasks_008_participants';
  if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec(`CREATE TABLE task_participants(task_id TEXT NOT NULL REFERENCES work_tasks(id),agent_id TEXT NOT NULL,PRIMARY KEY(task_id,agent_id));`);
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 store.transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS task_plan_steps(plan_version_id TEXT NOT NULL REFERENCES asset_versions(id),step_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES work_tasks(id),input TEXT NOT NULL,PRIMARY KEY(plan_version_id,step_key));
   CREATE TABLE IF NOT EXISTS task_plan_commands(principal TEXT NOT NULL,command_key TEXT NOT NULL,payload_hash TEXT NOT NULL,task_ids TEXT NOT NULL,PRIMARY KEY(principal,command_key));`);
 });
 store.transaction(() => {
  const key='task_execution_001_snapshots';if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec("ALTER TABLE task_runs ADD COLUMN execution_snapshot TEXT; ALTER TABLE task_runs ADD COLUMN completion TEXT");
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 store.transaction(() => {
  const key='task_progress_002_preference';if(db.prepare('SELECT key FROM schema_migrations WHERE key=?').get(key))return;
  db.exec('ALTER TABLE work_tasks ADD COLUMN automatic_progress INTEGER NOT NULL DEFAULT 1 CHECK(automatic_progress IN (0,1))');
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(key,new Date().toISOString());
 });
 store.transaction(()=>{db.exec("CREATE TABLE IF NOT EXISTS task_creation_sources(task_id TEXT PRIMARY KEY REFERENCES work_tasks(id),source TEXT NOT NULL CHECK(source IN ('user','agent','system'))); CREATE TABLE IF NOT EXISTS task_completion_intents(run_id TEXT PRIMARY KEY REFERENCES task_runs(id),task_revision INTEGER NOT NULL,agent_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_inquiry_waits(run_id TEXT PRIMARY KEY REFERENCES task_runs(id),task_revision INTEGER NOT NULL,continuation_epoch INTEGER NOT NULL,completion_agent_id TEXT,resumed_by_run_id TEXT REFERENCES task_runs(id))");});
}
