import {randomUUID} from 'node:crypto';
import type {MemoryJob,MemoryProfileScope,MemoryRevision} from '../shared/memory';
import type {Principal} from '../shared/workspace-contracts';
import {memoryHash,type MemoryStore} from './memory-store';
import {createMemoryScenes} from './memory-scenes';

/** Profile addressing and scheduling share the exact project + agent pair. */
export function createMemoryProfiles(memory:MemoryStore){
 const root={userId:memory.options.localUserId},db=memory.store.database,scenes=createMemoryScenes(memory);
 const atomic=<T>(fn:()=>T):T=>db.isTransaction?fn():memory.store.transaction(fn);
 const reader=(scope:MemoryProfileScope):Principal=>({...root,...scope.agentId?{agentId:scope.agentId}:{}});
 const records=(scope:MemoryProfileScope)=>memory.list(reader(scope),{projectId:scope.projectId,status:'active'}).filter(r=>memory.collection(root,r.collectionId).projectId===scope.projectId&&(r.layer!=='L3'||r.profileScope?.projectId===scope.projectId&&r.profileScope?.agentId===scope.agentId));
 const should=(scope:MemoryProfileScope,input:MemoryRevision[],explicit=false)=>{const old=db.prepare('SELECT data FROM memory_records WHERE id=?').get(memory.profileId(scope));if(old&&JSON.parse(old.data as string).status==='retracted')return false;return [...new Set(input.filter(r=>r.layer==='L2'&&r.semanticKey?.startsWith('scene.')).map(r=>r.collectionId))].some(id=>scenes.profileTrigger(id,input,explicit,scope).should);};
 const queue=(scope:MemoryProfileScope,input=records(scope),now=new Date().toISOString()):MemoryJob|null=>{const c=memory.ensureCollection(root,scope);return atomic(()=>{
  const eligible=input.filter(r=>r.layer==='L2'&&r.status==='active'&&r.semanticKey?.startsWith('scene.'));if(!eligible.length)return null;
  // The store validates this pair even before its first profile exists.
  const current=memory.profile(reader(scope),scope,true);
  const refs=[...new Map(eligible.flatMap(r=>r.evidence).map(ref=>[JSON.stringify(ref),ref])).values()];
  const key=memoryHash(JSON.stringify(['profile-v1',scope,c.generation,eligible.map(r=>[r.recordId,r.revision]).sort(),current?.revision??0]));
  const previous=db.prepare('SELECT data FROM memory_jobs WHERE dedupe_key=?').get(key);if(previous)return JSON.parse(previous.data as string);
  const job:MemoryJob={id:randomUUID(),collectionId:c.id,principal:reader(scope),profileScope:scope,sourceRefs:refs,generation:c.generation,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:now,createdAt:now,error:null,extractorVersion:'profile-v1',kind:'request',stage:'profile'};
  db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,key,JSON.stringify(job));return job;
 });};
 const schedule=(scope:MemoryProfileScope,now=new Date().toISOString())=>{const input=records(scope);return should(scope,input)?queue(scope,input,now):null;};
 const committed=(scope:MemoryProfileScope,now:string)=>{const input=records(scope);for(const id of new Set(input.filter(r=>r.layer==='L2').map(r=>r.collectionId)))scenes.profileCommitted(id,input,now,scope);};
 return {records,should,queue,schedule,committed,current:memory.profile};
}
