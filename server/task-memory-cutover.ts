import {createHash} from 'node:crypto';
import type {Store} from './store';
import type {MemoryJob,MemorySource} from '../shared/memory';

// Retain fixed memory evidence when its live Task/Run objects are reset. The
// archived reader set supplements the current collection, Asset and chat ACLs.
export function preserveTaskMemory(store:Store,beforeEvents:Map<number,Record<string,unknown>>){
 const db=store.database,exists=(name:string)=>Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
 if(!exists('memory_sources'))return;
 const tasks=new Map(db.prepare('SELECT * FROM work_tasks').all().map(task=>[task.id as string,task]));
 const runs=new Map(exists('task_runs')?db.prepare('SELECT id,task_id FROM task_runs').all().map(run=>[run.id as string,run.task_id as string]):[]);
 const readers=(id:string)=>{
  const task=tasks.get(id)!,agents=[task.creator_agent_id,task.assignee_agent_id];
  if(exists('task_participants'))agents.push(...db.prepare('SELECT agent_id FROM task_participants WHERE task_id=?').all(id).map(row=>row.agent_id));
  if(exists('task_executions'))agents.push(...db.prepare('SELECT agent_id FROM task_executions WHERE task_id=?').all(id).map(row=>row.agent_id));
  return new Set(agents.filter((agent):agent is string=>typeof agent==='string'));
 };
 const eventHash=(event:Record<string,unknown>)=>createHash('sha256').update(JSON.stringify({...event,data:JSON.parse(event.data as string)})).digest('hex');
 const changedEvents=new Map([...beforeEvents].map(([id,before])=>[id,{before:eventHash(before),after:eventHash(db.prepare('SELECT id,conversationId,kind,data,createdAt FROM events WHERE id=?').get(id)!)}]));
 const affected=new Set<string>();
 const migrate=(source:MemorySource)=>{
  const fingerprint=(events:MemorySource['events'])=>createHash('sha256').update(JSON.stringify({events,memoryRefs:source.memoryRefs??[],invocationId:source.invocationId??null})).digest('hex');
  const currentFingerprint=source.kind==='conversation'&&source.fingerprint===fingerprint(source.events);
  const taskIds=[...new Set([source.taskId,...source.runIds.map(id=>runs.get(id))].filter((id):id is string=>Boolean(id&&tasks.has(id))))];
  if(taskIds.length){
   let agentIds=[...readers(taskIds[0])];
   for(const id of taskIds.slice(1))agentIds=agentIds.filter(agent=>readers(id).has(agent));
   source.taskResetAuthority={ownerUserId:tasks.get(taskIds[0])!.owner_user_id as string,agentIds,taskIds,runIds:source.runIds.filter(id=>runs.has(id))};
   affected.add(source.id);
  }
  // Only a hash that matched before our metadata-only edit may be refreshed.
  source.events=source.events.map(event=>{const changed=changedEvents.get(event.id);return changed&&event.hash===changed.before?{...event,hash:changed.after}:event;});
  if(currentFingerprint)source.fingerprint=fingerprint(source.events);
  return JSON.stringify(source);
 };
 for(const table of ['memory_sources','memory_source_revisions'])if(exists(table))for(const row of db.prepare(`SELECT rowid,data FROM ${table}`).all()){
  const data=migrate(JSON.parse(row.data as string));
  if(data!==row.data)db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(data,row.rowid as number);
 }
 if(exists('memory_jobs'))for(const row of db.prepare('SELECT id,data FROM memory_jobs').all()){
  const job=JSON.parse(row.data as string) as MemoryJob;
  if(['queued','running','pending'].includes(job.state)&&job.sourceRefs.some(ref=>affected.has(ref.sourceId)))db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'obsolete',error:'task_schema_reset',leaseToken:job.leaseToken+1,leaseUntil:null,workerId:null}),row.id as string);
 }
}
