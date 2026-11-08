import type { Store } from './store';
// Maintenance operation: caller stops memory workers first. Never deletes conversation/Task/Asset authorities.
export function resetMemory(store:Store):{records:number;sources:number;jobs:number} {
 const db=store.database;
 return store.transaction(()=>{
  const count=(table:string)=>Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const result={records:count('memory_records'),sources:count('memory_sources'),jobs:count('memory_jobs')};
  db.exec('CREATE TABLE IF NOT EXISTS memory_capture_cutoffs(conversation_id TEXT PRIMARY KEY,last_event_id INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS memory_task_capture_cutoffs(task_id TEXT PRIMARY KEY,last_revision INTEGER NOT NULL)');
  for(const chat of store.listConversations())db.prepare('INSERT OR REPLACE INTO memory_capture_cutoffs VALUES (?,?)').run(chat.id,store.listEvents(chat.id,0).at(-1)?.id??0);
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='work_tasks'").get())db.exec('INSERT OR REPLACE INTO memory_task_capture_cutoffs SELECT id,revision FROM work_tasks');
  const tables=['memory_scene_recoveries','memory_l1_reuse','memory_vectors','memory_vector_models','memory_scene_hits','memory_output_verifications','memory_output_drafts','memory_consolidation_cursors','memory_schedule','memory_scheduled_jobs','memory_scene_cursors','memory_scene_checkpoints','memory_extraction_drafts','memory_uses','memory_index','memory_record_links','memory_record_scope','memory_session_summaries','memory_suppressions','memory_revisions','memory_records','memory_jobs','memory_source_revisions','memory_sources'];
  for(const table of tables)if(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table))db.exec(`DELETE FROM ${table}`);
  for(const row of db.prepare('SELECT id,data FROM memory_collections').all()){
   const c=JSON.parse(row.data as string);c.generation++;db.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify(c),row.id as string);
  }
  return result;
 });
}
