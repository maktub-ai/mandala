import { randomUUID } from 'node:crypto';
import {DomainError} from '../shared/workspace-contracts';
import type { Principal } from '../shared/workspace-contracts';
import type { MemoryHit, RecallInput, RecallResult } from '../shared/memory';
import { memoryFail, unicodeLength, type MemoryStore } from './memory-store';
import {parseSceneBlock} from './vendor/tencentdb/scene-format';
import { rankMemoryCandidates, type MemoryCandidate } from './memory-search';
import {summarizeMemoryHit} from './memory-presentation';
import {createMemoryVectors,semanticHash,LOCAL_MIN_RELEVANCE,type MemoryVectorOptions} from './memory-vectors';
import type {MemoryRevision} from '../shared/memory';
export type MemoryCandidateInput={records:MemoryRevision[];query:string;limit:number;signal?:AbortSignal;revalidate?:()=>Promise<void>};
export type MemoryCandidateResult={candidates:MemoryCandidate[];indexLag:number;degraded:boolean};
export function createMemoryRecall(memory:MemoryStore,options:MemoryVectorOptions={},readKinds?:()=>('request'|'session')[],indexKinds?:()=>('request'|'session')[]) {
 const db=memory.store.database;db.exec('CREATE TABLE IF NOT EXISTS memory_scene_hits(collection_id TEXT NOT NULL,semantic_key TEXT NOT NULL,hits INTEGER NOT NULL,PRIMARY KEY(collection_id,semantic_key))');
 const vectors=createMemoryVectors(db,options),operations=new Set<Promise<unknown>>();let closed=false;
 function tracked<T>(operation:()=>Promise<T>):Promise<T>{if(closed)return Promise.reject(new Error('memory_recall_closed'));const work=operation();operations.add(work);void work.then(()=>operations.delete(work),()=>operations.delete(work));return work;}
 const readable=(input:RecallInput,r:MemoryRevision,generation=false)=>!input.kinds||!(generation?indexKinds:readKinds)||(generation?indexKinds!:readKinds!)().some(kind=>input.kinds!.includes(kind)&&(r.pipelines??['request']).includes(kind));
 // Owner browsing remains broad; execution context must also pass the final recipient scope check.
 const injectable=(p:Principal,input:RecallInput,r:MemoryRevision):boolean=>{
  try{memory.validateReferences(p,{projectId:input.projectId,items:[{recordId:r.recordId,revision:r.revision}]});return true;}
  catch(error){if(error instanceof DomainError)return false;throw error;}
 };
 const pool=(p:Principal,input:RecallInput,generation=false,context=false)=>memory.withAuthorityQuery(()=>{memory.principal(p);return memory.list(p,{projectId:input.projectId,taskId:input.taskId,conversationId:input.conversationId,status:'active'}).filter(r=>(r.layer!=='L3'||r.profileScope?.projectId===input.projectId&&r.profileScope?.agentId===(p.agentId??null)&&r.recordId===memory.profileId(r.profileScope))&&readable(input,r,generation)&&(!input.layers||input.layers.includes(r.layer))&&(!input.kinds||input.kinds.some(kind=>(r.pipelines??['request']).includes(kind)))&&(!r.validUntil||Date.parse(r.validUntil)>Date.now())&&(!context||injectable(p,input,r)));});
 const current=(p:Principal,input:RecallInput,r:MemoryRevision,generation=false,context=false):MemoryRevision|undefined=>{
  if(options.signal?.aborted||!readable(input,r,generation))return;
  try{return memory.withAuthorityQuery(()=>{const value=memory.read(p,r.recordId,input.projectId);return value.status==='active'&&semanticHash(value)===semanticHash(r)&&(!value.validUntil||Date.parse(value.validUntil)>Date.now())&&(!context||injectable(p,input,value))?value:undefined;});}catch(error){if(!(error instanceof DomainError))throw error;}
 };
 const finish=(p:Principal,input:RecallInput,candidates:MemoryCandidate[],budget:number,indexLag=0,degraded=false,context=false):RecallResult=>{
  const items:MemoryHit[]=[];let length=context?2:0;
  for(const candidate of candidates){
   if(items.length===8)break;
   const r=current(p,input,candidate.record,false,context);if(!r||r.revision!==candidate.record.revision)continue;
   const method=candidate.reason==='scope_summary'?'范围内有效摘要':candidate.reason==='exact'?'ID/路径精确匹配':candidate.reason==='semantic_anchor'?'本地语义首位保留；BM25＋本地向量 RRF融合':candidate.reason==='hybrid_rrf'?'BM25＋本地向量 RRF融合':candidate.reason==='vector'?'本地语义向量匹配':'BM25匹配';
   const hit={...r,reason:method+(degraded?'（语义索引降级）':'')+'；历史来源，不代表当前状态'};
   const size=context?unicodeLength(JSON.stringify(summarizeMemoryHit(hit,input.query)))+(items.length?1:0):unicodeLength(r.text);
   if(length+size>budget)continue;length+=size;items.push(hit);
  }
  for(const item of items.filter(r=>r.layer==='L2'&&r.semanticKey?.startsWith('scene.')))db.prepare('INSERT INTO memory_scene_hits VALUES(?,?,?) ON CONFLICT(collection_id,semantic_key) DO UPDATE SET hits=hits+1').run(item.collectionId,item.semanticKey!,parseSceneBlock(item.text,item.recordId).meta.heat+1);
  return {items,indexLag,degraded};
 };
 const search=(p:Principal,input:RecallInput,budget=6000,context=false):RecallResult=>{
  const records=pool(p,input,false,context),candidates=input.query.trim()?rankMemoryCandidates(records,input.query,{limit:100}):records.sort((a,b)=>b.extractedAt.localeCompare(a.extractedAt)).map(record=>({record,score:0,reason:'scope_summary'}));
  return finish(p,input,candidates,budget,0,false,context);
 };
 async function hybridSearch(p:Principal,input:RecallInput,context=false,loadQuery?:(records:MemoryRevision[])=>Promise<number[]|undefined>):Promise<RecallResult>{
  const records=pool(p,input,false,context);if(!input.query.trim()||!records.length)return search(p,input,6000,context);
  let queryVector:number[]|undefined,failed=false;
  try {
   if(loadQuery)queryVector=await loadQuery(records);
   else {await vectors.refresh(records,r=>current(p,input,r,false,context));queryVector=await vectors.query(input.query);}
  }catch{failed=true;}
  // Re-enumerate all authorities after every awaited local request before retrieval.
  const active=pool(p,input,false,context),indexLag=vectors.lag(active);let candidates:MemoryCandidate[];
  try{candidates=rankMemoryCandidates(active,input.query,{limit:100,...queryVector&&!failed?{queryVector,vectors:vectors.vectors(active),minVectorScore:LOCAL_MIN_RELEVANCE}:{}});}catch{failed=true;candidates=rankMemoryCandidates(active,input.query,{limit:100});}
  return finish(p,input,candidates,6000,indexLag,failed||indexLag>0,context);
 }
 // Automatic recall shares one query vector and leaves document indexing to the background worker.
 async function turnContextSearch(p:Principal,input:RecallInput,turnSignal:AbortSignal) {
  const signal=options.signal?AbortSignal.any([options.signal,turnSignal]):turnSignal;
  let prepared:Promise<string>|undefined, query:Promise<number[]>|undefined;
  const loadQuery=async(records:MemoryRevision[])=>{
   signal.throwIfAborted();
   let cancel!:()=>void;
   const cancelled=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});});
   try {
    return await Promise.race([(async()=>{
     await (prepared??=vectors.prepare(undefined,signal));
     signal.throwIfAborted();
     if(vectors.lag(records)===records.length)return undefined;
     return query??=vectors.query(input.query,undefined,signal);
    })(),cancelled]);
   }finally{signal.removeEventListener('abort',cancel);}
  };
  return Promise.all([
   hybridSearch(p,{...input,layers:['L1']},true,loadQuery),
   input.kinds?.includes('request')?hybridSearch(p,{...input,layers:['L2'],kinds:['request']},true,loadQuery):undefined,
  ]);
 }
 // Generation supplies its own authority-bounded pool; automatic read flags and recall output caps do not apply.
 async function rankCandidates(p:Principal,input:MemoryCandidateInput):Promise<MemoryCandidateResult>{
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),...(input.signal?[input.signal]:[])]);
  const check=async()=>{
   if(signal.aborted)throw new Error('memory_generation_cancelled');
   await input.revalidate?.();
   if(signal.aborted)throw new Error('memory_generation_cancelled');
   memory.withAuthorityQuery(()=>{for(const record of input.records){
    const scope=memory.collection({userId:p.userId},record.collectionId),reader={...p,...!p.agentId&&scope.agentId?{agentId:scope.agentId}:{}};
    const value=memory.read(reader,record.recordId,scope.projectId);
    if(value.status!=='active'||value.revision!==record.revision||semanticHash(value)!==semanticHash(record)||JSON.stringify(value.evidence)!==JSON.stringify(record.evidence)||JSON.stringify(value.dependencies)!==JSON.stringify(record.dependencies))memoryFail('memory_candidate_changed');
   }});
  };
  let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('memory_generation_cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{return await Promise.race([(async()=>{
   await check();let queryVector:number[]|undefined,failed=false;
   let expired=false,providerTimer:ReturnType<typeof setTimeout>|undefined;
   const providerCheck=async()=>{if(expired)throw new Error('local_embedding_timed_out');await check();};
   const deadline=new Promise<never>((_resolve,reject)=>{providerTimer=setTimeout(()=>{expired=true;reject(new Error('local_embedding_timed_out'));},15000);});
   try{queryVector=await Promise.race([(async()=>{await vectors.prepare(providerCheck);await providerCheck();return vectors.lag(input.records)===0&&input.records.length&&input.query.trim()?await vectors.query(input.query,providerCheck):undefined;})(),deadline]);}catch{await check();failed=true;}finally{if(providerTimer)clearTimeout(providerTimer);}

   await check();const indexLag=vectors.lag(input.records);let candidates:MemoryCandidate[];
   try{candidates=rankMemoryCandidates(input.records,input.query,{limit:input.limit,...queryVector&&!failed&&indexLag===0?{queryVector,vectors:vectors.vectors(input.records)}:{}});}catch{failed=true;candidates=rankMemoryCandidates(input.records,input.query,{limit:input.limit});}
   return {candidates,indexLag,degraded:failed||indexLag>0};
  })(),cancelled]);}finally{signal.removeEventListener('abort',abort);}
 }
 async function refreshVectors(p:Principal,input:Omit<RecallInput,'query'>,generation=false):Promise<{indexLag:number;degraded:boolean}>{
  const request={...input,query:''},records=pool(p,request,generation);try{await vectors.refresh(records,r=>current(p,request,r,generation));return {indexLag:vectors.lag(pool(p,request,generation)),degraded:false};}catch{return {indexLag:vectors.lag(pool(p,request,generation)),degraded:true};}
 }
 return {search:(p:Principal,input:RecallInput)=>search(p,input),hybridSearch:(p:Principal,input:RecallInput)=>tracked(()=>hybridSearch(p,input)),contextSearch:(p:Principal,input:RecallInput)=>tracked(()=>hybridSearch(p,input,true)),turnContextSearch:(p:Principal,input:RecallInput,signal:AbortSignal)=>tracked(()=>turnContextSearch(p,input,signal)),refreshGenerationVectors:(p:Principal,input:Omit<RecallInput,'query'>)=>tracked(()=>refreshVectors(p,input,true)),rankCandidates:(p:Principal,input:MemoryCandidateInput)=>tracked(()=>rankCandidates(p,input)),refreshVectors:(p:Principal,input:Omit<RecallInput,'query'>)=>tracked(()=>refreshVectors(p,input)),async close(){closed=true;await Promise.allSettled([...operations]);},summary:(p:Principal,input:{projectId:string|null;query?:string;kinds?:('request'|'session')[]})=>search(p,{...input,query:input.query??'',layers:['L2','L3'],kinds:input.kinds??['session']},2000),
  recordUse(p:Principal,input:{runId:string;query:string;items:{recordId:string;revision:number}[]}):string {
   memory.principal(p);const run=memory.options.tasks.getRun(p,input.runId),execution=memory.options.tasks.getExecution(p,run.executionId);if(p.runId&&p.runId!==run.id)memoryFail('forbidden',403);
   const reader={...p,agentId:execution.agentId,runId:run.id};
   memory.validateReferences(reader,{projectId:execution.projectId,items:input.items});
   const id=randomUUID();memory.store.database.prepare('INSERT INTO memory_uses VALUES (?,?,?)').run(id,run.id,JSON.stringify({query:input.query,items:input.items,actualUse:'provided_to_native',causality:'not_established',createdAt:new Date().toISOString()}));return id;
  },
  rebuildIndex():void {memory.store.transaction(()=>{const db=memory.store.database;db.exec('DELETE FROM memory_index');for(const row of db.prepare('SELECT data FROM memory_records').all()){const r=JSON.parse(row.data as string);db.prepare('INSERT INTO memory_index VALUES (?,?,?)').run(r.recordId,r.revision,r.text);}});}
 };
}
