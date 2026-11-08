import {randomUUID} from 'node:crypto';
import type {CaptureResult,MemoryJob} from '../shared/memory';
import type {MemoryStore} from './memory-store';
import type {MemoryJobs} from './memory-jobs';
import {scheduleConversation,l1Completed,l2Completed,l2Due,type MemoryScheduleState} from './memory-schedule';
type State=MemoryScheduleState&{seenSources?:string[]};
/** Durable version of upstream per-session L1 buffering and per-scope L2 timers. */
export function createMemoryScheduler(memory:MemoryStore,jobs:MemoryJobs){
 const db=memory.store.database;
 db.exec('CREATE TABLE IF NOT EXISTS memory_schedule(key TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS memory_scheduled_jobs(job_id TEXT PRIMARY KEY,due_at TEXT NOT NULL)');
 const get=(key:string):State=>{const row=db.prepare('SELECT data FROM memory_schedule WHERE key=?').get(key);return row?JSON.parse(row.data as string):{};};
 const put=(key:string,state:State)=>db.prepare('INSERT INTO memory_schedule VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(state));
 const sessionKey=(job:MemoryJob)=>`session:${job.collectionId}:${job.generation}:${job.conversationId||'tasks'}`;
 const scopeKey=(job:MemoryJob)=>`scope:${job.collectionId}:${job.generation}`;
 const write=(job:MemoryJob)=>db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id);
 return {
  capture(result:CaptureResult,nowMS=Date.now()):CaptureResult{
   memory.store.transaction(()=>{for(const job of result.jobs){
    if(job.kind!=='request'||job.stage!=='extract'||!['queued','pending'].includes(job.state)||job.attempt)continue;
    const marked=db.prepare('SELECT due_at FROM memory_scheduled_jobs WHERE job_id=?').get(job.id);
    if(marked){job.availableAt=marked.due_at as string;write(job);continue;}
    const key=sessionKey(job);let state=get(key),flush=false;const seen=new Set(state.seenSources??[]);
    for(const ref of job.sourceRefs){const id=`${ref.sourceId}@${ref.sourceRevision}`;if(seen.has(id))continue;seen.add(id);const next=scheduleConversation(state,nowMS);state=next.state;flush ||= next.flush;}
    state.seenSources=[...seen];put(key,state);
    const scope=get(scopeKey(job));put(scopeKey(job),{...scope,lastActiveAt:nowMS});
    job.state='queued';job.error=null;job.availableAt=new Date(flush?nowMS:state.l1DueAt??nowMS+600_000).toISOString();write(job);
    db.prepare('INSERT INTO memory_scheduled_jobs VALUES(?,?)').run(job.id,job.availableAt);
    // A new request resets the idle deadline for all buffered requests of this session.
    for(const row of db.prepare('SELECT data FROM memory_jobs').all()){
     const prior=JSON.parse(row.data as string) as MemoryJob;
     if(prior.id===job.id||prior.kind!=='request'||prior.stage!=='extract'||prior.state!=='queued'||prior.attempt||sessionKey(prior)!==key)continue;
     job.personaRequested ||= prior.personaRequested;
     job.sourceRefs=[...new Map([...prior.sourceRefs,...job.sourceRefs].map(ref=>[`${ref.sourceId}@${ref.sourceRevision}`,ref])).values()];
     prior.state='obsolete';prior.error='coalesced';write(prior);
    }
    write(job);
   }});return result;
  },
  afterL1(job:MemoryJob,nowMS=Date.now()):string{
   const session=get(sessionKey(job)),scope=get(scopeKey(job));
   put(sessionKey(job),l1Completed(session,nowMS));
   const next=l1Completed({...scope,conversationCount:undefined,warmupThreshold:undefined},nowMS);put(scopeKey(job),next);
   const due=new Date(next.l2DueAt!).toISOString();
   for(const row of db.prepare('SELECT data FROM memory_jobs').all()){
    const other=JSON.parse(row.data as string) as MemoryJob;if(other.kind==='request'&&other.collectionId===job.collectionId&&other.generation===job.generation&&other.stage==='scene'&&other.state==='queued'&&Date.parse(other.availableAt)>next.l2DueAt!){other.availableAt=due;write(other);}
   }
   return due;
  },
  afterScene(job:MemoryJob,nowMS=Date.now()){put(scopeKey(job),l2Completed(get(scopeKey(job)),nowMS));},
  scan(nowMS=Date.now()){
   memory.store.transaction(()=>memory.withAuthorityQuery(()=>{
    for(const collection of memory.collections({userId:memory.options.localUserId})){
     if(jobs.list({userId:memory.options.localUserId},{collectionId:collection.id,states:['queued','running']}).some(job=>job.kind==='request'&&job.generation===collection.generation&&job.stage==='scene'))continue;
     const stale=memory.staleScenes({userId:memory.options.localUserId},collection.projectId,collection.id);if(!stale.length)continue;
     const dedupe=`rebuild:${collection.id}:${collection.generation}:${stale.map(r=>r.recordId+'@'+r.revision).join(',')}`;if(db.prepare('SELECT id FROM memory_jobs WHERE dedupe_key=?').get(dedupe))continue;
     const job:MemoryJob={id:randomUUID(),collectionId:collection.id,principal:{userId:memory.options.localUserId,...collection.agentId?{agentId:collection.agentId}:{}},sourceRefs:[],generation:collection.generation,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:new Date(nowMS).toISOString(),createdAt:new Date(nowMS).toISOString(),error:null,extractorVersion:'request-v3',kind:'request',stage:'scene'};db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,dedupe,JSON.stringify(job));
    }
    for(const row of db.prepare("SELECT key,data FROM memory_schedule WHERE key LIKE 'scope:%'").all()){
    const key=row.key as string,state=JSON.parse(row.data as string) as State;if(state.l2DueAt===undefined||nowMS<state.l2DueAt)continue;
    if(!l2Due(state,nowMS)){put(key,{...state,l2DueAt:undefined,l2Source:undefined});continue;}
    const [,collectionId,generation]=key.split(':');let collection;try{collection=memory.collection({userId:memory.options.localUserId},collectionId);}catch{continue;}if(collection.generation!==Number(generation))continue;
    if(jobs.list({userId:memory.options.localUserId},{collectionId,states:['queued','running']}).some(job=>job.kind==='request'&&job.generation===collection.generation&&job.stage==='scene'))continue;
    const due=new Date(state.l2DueAt).toISOString(),dedupe=`scope-timer:${key}:${due}`;
    if(db.prepare('SELECT id FROM memory_jobs WHERE dedupe_key=?').get(dedupe))continue;
    const job:MemoryJob={id:randomUUID(),collectionId,principal:{userId:memory.options.localUserId},sourceRefs:[],generation:collection.generation,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:new Date(nowMS).toISOString(),createdAt:new Date(nowMS).toISOString(),error:null,extractorVersion:'request-v3',kind:'request',stage:'scene'};
    db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,dedupe,JSON.stringify(job));
   }}));
  },
 };
}
