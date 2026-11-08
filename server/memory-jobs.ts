import type { Store } from './store';
import type { Principal } from '../shared/workspace-contracts';
import type { MemoryJob } from '../shared/memory';
import { lastConversationContentEventId, memoryFail, type MemoryStore } from './memory-store';
import { correctableOutput, failureCount, isGenerationPaused, isObsoleteMemoryError, needsCorrection } from '../shared/memory-job-policy';
export function createMemoryJobs(store:Store,memory:MemoryStore) {
 const db=store.database;
 // Index only active jobs, in the same manual-priority and availability order used by claim.
 db.exec("CREATE INDEX IF NOT EXISTS memory_jobs_claimable ON memory_jobs(COALESCE(json_extract(data,'$.manualPriority'),0) DESC,json_extract(data,'$.availableAt')) WHERE json_extract(data,'$.state') IN ('queued','pending','running')");
 const atomic=<T>(fn:()=>T):T=>db.isTransaction?fn():store.transaction(fn);
 const load=(id:string):MemoryJob=>{const row=db.prepare('SELECT data FROM memory_jobs WHERE id=?').get(id);if(!row)memoryFail('memory_job_not_found',404);return JSON.parse(row!.data as string);};
 const write=(job:MemoryJob)=>db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id);
 const validateInputs=(job:MemoryJob):void=>memory.withAuthorityQuery(()=>{
  if(memory.collection(job.principal,job.collectionId).generation!==job.generation)memoryFail('generation_changed');
  for(const mark of (!job.stage||job.stage==='extract'||job.stage==='conflict')?job.completionWatermarks??[]:[]){const chat=store.getConversation(mark.conversationId);if(chat?.completedAt!==mark.completedAt||lastConversationContentEventId(store,mark.conversationId)!==mark.lastEventId)memoryFail('source_changed');}
  for(const ref of job.sourceRefs){const projectId=job.profileScope?memory.collection({userId:job.principal.userId},memory.source({userId:job.principal.userId},ref.sourceId).collectionId).projectId:memory.collection(job.principal,job.collectionId).projectId;memory.validateSource(job.principal,ref,true,projectId);}
 });
 const validateLease=(job:MemoryJob,now=new Date().toISOString()):void=>{
  const current=load(job.id);if(current.state!=='running'||current.leaseToken!==job.leaseToken||!current.leaseUntil||Date.parse(current.leaseUntil)<=Date.parse(now))memoryFail('stale_lease');
  validateInputs(job);
 };
 const validateShadow=(job:MemoryJob):void=>{
  const current=load(job.id);if(current.state!=='completed'||current.leaseToken!==job.leaseToken)memoryFail('stale_shadow');
  validateInputs(job);
 };
 const finishShadow=(job:MemoryJob,warning:string|null):void=>store.transaction(()=>{
  const current=load(job.id);if(current.state!=='completed'||current.leaseToken!==job.leaseToken)memoryFail('stale_shadow');
  current.error=warning;write(current);
 });
 const claim=(workerId:string,now=new Date().toISOString(),kinds?:('request'|'session')[]):MemoryJob|null=>store.transaction(()=>{
  if(!workerId||!Number.isFinite(Date.parse(now)))memoryFail('invalid_job_claim',422);
  for(const row of db.prepare("SELECT data FROM memory_jobs WHERE json_extract(data,'$.state') IN ('queued','pending','running') ORDER BY COALESCE(json_extract(data,'$.manualPriority'),0) DESC,json_extract(data,'$.availableAt'),rowid").all()){
   const job=JSON.parse(row.data as string) as MemoryJob;
   if(kinds&&!kinds.includes(job.kind??'request'))continue;
   if(job.state==='queued'&&isObsoleteMemoryError(job.error)){job.state='obsolete';job.leaseUntil=null;job.workerId=null;write(job);continue;}
   if(job.state==='queued'&&needsCorrection(job)){job.state='failed';job.leaseUntil=null;write(job);continue;}
   if(!(job.state==='queued'&&Date.parse(job.availableAt)<=Date.parse(now)||job.state==='pending'&&job.kind&&job.error==='needs_chunking'&&Date.parse(job.availableAt)<=Date.parse(now)||job.state==='running'&&job.leaseUntil&&Date.parse(job.leaseUntil)<=Date.parse(now)))continue;
   try{validateInputs(job);}catch(error){job.state='obsolete';job.error=error instanceof Error?error.message:'source_unavailable';job.leaseUntil=null;job.workerId=null;write(job);continue;}
   if(job.state==='running'){job.failureCount=failureCount(job)+1;job.error='generation_interrupted';if(needsCorrection(job)){job.state='failed';job.leaseUntil=null;write(job);continue;}}
   job.failureCount=failureCount(job);
   if(job.state==='pending'&&job.error==='needs_chunking')job.error=null;
   job.state='running';job.attempt++;job.leaseToken++;job.workerId=workerId;job.leaseUntil=new Date(Date.parse(now)+600000).toISOString();write(job);return job;
  }return null;
 });
 const fail=(id:string,token:number,error:string,now=new Date().toISOString(),detail:string|null=null):void=>store.transaction(()=>{const job=load(id);if(job.state!=='running'||job.leaseToken!==token)return;const paused=isGenerationPaused(error);job.failureCount=failureCount(job)+(paused?0:1);job.error=error;job.errorDetail=detail;if(correctableOutput(job))job.outputFailures=(job.outputFailures??0)+1;job.leaseUntil=null;job.state=isObsoleteMemoryError(error)?'obsolete':needsCorrection(job)?'failed':'queued';if(job.state==='obsolete')job.workerId=null;const delay=/quota|rate.?limit|429/i.test(error)?15*60000:([1000,5000,30000][job.attempt-1]??30000);job.availableAt=new Date(Date.parse(now)+delay).toISOString();write(job);});
 const complete=(id:string,token:number,now=new Date().toISOString(),warning:string|null=null)=>{const job=load(id);if(job.leaseToken!==token)memoryFail('stale_lease');validateLease(job,now);job.state='completed';job.completedAt=now;job.leaseUntil=null;job.error=warning;write(job);};
 const advance=(job:MemoryJob,stage:NonNullable<MemoryJob['stage']>,now=new Date().toISOString(),extraction?:MemoryJob['extraction']):void=>atomic(()=>{validateLease(job,now);const current=load(job.id);if((current.stage??'extract')!==stage){current.outputFailures=0;delete current.outputInputs;}current.stage=stage;current.state='queued';current.attempt=0;current.leaseUntil=null;current.availableAt=now;current.error=null;current.errorDetail=null;if(extraction)current.extraction=extraction;write(current);});
 const list=(p:Principal,input:{collectionId?:string;states?:MemoryJob['state'][]}={}):MemoryJob[]=>memory.withAuthorityQuery(()=>{
  memory.principal(p);const filters:string[]=[],values:string[]=[];
  if(input.collectionId){filters.push("json_extract(data,'$.collectionId')=?");values.push(input.collectionId);}
  if(input.states){filters.push("json_extract(data,'$.state') IN ("+input.states.map(()=>'?').join(',')+")");values.push(...input.states);}
  return db.prepare('SELECT data FROM memory_jobs'+(filters.length?' WHERE '+filters.join(' AND '):'')+' ORDER BY rowid').all(...values).map(r=>JSON.parse(r.data as string) as MemoryJob).filter(job=>{
   try{memory.collection(p,job.collectionId);if(!p.agentId&&!p.runId&&job.state==='obsolete')return true;for(const ref of job.sourceRefs){const projectId=job.profileScope?memory.collection({userId:p.userId},memory.source({userId:p.userId},ref.sourceId).collectionId).projectId:memory.collection(p,job.collectionId).projectId;memory.validateSource(p,ref,false,projectId);}return true;}catch{return false;}
  });
 });
 return {claim,validateLease,validateShadow,finishShadow,complete,fail,advance,list};
}
export type MemoryJobs=ReturnType<typeof createMemoryJobs>;
