import {randomUUID} from 'node:crypto';
import {memoryHash,type createMemoryStore} from '../server/memory-store';
import type {Principal} from '../shared/workspace-contracts';
import type {MemoryRevision} from '../shared/memory';

// Persist the shape produced by older releases; no current write API adopts candidates.
export function historicalConfirmation(memory:ReturnType<typeof createMemoryStore>,principal:Principal,input:{recordId:string;expectedRevision:number},verification:'user_confirmation'|'user_correction'='user_confirmation',text?:string):MemoryRevision {
 const old=memory.read(principal,input.recordId),c=memory.collection(principal,old.collectionId),now=new Date().toISOString();
 const next:MemoryRevision={...old,revision:old.revision+1,revisionKind:verification==='user_confirmation'?'confirmation':'correction',status:'active',verification,text:text??old.text,contentHash:memoryHash(text??old.text),effectiveFrom:now,extractedAt:now,...old.legacyLevel==='L3'?{pipelines:['request','session']}:{}};
 memory.store.transaction(()=>{
  const db=memory.store.database;
  db.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify(next),old.recordId);
  db.prepare('INSERT INTO memory_revisions VALUES(?,?,?)').run(next.recordId,next.revision,JSON.stringify(next));
  db.prepare("UPDATE memory_record_scope SET status='active' WHERE record_id=?").run(next.recordId);
  db.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify({...c,generation:c.generation+1}),c.id);
  if(old.legacyLevel==='L3'){
   const job={id:randomUUID(),collectionId:c.id,principal,sourceRefs:[],generation:c.generation+1,state:'queued',attempt:0,leaseToken:0,leaseUntil:null,workerId:null,availableAt:now,createdAt:now,error:null,extractorVersion:'confirmed-legacy-v1',kind:'request',stage:'scene',personaRequested:true,manualPriority:true};
   db.prepare('INSERT OR IGNORE INTO memory_jobs VALUES(?,?,?)').run(job.id,memoryHash(JSON.stringify([c.id,c.generation+1,'confirmed-legacy-context'])),JSON.stringify(job));
  }
 });
 return next;
}
