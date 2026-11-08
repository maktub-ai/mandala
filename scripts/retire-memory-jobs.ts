import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {MemoryJob} from '../shared/memory';
type RetirementOptions={home:string;before:string;apply:boolean};
const intermediateTables=['memory_extraction_drafts','memory_output_drafts','memory_output_verifications','memory_scene_recoveries','memory_scheduled_jobs'];
const identifier=(name:string)=>'"'+name.replaceAll('"','""')+'"';
// Preserve the old runtime's durable dedupe rows; deleting them can recreate discarded work.
export function retireMemoryJobs({home,before,apply}:RetirementOptions){
 home=resolve(home);if(!existsSync(join(home,'state.sqlite'))||!Number.isFinite(Date.parse(before)))throw new Error('invalid_retirement_input');
 const db=new DatabaseSync(join(home,'state.sqlite'),{readOnly:!apply});
 db.exec('PRAGMA busy_timeout=5000');
 try{
  db.exec(apply?'BEGIN IMMEDIATE':'BEGIN');
  const active=Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE json_extract(data,'$.state') IN ('queued','pending','running')").get()!.n);
  if(apply&&active)throw new Error('memory_workers_not_idle');
  const targets=db.prepare("SELECT id,dedupe_key,data FROM memory_jobs WHERE json_extract(data,'$.state') IN ('failed','obsolete') AND COALESCE(json_extract(data,'$.error'),'')<>'user_discarded' AND json_extract(data,'$.createdAt')<? ORDER BY id").all(new Date(before).toISOString());
  const ids=new Set(targets.map(row=>row.id as string)),tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows:Record<string,Record<string,unknown>[]>={memory_jobs:targets},intermediateRows:Record<string,number>={};
  for(const table of intermediateTables)if(tables.some(row=>row.name===table)){
   rows[table]=db.prepare(`SELECT * FROM ${identifier(table)} ORDER BY job_id`).all().filter(row=>ids.has(row.job_id as string));intermediateRows[table]=rows[table].length;
  }
  let backupPath:string|null=null;
  if(!apply||!targets.length){db.exec('COMMIT');return {selected:targets.length,retired:0,intermediateRows,backupPath,protectedTablesUnchanged:true};}
  const protectedDigest=()=>{
   const hash=createHash('sha256');
   for(const {name}of tables)if(name!=='memory_jobs'&&!intermediateTables.includes(name as string)){
    hash.update(name as string);
    for(const row of db.prepare(`SELECT * FROM ${identifier(name as string)} ORDER BY rowid`).iterate())hash.update(JSON.stringify(row));
   }
   return hash.digest('hex');
  };
  const protectedBefore=protectedDigest();
  const directory=join(home,'maintenance-backups',`memory-retirement-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}`);
  mkdirSync(directory,{recursive:true,mode:0o700});backupPath=join(directory,'rows.json');
  writeFileSync(backupPath,JSON.stringify({formatVersion:1,createdAt:new Date().toISOString(),home,before,protectedBefore,schemas:tables.filter(row=>Object.hasOwn(rows,row.name as string)),rows},null,2),{mode:0o600,flag:'wx'});
  for(const path of [backupPath,directory,dirname(directory),home]){const file=openSync(path,'r');try{fsyncSync(file);}finally{closeSync(file);}}
  for(const row of targets){
   const marker=JSON.parse(row.data as string) as MemoryJob;
   for(const key of ['outputInputs','extraction','errorDetail','completionWatermarks','manualPriority','personaRequested','failureCount','outputFailures','profileFailures','completedAt'] as const)delete marker[key];
   Object.assign(marker,{state:'obsolete',error:'user_discarded',attempt:0,leaseToken:marker.leaseToken+1,leaseUntil:null,workerId:null});
   if(db.prepare('UPDATE memory_jobs SET data=? WHERE id=? AND data=?').run(JSON.stringify(marker),row.id,row.data).changes!==1)throw new Error('retirement_conflict');
   for(const table of Object.keys(intermediateRows))db.prepare(`DELETE FROM ${identifier(table)} WHERE job_id=?`).run(row.id);
  }
  if(protectedDigest()!==protectedBefore)throw new Error('protected_memory_data_changed');
  db.exec('COMMIT');
  return {selected:targets.length,retired:targets.length,intermediateRows,backupPath,protectedTablesUnchanged:true};
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),value=(key:string)=>{const index=args.indexOf(key);return index<0?undefined:args[index+1];},home=value('--home'),before=value('--before');
 if(!home||!before)throw new Error('Usage: retire-memory-jobs --home PATH --before ISO_DATE [--apply]');
 console.log(JSON.stringify(retireMemoryJobs({home,before,apply:args.includes('--apply')}),null,2));
}
