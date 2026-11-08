import type { MemoryJob,MemoryRevision,MemorySource } from '../shared/memory';
import type { MemoryStore } from './memory-store';
// These versions share extraction/review rules; future rule changes must invalidate this key.
const rules=(version:string)=>/^(request|session)-v2$/.test(version)?'text-v1/exact-support-v2':null;
export function createMemoryL1Reuse(memory:MemoryStore){
 const db=memory.store.database;
 db.exec('CREATE TABLE IF NOT EXISTS memory_l1_reuse(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 type Entry={jobId:string;collectionId:string;generation:number;rules:string;principal:string;sources:{id:string;revision:number;fingerprint:string}[];facts:{recordId:string;revision:number}[]};
 const principal=(job:MemoryJob)=>JSON.stringify(Object.fromEntries(Object.entries(job.principal).sort(([a],[b])=>a.localeCompare(b))));
 return {
  save(job:MemoryJob,sources:MemorySource[]){
   const version=rules(job.extractorVersion);if(!version)return;
   const facts=memory.collections(job.principal).flatMap(scope=>memory.list({...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}},{projectId:scope.projectId,collectionId:scope.id})).filter(r=>(r.status==='active'||r.status==='expired'||r.status==='proposed')&&r.layer==='L1'&&r.verification==='evidence_extract'&&r.evidence.some(e=>sources.some(s=>s.id===e.sourceId&&s.revision===e.sourceRevision)));
   const entry:Entry={jobId:job.id,collectionId:job.collectionId,generation:job.generation,rules:version,principal:principal(job),sources:sources.map(({id,revision,fingerprint})=>({id,revision,fingerprint})),facts:facts.map(({recordId,revision})=>({recordId,revision}))};
   db.prepare('INSERT OR REPLACE INTO memory_l1_reuse VALUES(?,?)').run(job.id,JSON.stringify(entry));
  },
  find(job:MemoryJob,sources:MemorySource[]):{sources:MemorySource[];facts:MemoryRevision[]}{
   const projectId=memory.collection(job.principal,job.collectionId).projectId;
   const version=rules(job.extractorVersion),reused=new Set<string>(),facts=new Map<string,MemoryRevision>();if(!version)return {sources:[],facts:[]};
   for(const row of db.prepare('SELECT data FROM memory_l1_reuse ORDER BY rowid DESC').all()){
    const entry=JSON.parse(row.data as string) as Entry,current=db.prepare('SELECT data FROM memory_jobs WHERE id=?').get(entry.jobId);
    if(!current||JSON.parse(current.data as string).state!=='completed'||JSON.parse(current.data as string).error||entry.collectionId!==job.collectionId||entry.generation!==job.generation||entry.rules!==version||entry.principal!==principal(job))continue;
    const matches=sources.filter(s=>entry.sources.some(old=>old.id===s.id&&old.revision===s.revision&&old.fingerprint===s.fingerprint));if(!matches.length)continue;
    try{
     const records=entry.facts.map(ref=>{const r=memory.read(job.principal,ref.recordId,projectId);if(r.layer!=='L1'||r.verification!=='evidence_extract'||r.status!=='active'||!memory.compatibleRevision(ref,r)||r.validUntil&&Date.parse(r.validUntil)<=Date.now())throw new Error('invalid_reuse');memory.validateReferences(job.principal,{projectId:memory.collection(job.principal,r.collectionId).projectId,items:[ref]});for(const evidence of r.evidence)memory.validateSource(job.principal,evidence,true,projectId);return r;});
     for(const source of matches){memory.validateSource(job.principal,{sourceId:source.id,sourceRevision:source.revision},true,projectId);reused.add(source.id);}
     for(const r of records.filter(r=>r.evidence.some(e=>matches.some(s=>s.id===e.sourceId&&s.revision===e.sourceRevision))))facts.set(r.recordId,r);
    }catch{/* Invalid authority, revision, or lifetime requires ordinary extraction. */}
   }
   return {sources:sources.filter(s=>reused.has(s.id)),facts:[...facts.values()]};
  }
 };
}
