import {createMemoryProfiles} from './memory-profiles';
import {MemoryReviewOutcome} from './memory-review-outcome';
import type { MemoryJob, MemoryProposal,MemoryProfileScope, MemoryRevision, MemorySource } from '../shared/memory';
import { memoryFail, memoryHash, memoryToolObservationScoped, type MemoryStore } from './memory-store';
import type { MemoryJobs } from './memory-jobs';
import { memoryExtractionBatches, memoryTextSource } from './memory-chunks';
import { createMemoryScenes } from './memory-scenes';
import { createMemoryL1Reuse } from './memory-l1-reuse';
import { rankMemoryCandidates } from './memory-search';
import {semanticHash} from './memory-vectors';
import type {MemoryCandidateResult} from './memory-recall';
import { DomainError } from '../shared/workspace-contracts';
export type MemoryStage='verify'|'extract'|'conflict'|'scene'|'profile'|'consolidate';
export type SessionMemorySummary={conversationId:string;text:string;evidence:MemoryProposal['evidence'];dependencies:{recordId:string;revision:number}[]};
export type MemoryBatchItem={id:string;atom?:MemoryProposal;draft?:MemoryProposal;records:MemoryRevision[]};
export type MemoryGeneratorInput={profileScope?:MemoryProfileScope;language?:'zh-CN'|'en';revalidate?:()=>void;reviewCandidateIds?:string[];reviewSummary?:boolean;batchItems?:MemoryBatchItem[];summaryOnly?:boolean;reusableFacts?:MemoryRevision[];reusableSourceRefs?:MemoryJob['sourceRefs'];job:MemoryJob;sources:MemorySource[];records:MemoryRevision[];stage:MemoryStage;callKind?:'initial'|'retry'|'repair';signal:AbortSignal;summaries?:SessionMemorySummary[];atoms?:MemoryProposal[];drafts?:MemoryProposal[];repairDrafts?:MemoryProposal[];draftIssues?:{index:number;reason:'unsupported_extract'|'tool_observation_scope_required'}[];draftSummary?:string;reviewStage?:Exclude<MemoryStage,'verify'>;verifiedDependencies?:{recordId:string;revision:number}[];retainedDependencies?:{recordId:string;revision:number}[];sceneContext?:{index:string;navigation:string;newFactRefs:{recordId:string;revision:number}[]};context?:{projectId:string|null;requests:string[];assistantReplies:string[]}};
export type MemoryGenerator=(input:MemoryGeneratorInput)=>Promise<MemoryProposal[]|{proposals:MemoryProposal[];summary?:string;requestPersonaUpdate?:boolean}>;
const normalizeOutput=(output:Awaited<ReturnType<MemoryGenerator>>)=>{
 if(output instanceof MemoryReviewOutcome)return output;
 const proposals=Array.isArray(output)?output:output?.proposals;if(!Array.isArray(proposals))return output;
 const normalized=proposals.map(p=>{
  if(!p||typeof p.text!=='string'||!p.text.trim()||!Array.isArray(p.evidence)||!Array.isArray(p.replaces)||p.replaces.some(ref=>!ref||typeof ref.recordId!=='string'||!Number.isSafeInteger(ref.revision))||p.evidence.some(ref=>!ref||typeof ref.sourceId!=='string'||!Number.isSafeInteger(ref.sourceRevision))||p.dependencies!==undefined&&!Array.isArray(p.dependencies)||p.support!==undefined&&!Array.isArray(p.support))memoryFail('invalid_proposal',422);
  if(!Array.isArray(p.support))return p;
  return {...p,support:p.support.map(ref=>{
  if(!ref||typeof ref.sourceId!=='string'||typeof ref.quote!=='string')memoryFail('invalid_proposal',422);
  const id:unknown=ref?.eventId;return typeof id==='string'&&/^(0|[1-9]\d*)$/.test(id)&&Number.isSafeInteger(Number(id))?{...ref,eventId:Number(id)}:ref;
 })};});
 return Array.isArray(output)?normalized:{...output,proposals:normalized};
};
const TIMEOUT_MS=180000;
export const verifiedIdentity=(draft:MemoryProposal,proposal:MemoryProposal)=>draft.collectionId===proposal.collectionId&&draft.semanticKey===proposal.semanticKey&&draft.layer===proposal.layer&&draft.scope===proposal.scope&&draft.validUntil===proposal.validUntil&&draft.contentType===proposal.contentType&&draft.operation===proposal.operation&&draft.replaces.length===proposal.replaces.length&&draft.replaces.every((ref,i)=>sameReference(ref,proposal.replaces[i]))&&['evidence','dependencies','support'].every(key=>(proposal[key as 'evidence'|'dependencies'|'support']??[]).every(ref=>(draft[key as 'evidence'|'dependencies'|'support']??[]).some(old=>sameReference(old,ref))));
const sameReference=(a:object,b:object)=>JSON.stringify(a,Object.keys(a).sort())===JSON.stringify(b,Object.keys(b).sort());
export function createMemoryPipeline(memory:MemoryStore,jobs:MemoryJobs,options:{generate?:MemoryGenerator;signal?:AbortSignal;beforeGenerate?:(job:MemoryJob,signal:AbortSignal)=>Promise<void>;rankCandidates?:(records:MemoryRevision[],query:string,limit:number,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<MemoryCandidateResult>;timeoutMs?:number;verifyOutput?:boolean;afterL1?:(job:MemoryJob,nowMS:number)=>string;afterScene?:(job:MemoryJob,nowMS:number)=>void}={}) {
 const db=memory.store.database,scenes=createMemoryScenes(memory),profiles=createMemoryProfiles(memory),l1Reuse=createMemoryL1Reuse(memory);
 db.exec('CREATE TABLE IF NOT EXISTS memory_output_drafts(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS memory_output_verifications(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS memory_consolidation_cursors(collection_id TEXT NOT NULL,summary_id TEXT NOT NULL,data_hash TEXT NOT NULL,PRIMARY KEY(collection_id,summary_id))');
 db.exec('CREATE TABLE IF NOT EXISTS memory_scene_recoveries(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS memory_extraction_drafts(job_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS memory_session_summaries(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS memory_session_summary_scope ON memory_session_summaries(collection_id,conversation_id)');
 return {async runNext(workerId:string,now?:string,kinds?:('request'|'session')[]):Promise<MemoryJob|null> {
  const job=jobs.claim(workerId,now,kinds);if(!job)return null;
  if(job.inputVersion!=='text-v1'&&['extract','conflict'].includes(job.stage??'extract'))memory.store.transaction(()=>{
   jobs.validateLease(job,now);
   for(const table of ['memory_extraction_drafts','memory_output_drafts','memory_output_verifications'])db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(job.id);
   job.inputVersion='text-v1';job.stage='extract';delete job.extraction;
   db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id);
  });
  const stage=job.stage??'extract',kind=job.kind??'request';
  let activeDraftIndex:number|undefined,auditing=false,batchCheckpoint=false,applyingOutput=false;
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...options.signal?[options.signal]:[]]);let timer:ReturnType<typeof setTimeout>|undefined;
  const fail=(error:string,rejectedOutput=false,detail:string|null=null)=>{
   if(rejectedOutput)memory.store.transaction(()=>{
    const row=db.prepare('SELECT data FROM memory_jobs WHERE id=?').get(job.id),current=row?JSON.parse(row.data as string) as MemoryJob:undefined;
    if(current?.state!=='running'||current.leaseToken!==job.leaseToken)return;
    if(stage!=='extract'&&activeDraftIndex!==undefined){
     const saved=db.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id);
     if(saved&&batchCheckpoint){
      if(applyingOutput){const checkpoint=JSON.parse(saved.data as string);delete checkpoint.checked[activeDraftIndex];checkpoint.repairs=[...new Set([...checkpoint.repairs,activeDraftIndex])];checkpoint.isolated=[...new Set([...checkpoint.isolated,activeDraftIndex])];db.prepare('UPDATE memory_output_verifications SET data=? WHERE job_id=?').run(JSON.stringify(checkpoint),job.id);}return;
     }
     if(saved){const checkpoint=JSON.parse(saved.data as string);checkpoint.reviewError=error;if(!auditing){checkpoint.repairIndex=activeDraftIndex;checkpoint.next=Math.min(checkpoint.next,activeDraftIndex);checkpoint.checked=checkpoint.checked.slice(0,activeDraftIndex);}db.prepare('UPDATE memory_output_verifications SET data=? WHERE job_id=?').run(JSON.stringify(checkpoint),job.id);return;}
    }
    if(auditing&&stage==='extract'&&db.prepare('SELECT 1 FROM memory_output_verifications WHERE job_id=?').get(job.id))return;
    if(auditing&&['verification_no_result','verification_identity_changed','invalid_verified_summary','invalid_memory_generation'].includes(error))return;
    db.prepare('DELETE FROM memory_output_drafts WHERE job_id=?').run(job.id);
    db.prepare('DELETE FROM memory_output_verifications WHERE job_id=?').run(job.id);
   });
   jobs.fail(job.id,job.leaseToken,error,now,detail);
  };
  try {
   if(!options.generate)throw new Error('memory_generator_unconfigured');
   const c=memory.collection(job.principal,job.collectionId);
   const sourceProject=(ref:{sourceId:string})=>job.profileScope?memory.collection({userId:job.principal.userId},memory.source({userId:job.principal.userId},ref.sourceId).collectionId).projectId:c.projectId;
   let sources=job.sourceRefs.map(ref=>memory.validateSource(job.principal,ref,true,sourceProject(ref)));
   if(stage==='extract'||stage==='conflict'){
    const published=memory.publishedSourceKeys(c.id,job.generation,job.extractorVersion);
    sources=sources.filter(source=>!published.has(`${source.id}:${source.revision}`));
    if(!sources.length){memory.store.transaction(()=>{jobs.complete(job.id,job.leaseToken,now);for(const table of ['memory_extraction_drafts','memory_output_drafts','memory_output_verifications'])db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(job.id);});return jobs.list(job.principal,{collectionId:c.id}).find(j=>j.id===job.id)!;}
   }
   const agents=job.profileScope?[job.profileScope.agentId]:job.principal.agentId?[job.principal.agentId]:[...new Set(sources.length?sources.map(s=>s.agentId??null):[c.agentId])];
   const profileScopes=agents.map(agentId=>({projectId:c.projectId,agentId}));
   for(const scope of profileScopes)memory.ensureCollection({userId:job.principal.userId},scope);
   const profileScope=stage==='profile'?(job.profileScope??(profileScopes.length===1?profileScopes[0]:undefined)):undefined;
   if(stage==='profile'&&!profileScope)memoryFail('profile_scope_required',422);
   if(profileScope){if(profileScope.projectId!==c.projectId)memoryFail('profile_scope_mismatch',403);memory.profile(job.principal,profileScope);}
   const nextProfiles=(input:MemoryRevision[],explicit=false)=>{
    let candidates=job.profileScope||job.principal.agentId||c.agentId||job.sourceRefs.length?profileScopes:[...new Set([...input.filter(r=>r.layer==='L2').flatMap(r=>r.sourceAgentIds??[]),...memory.store.listConversations().filter(chat=>(chat.projectId||null)===c.projectId).map(chat=>chat.agentId||null)])].map(agentId=>({projectId:c.projectId,agentId}));
    candidates=[...new Map([...candidates,...input.filter(r=>r.layer==='L2'&&r.semanticKey?.startsWith('scene.')).flatMap(r=>{const owner=memory.collection({userId:job.principal.userId},r.collectionId);return owner.projectId===null&&owner.agentId?[{projectId:null,agentId:owner.agentId}]:[];})].map(scope=>[JSON.stringify(scope),scope])).values()];
    return candidates.filter(scope=>{try{memory.profile({userId:job.principal.userId},scope);return profiles.should(scope,profiles.records(scope),explicit);}catch(error){if(error instanceof DomainError&&error.status===403)return false;throw error;}});
   };
   const enterProfiles=(input:MemoryRevision[],explicit=false)=>{
    const targets=nextProfiles(input,explicit);
    if(targets.length===1&&memory.ensureCollection({userId:job.principal.userId},targets[0]).id===c.id){
     jobs.advance(job,'profile',now);
     const row=db.prepare('SELECT data FROM memory_jobs WHERE id=?').get(job.id)!;
     db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data as string),principal:{...job.principal,...targets[0].agentId?{agentId:targets[0].agentId}:{}},profileScope:targets[0]}),job.id);
    }else{for(const target of targets)profiles.queue(target,profiles.records(target),now);jobs.complete(job.id,job.leaseToken,now);}
   };
   const reusable=options.verifyOutput&&(stage==='extract'||stage==='conflict')?l1Reuse.find(job,sources):{sources:[],facts:[]};
   const extractionSources=kind==='session'?sources:sources.filter(source=>!reusable.sources.some(old=>old.id===source.id));
   const batches=stage==='extract'||stage==='conflict'?memoryExtractionBatches(extractionSources):[],chunkIndex=job.extraction?.nextChunk??0;
   const inputSources=stage==='extract'||stage==='conflict'?batches[chunkIndex]??[]:sources;
   const summaryOnly=kind==='session'&&inputSources?.length>0&&inputSources.every(source=>reusable.sources.some(old=>old.id===source.id));
   const textSources=(stage==='extract'?inputSources:sources).map(memoryTextSource);
   const context={projectId:c.projectId,requests:sources.map(memoryTextSource).flatMap(s=>s.events.filter(e=>e.kind==='user'&&e.text).map(e=>e.text)),assistantReplies:textSources.flatMap(s=>s.events.filter(e=>e.kind==='text'&&e.text).map(e=>Array.from(e.text).slice(0,2000).join(''))).slice(-2)};
   let records=stage==='extract'?[]:memory.list({...job.principal,...c.agentId?{agentId:c.agentId}:{}},{projectId:c.projectId,status:'active'}).filter(r=>r.collectionId===c.id||(r.contentType==='preference'&&memory.collection({userId:job.principal.userId},r.collectionId).agentId===null));
   if(stage!=='extract')for(const agentId of new Set(sources.flatMap(s=>s.agentId?[s.agentId]:[])))for(const record of memory.list({userId:job.principal.userId,agentId},{projectId:c.projectId,status:'active'})){
    const scope=memory.collection({userId:job.principal.userId},record.collectionId);
    if(scope.projectId===null&&scope.agentId===agentId&&record.evidence.every(ref=>memory.source({userId:job.principal.userId},ref.sourceId).collectionId===c.id)&&!records.some(r=>r.recordId===record.recordId))records.push(record);
   }
   if(stage!=='extract')for(const source of sources)for(const ref of source.memoryRefs??[]){
    const recipient={...job.principal,...!job.principal.agentId&&source.agentId?{agentId:source.agentId}:{}};
    try{memory.validateReferences(recipient,{projectId:c.projectId,items:[ref]});}catch(error){
     // Modern sources retain historical recall for provenance, not authority for a new fact.
     if(source.modern&&error instanceof DomainError&&error.message==='stale_memory_dependency')continue;
     throw error;
    }
    if(!records.some(r=>r.recordId===ref.recordId))records.push(memory.read(recipient,ref.recordId,c.projectId));
   }
   if(stage==='scene')for(const record of memory.staleScenes(job.principal,c.projectId))if(record.collectionId===c.id&&!records.some(r=>r.recordId===record.recordId))records.push(record);
   if(job.extractorVersion==='confirmed-legacy-v1')records=records.filter(r=>r.layer!=='L1'||r.evidence.length>0||['user_confirmation','user_correction'].includes(r.verification));
   const scopes=[...new Set([c.id,...records.map(r=>r.collectionId)])];
   const allRecords=[...records];
   const validate=(selected:MemoryRevision[])=>memory.withAuthorityQuery(()=>{
    if(signal.aborted)throw new Error('memory_generation_cancelled');
    jobs.validateLease(job,now);
    for(const source of sources)memory.validateSource(job.principal,{sourceId:source.id,sourceRevision:source.revision},false,memory.collection({userId:job.principal.userId},source.collectionId).projectId);
    for(const selectedRecord of selected){
     const original=allRecords.find(r=>r.recordId===selectedRecord.recordId&&r.revision===selectedRecord.revision)??selectedRecord,scope=memory.collection({userId:job.principal.userId},original.collectionId),reader={...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}};
     const current=original.status==='stale'?(original.layer==='L3'&&profileScope?memory.profile(reader,profileScope,true):memory.staleScenes(reader,scope.projectId).find(r=>r.recordId===original.recordId)):memory.read(reader,original.recordId,scope.projectId);
     if(!current||current.status!==original.status||current.revision!==original.revision||semanticHash(current)!==semanticHash(original)||JSON.stringify(current.evidence)!==JSON.stringify(original.evidence)||JSON.stringify(current.dependencies)!==JSON.stringify(original.dependencies))memoryFail('memory_candidate_changed');
    }
   });
   const rank=async(pool:MemoryRevision[],query:string,limit:number,mandatory:MemoryRevision[]=[])=>{
    if(!options.rankCandidates)return rankMemoryCandidates(pool,query,{limit}).map(hit=>hit.record);
    const revalidate=async()=>{await options.beforeGenerate?.(job,signal);validate(mandatory);};
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('generation_timed_out'));},options.timeoutMs??TIMEOUT_MS);});
    try{return await Promise.race([(async()=>{const result=await options.rankCandidates!(pool,query,limit,signal,revalidate);await revalidate();return result.candidates.map(hit=>hit.record);})(),deadline]);}finally{if(timer)clearTimeout(timer);}
   };
   let sceneContext:MemoryGeneratorInput['sceneContext'];
   const retainedByRecord=new Map<string,MemoryRevision[]>();
   const retained=(record:MemoryRevision)=>record.dependencies.flatMap(ref=>{const fact=allRecords.find(r=>r.recordId===ref.recordId&&r.status==='active');if(!fact)return [];try{memory.validateReferences({...job.principal,...!job.principal.agentId&&memory.collection({userId:job.principal.userId},record.collectionId).agentId?{agentId:memory.collection({userId:job.principal.userId},record.collectionId).agentId!}:{}},{projectId:memory.collection({userId:job.principal.userId},record.collectionId).projectId,items:[ref]});return [fact];}catch{return [];}});
   if(stage==='scene'&&job.extractorVersion!=='deterministic-v1'){
    const prepared=scopes.map(id=>scenes.prepare(id,records));
    const changed=prepared.flatMap(p=>p.scenes).flatMap(block=>{const safe=new Set(retained(block).map(r=>r.recordId));return block.dependencies.flatMap(ref=>{const fact=allRecords.find(r=>r.recordId===ref.recordId&&r.layer==='L1'&&r.status==='active');return fact&&!safe.has(ref.recordId)?[fact]:[];});});
    let length=0;const facts=[...new Map([...changed,...prepared.flatMap(p=>p.newFacts)].map(r=>[r.recordId,r])).values()].filter(r=>{if(length+r.text.length>18000&&length)return false;length+=r.text.length;return true;}).slice(0,20);
    const allBlocks=prepared.flatMap(p=>p.scenes),ranked=await rank(allBlocks.filter(r=>r.status==='active'),facts.map(r=>r.text).join(' '),15,[...facts,...allBlocks.filter(r=>r.status==='stale')]);
    let blockLength=0;const blocks=[...new Map([...allBlocks.filter(r=>r.status==='stale'),...ranked].map(r=>[r.recordId,r])).values()].filter(r=>{if(blockLength+r.text.length>12000)return false;blockLength+=r.text.length;return true;}).slice(0,15);
    for(const block of blocks)retainedByRecord.set(block.recordId,retained(block));
    sceneContext={index:JSON.stringify(blocks.map(r=>({recordId:r.recordId,revision:r.revision,key:r.semanticKey}))),navigation:prepared.map(p=>p.navigation).join('\n').slice(0,4000),newFactRefs:facts.map(({recordId,revision})=>({recordId,revision}))};
    if(!facts.length&&!blocks.some(r=>r.status==='stale')){
     memory.store.transaction(()=>{options.afterScene?.(job,Date.parse(now??new Date().toISOString()));enterProfiles(records,job.personaRequested===true);});return jobs.list(job.principal,{collectionId:c.id}).find(j=>j.id===job.id)!;
    }
    records=[...facts,...blocks];
   }
   if(profileScope){
    const current=memory.profile(job.principal,profileScope,true),eligible=profiles.records(profileScope).filter(r=>r.layer==='L2'&&r.semanticKey?.startsWith('scene.'));
    let length=current?.text.length??0;
    const affected=(r:MemoryRevision)=>r.evidence.some(ref=>job.sourceRefs.some(source=>source.sourceId===ref.sourceId))?1:0;
    records=[...current?[current]:[],...eligible.sort((a,b)=>Number(current?.dependencies.some(ref=>ref.recordId===b.recordId))-Number(current?.dependencies.some(ref=>ref.recordId===a.recordId))||affected(b)-affected(a)||b.extractedAt.localeCompare(a.extractedAt)).filter(r=>{if(length+r.text.length>18000&&length)return false;length+=r.text.length;return true;}).slice(0,14)];
    for(const r of records)if(!allRecords.some(old=>old.recordId===r.recordId))allRecords.push(r);
   }
   // Derived layers may use earlier authoritative facts; sources remain permission/revision checked.
   if(stage!=='extract')for(const r of [...records.filter(r=>r.status==='active'),...retainedByRecord.values()].flat())for(const ref of r.evidence)if(!sources.some(s=>s.id===ref.sourceId))sources.push(memory.validateSource(job.principal,ref,false,memory.collection({userId:job.principal.userId},memory.source({userId:job.principal.userId},ref.sourceId).collectionId).projectId));
   const summaryRows: {id:string;data:string}[]=stage==='consolidate'?db.prepare('SELECT id,data FROM memory_session_summaries WHERE collection_id=? ORDER BY rowid').all(c.id).map(row=>({id:row.id as string,data:row.data as string})).filter(row=>{
    const summary=JSON.parse(row.data) as SessionMemorySummary;
    try {for(const ref of summary.evidence)memory.validateSource(job.principal,ref,false,c.projectId);memory.validateReferences(job.principal,{projectId:c.projectId,items:summary.dependencies});return db.prepare('SELECT data_hash FROM memory_consolidation_cursors WHERE collection_id=? AND summary_id=?').get(c.id,row.id)?.data_hash!==memoryHash(row.data);}catch{return false;}
   }):[];
   let summaryLength=0;const selectedSummaryRows=summaryRows.filter(row=>{if(summaryLength+row.data.length>18000&&summaryLength)return false;summaryLength+=row.data.length;return true;}).slice(0,5);
   const summaries=selectedSummaryRows.map(row=>JSON.parse(row.data) as SessionMemorySummary);
   if(stage==='consolidate'){
    const keys=new Set(summaries.flatMap(summary=>summary.dependencies.map(d=>d.recordId)));
    const previous=records.filter(r=>r.layer==='L2'&&r.semanticKey==='session.context');
    for(const record of previous)retainedByRecord.set(record.recordId,retained(record));
    const existing=new Set([...retainedByRecord.values()].flat().map(r=>r.recordId+'@'+r.revision));
    let length=0;records=[...previous,...records.filter(r=>r.layer==='L1'&&keys.has(r.recordId)&&!existing.has(r.recordId+'@'+r.revision)).filter(r=>{if(length+r.text.length>18000&&length)return false;length+=r.text.length;return true;})];
   }
   if(stage==='consolidate'&&selectedSummaryRows.length&&summaries.every(summary=>summary.dependencies.length===0)){
    memory.store.transaction(()=>{
     jobs.validateLease(job,now);
     for(const row of selectedSummaryRows)db.prepare('INSERT INTO memory_consolidation_cursors VALUES(?,?,?) ON CONFLICT(collection_id,summary_id) DO UPDATE SET data_hash=excluded.data_hash').run(c.id,row.id,memoryHash(row.data));
     if(summaryRows.length>selectedSummaryRows.length)jobs.advance(job,'consolidate',now);else jobs.complete(job.id,job.leaseToken,now);
    });
    return jobs.list(job.principal,{collectionId:c.id}).find(j=>j.id===job.id)!;
   }
   // Resume only identities the initial generation actually received, even if another job moved the candidate cursor.
   if(options.verifyOutput&&job.outputInputs?.stage===stage&&db.prepare('SELECT 1 FROM memory_output_drafts WHERE job_id=?').get(job.id)){
    const original=job.outputInputs.records.flatMap(ref=>allRecords.filter(r=>r.recordId===ref.recordId&&r.revision===ref.revision));
    records=[...new Map([...records,...original].map(r=>[r.recordId,r])).values()];
    if(sceneContext&&job.outputInputs.newFactRefs)sceneContext={...sceneContext,newFactRefs:job.outputInputs.newFactRefs};
   }
   for(const r of [...records.filter(r=>r.status==='active'),...[...retainedByRecord.values()].flat()])for(const ref of r.evidence)if(!sources.some(s=>s.id===ref.sourceId))sources.push(memory.validateSource(job.principal,ref,false,memory.collection({userId:job.principal.userId},memory.source({userId:job.principal.userId},ref.sourceId).collectionId).projectId));
   // Expose only compatible retained references in old blocks, never revoked dependencies.
   records=records.map(record=>retainedByRecord.has(record.recordId)?{...record,dependencies:retainedByRecord.get(record.recordId)!.map(({recordId,revision})=>({recordId,revision}))}:record);
   const dependencyParents=(proposal:MemoryProposal,index:number)=>{
    const reject=(code:string,detail:object):never=>{throw new DomainError(code,422,JSON.stringify({proposalIndex:index,...detail}));};
    if(!proposal||typeof proposal.text!=='string'||!proposal.text.trim()||!Array.isArray(proposal.replaces)||proposal.dependencies!==undefined&&!Array.isArray(proposal.dependencies))reject('invalid_proposal',{});
    for(const ref of proposal.replaces)if(!ref||!records.some(r=>r.recordId===ref.recordId&&r.revision===ref.revision))reject('invalid_replacement',{reference:ref});
    const carried=proposal.replaces.flatMap(ref=>retainedByRecord.get(ref.recordId)??[]);
    return [...(proposal.dependencies??[]),...carried.map(({recordId,revision})=>({recordId,revision}))].map(ref=>{
     if(!ref||typeof ref.recordId!=='string'||!Number.isSafeInteger(ref.revision)||ref.revision<1)reject('invalid_proposal',{reference:ref});
     const record=records.find(r=>r.recordId===ref.recordId&&r.status==='active')??carried.find(r=>r.recordId===ref.recordId);
     if(!record)reject('dependency_not_provided',{reference:ref});
     const scope=memory.collection({userId:job.principal.userId},record!.collectionId);
     try{memory.validateReferences({...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}},{projectId:scope.projectId,items:[ref]});}catch(error){if(error instanceof DomainError&&error.code==='stale_memory_dependency')reject(error.code,{reference:ref,currentRevision:record!.revision});throw error;}
     return record!;
    });
   };
   const applyOutput=(proposal:MemoryProposal,index:number)=>{
    activeDraftIndex=index;
    const parents=dependencyParents(proposal,index),carried=proposal.replaces.flatMap(ref=>retainedByRecord.get(ref.recordId)??[]);
    proposal={...proposal,evidence:[...new Map([...proposal.evidence,...parents.flatMap(r=>r.evidence)].map(ref=>[JSON.stringify(ref),ref])).values()],dependencies:[...new Map([...(proposal.dependencies??[]),...carried.map(({recordId,revision})=>({recordId,revision}))].map(ref=>[ref.recordId,ref])).values()]};
    if(proposal.collectionId!==job.collectionId||proposal.operation!=='retract'&&proposal.evidence.some(e=>!sources.some(s=>s.id===e.sourceId&&s.revision===e.sourceRevision)))memoryFail('job_evidence_mismatch',422);
    if(proposal.layer!==(stage==='profile'?'L3':'L2'))memoryFail('stage_layer_mismatch',422);
    if(stage==='consolidate'&&proposal.semanticKey!=='session.context')memoryFail('consolidation_key_mismatch',422);
    if(stage==='scene'&&job.extractorVersion!=='deterministic-v1'&&!proposal.semanticKey?.startsWith('scene.'))memoryFail('scene_key_required',422);
    if(stage==='profile'&&proposal.dependencies?.some(ref=>!records.some(r=>r.recordId===ref.recordId&&r.revision===ref.revision&&r.layer==='L2')))memoryFail('profile_scene_required',422);
    return memory.applyProposal(job.principal,{...proposal,pipeline:kind},job.generation,'layer_summary',profileScope?{profileScope}:{});
   };
   const validateOutput=(proposal:MemoryProposal,index:number)=>memory.store.transaction(()=>{
    db.exec('SAVEPOINT memory_output_check');
    try{applyOutput(proposal,index);}finally{db.exec('ROLLBACK TO memory_output_check');db.exec('RELEASE memory_output_check');}
   });
   const generate=async(records:MemoryRevision[],atoms?:MemoryProposal[],drafts?:MemoryProposal[],draftSummary?:string,reviewError?:string|null,repairDrafts?:MemoryProposal[],batchItems?:MemoryBatchItem[],reviewCandidateIds?:string[],reviewSummary?:boolean)=>{
    // Only the replacements currently under review contribute retained full proofs.
    const reviewRetained=(draft:MemoryProposal)=>draft.replaces.flatMap(ref=>retainedByRecord.get(ref.recordId)??[]).filter(record=>record.layer==='L1');
    if(drafts&&stage!=='extract'){
     records=[...new Map([...records,...drafts.flatMap(reviewRetained)].map(record=>[record.recordId,record])).values()];
     batchItems=batchItems?.map(item=>({...item,records:[...new Map([...item.records,...item.draft?reviewRetained(item.draft):[]].map(record=>[record.recordId,record])).values()]}));
    }
    await options.beforeGenerate?.(job,signal);validate([...records,...[...retainedByRecord.values()].flat()]);
    const verifiedDependencies=drafts?.flatMap(draft=>(draft.dependencies??[]).flatMap(ref=>{const record=records.find(r=>r.recordId===ref.recordId&&r.status==='active');if(!record)return [];const scope=memory.collection({userId:job.principal.userId},record.collectionId);memory.validateReferences({...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}},{projectId:scope.projectId,items:[ref]});return [ref];}));
    const refs=new Set([...records.flatMap(r=>r.evidence.map(e=>e.sourceId)),...(atoms??[]).flatMap(a=>a.evidence.map(e=>e.sourceId)),...summaries.flatMap(s=>s.evidence.map(e=>e.sourceId)),...[...retainedByRecord.values()].flat().flatMap(r=>r.evidence.map(e=>e.sourceId))]);
    const providedSources=stage==='extract'?inputSources:job.extractorVersion==='deterministic-v1'?sources:sources.filter(source=>refs.has(source.id));
    const draftIssues=stage==='extract'?drafts?.flatMap<NonNullable<MemoryGeneratorInput['draftIssues']>[number]>((p,index)=>{
     const events=(p.support??[]).map(ref=>({ref,event:providedSources.find(source=>source.id===ref.sourceId)?.events.find(event=>event.id===ref.eventId)}));
     if(!Array.isArray(p.support)||!p.support.length||events.some(({ref,event})=>!event||event.contextOnly||!['user','tool'].includes(event.kind)||typeof ref.quote!=='string'||!ref.quote.trim()||!event.text.includes(ref.quote)))return [{index,reason:'unsupported_extract' as const}];
     if(!events.some(({event})=>event!.kind==='user')&&events.some(({ref,event})=>!memoryToolObservationScoped(event!,ref.quote,p.text)))return [{index,reason:'tool_observation_scope_required' as const}];
     return [];
    }):undefined;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('generation_timed_out'));},options.timeoutMs??TIMEOUT_MS);});
    try{const result=await Promise.race([options.generate!({profileScope,reviewCandidateIds,reviewSummary,revalidate:()=>validate([...records,...[...retainedByRecord.values()].flat()]),batchItems,summaryOnly:stage==='extract'&&summaryOnly,reusableFacts:reusable.facts,reusableSourceRefs:reusable.sources.map(source=>({sourceId:source.id,sourceRevision:source.revision})),job:reviewError?{...job,error:reviewError}:job,sources:providedSources,records,stage:drafts?'verify':stage,callKind:repairDrafts||job.error&&drafts?'repair':job.error?'retry':'initial',reviewStage:drafts?stage:undefined,drafts,repairDrafts,draftIssues,draftSummary,verifiedDependencies,signal,summaries,context,atoms,sceneContext,retainedDependencies:[...new Map([...retainedByRecord.values()].flat().map(r=>[r.recordId,{recordId:r.recordId,revision:r.revision}])).values()]}),timeout]);validate([...records,...[...retainedByRecord.values()].flat()]);return batchItems?result:normalizeOutput(result);}finally{if(timer)clearTimeout(timer);}
   };
   type Draft={atoms:MemoryProposal[];nextAtom:number;summary?:string;completed?:number[];isolated?:number[]};
   let draft:Draft|undefined,output:Awaited<ReturnType<MemoryGenerator>>,proposals:MemoryProposal[];
   if(stage==='conflict'){
    const row=db.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(job.id);if(!row)memoryFail('missing_extraction_checkpoint');
    draft=JSON.parse(row!.data as string) as Draft;proposals=[];output={proposals,summary:draft.summary};
    const supportProofs=(proposal:Pick<MemoryProposal,'evidence'|'support'>,pending:boolean)=>{
     const evidence=proposal.evidence.map(ref=>({ref,source:memory.validateSource(job.principal,ref,pending,memory.collection({userId:job.principal.userId},memory.source({userId:job.principal.userId},ref.sourceId).collectionId).projectId)}));
     return (proposal.support??[]).flatMap(support=>{
      const matches=evidence.flatMap(({ref,source})=>{
       const event=source.events.find(event=>event.id===support.eventId);
       if(source.id!==support.sourceId||!event||event.contextOnly||!['user','tool'].includes(event.kind)||!support.quote?.trim()||!event.text.includes(support.quote)||ref.startEventId!==undefined&&event.id<ref.startEventId||ref.endEventId!==undefined&&event.id>ref.endEventId)return [];
       return [{sourceId:source.id,revision:source.revision,eventId:event.id,role:event.kind,quote:support.quote}];
      });
      if(!matches.length)memoryFail('unsupported_extract',422);return matches;
     });
    };
    const candidatesFor=async(atom:MemoryProposal)=>{
     const target=atom.scope==='user'?memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:null}):atom.scope==='agent'?memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:sources.find(s=>s.id===atom.evidence[0]?.sourceId)?.agentId??null}):c;
     return rank(memory.list({...job.principal,...target.agentId?{agentId:target.agentId}:{}},{projectId:target.projectId,collectionId:target.id,status:'active'}).filter(r=>r.layer==='L1'),atom.text,5);
    };
    draft.completed??=Array.from({length:draft.nextAtom},(_,i)=>i);draft.isolated??=[];
    const saveDraft=()=>{draft!.nextAtom=draft!.atoms.findIndex((_,i)=>!draft!.completed!.includes(i));if(draft!.nextAtom<0)draft!.nextAtom=draft!.atoms.length;db.prepare('UPDATE memory_extraction_drafts SET data=? WHERE job_id=?').run(JSON.stringify(draft),job.id);};
    while(draft.completed.length<draft.atoms.length){
     const pending=draft.atoms.map((_,i)=>i).filter(i=>!draft!.completed!.includes(i)),first=pending[0],group:{index:number;candidates:MemoryRevision[]}[]=[],targets=new Set<string>(),keys=new Set<string>();
     for(const index of pending){
      if(draft.isolated.includes(first)&&index!==first)break;if(draft.isolated.includes(index)&&index!==first)continue;
      const atom=draft.atoms[index],candidates=await candidatesFor(atom);
      if(!candidates.length||candidates.some(r=>targets.has(r.recordId))||atom.semanticKey&&keys.has(atom.semanticKey)||group.some(item=>rankMemoryCandidates([{...item.candidates[0],text:draft!.atoms[item.index].text}],atom.text,{limit:1}).length>0)){if(!group.length)group.push({index,candidates});break;}
      group.push({index,candidates});candidates.forEach(r=>targets.add(r.recordId));if(atom.semanticKey)keys.add(atom.semanticKey);if(group.length===5)break;
     }
     if(group.length<3)group.splice(1);
     const batchItems=group.length>=3?group.map(({index,candidates})=>({id:`${job.id}:conflict:${index}`,atom:draft!.atoms[index],records:candidates})):undefined;
     let result:Awaited<ReturnType<MemoryGenerator>>|undefined;
     if(group[0].candidates.length)try{result=await generate([...new Map(group.flatMap(item=>item.candidates).map(r=>[r.recordId,r])).values()],group.map(item=>draft!.atoms[item.index]),undefined,undefined,undefined,undefined,batchItems);}catch(error){if(batchItems)memory.store.transaction(()=>{jobs.validateLease(job,now);draft!.isolated=[...new Set([...draft!.isolated!,...group.map(item=>item.index)])];saveDraft();});throw error;}
     const items=result===undefined?[]:Array.isArray(result)?result:result.proposals;let failure:unknown;
     for(const {index,candidates} of group){
      const atom=draft.atoms[index];
      try{
       let decision=atom;
       if(candidates.length){
        const matches=Array.isArray(items)?batchItems?items.filter(p=>p&&(p as MemoryProposal&{batchItemId?:string}).batchItemId===`${job.id}:conflict:${index}`):items:[];
        if(matches.length!==1)memoryFail('invalid_conflict_decision',422);
        decision=(normalizeOutput(matches) as MemoryProposal[])[0];
        if(decision.replaces.some(ref=>!candidates.some(r=>r.recordId===ref.recordId&&r.revision===ref.revision)))memoryFail('conflict_candidate_mismatch',422);
        if((decision.dependencies??[]).some(ref=>!ref||!(atom.dependencies??[]).some(old=>sameReference(old,ref))))memoryFail('invalid_conflict_decision',422);
        if((decision.collectionId!==atom.collectionId||decision.layer!==atom.layer||decision.scope!==atom.scope||decision.contentType!==atom.contentType&&!['merge','update'].includes(decision.operation)||decision.validUntil!==atom.validUntil||decision.semanticKey!==atom.semanticKey||decision.operation!=='merge'&&decision.text!==atom.text||(decision.support??[]).some(ref=>!(atom.support??[]).some(old=>sameReference(old,ref)))||decision.evidence.some(ref=>!atom.evidence.some(old=>sameReference(old,ref))&&!candidates.filter(r=>decision.replaces.some(old=>old.recordId===r.recordId)).some(r=>r.evidence.some(old=>sameReference(old,ref))))))memoryFail('invalid_conflict_decision',422);
        decision={...decision,collectionId:job.collectionId,layer:'L1',scope:atom.scope,support:atom.support,evidence:decision.operation==='merge'?[...new Map([...atom.evidence,...candidates.filter(r=>decision.replaces.some(ref=>ref.recordId===r.recordId)).flatMap(r=>r.evidence)].map(ref=>[JSON.stringify(ref),ref])).values()]:atom.evidence};
       }else decision={...atom,operation:'store',replaces:[]};
       if(decision.operation==='skip'){const duplicate=candidates.find(r=>r.text===atom.text||decision.skipReason==='duplicate'&&decision.replaces.some(ref=>ref.recordId===r.recordId));if(duplicate)decision={...atom,text:duplicate.text,semanticKey:duplicate.semanticKey,contentType:duplicate.contentType,operation:'store',replaces:[]};}
       memory.store.transaction(()=>{
        validate(candidates);
        if(['update','merge'].includes(decision.operation)){
         const incoming=supportProofs(atom,true);
         for(const ref of decision.replaces){
          const target=candidates.find(candidate=>candidate.recordId===ref.recordId)!,existing=memory.read(job.principal,ref.recordId,memory.collection({userId:job.principal.userId},target.collectionId).projectId),proofs=supportProofs(existing,false);
          if(existing.status!=='active'||existing.revision!==ref.revision)memoryFail('revision_conflict');
          if(decision.text!==existing.text&&incoming.length&&incoming.every(proof=>proofs.some(old=>old.sourceId===proof.sourceId&&old.revision===proof.revision&&old.eventId===proof.eventId&&old.role===proof.role&&old.quote.includes(proof.quote))))memoryFail('memory_rewrite_requires_new_proof',422);
         }
        }
        memory.applyProposal(job.principal,{...decision,pipeline:kind},job.generation,'evidence_extract',{conflictResolved:candidates.length>0});draft!.completed!.push(index);saveDraft();
       });
      }catch(error){draft.isolated=[...new Set([...draft.isolated,index])];memory.store.transaction(()=>{jobs.validateLease(job,now);saveDraft();});failure??=error;}
     }
     if(failure)throw failure;
    }
   }else{
    const saved=options.verifyOutput?db.prepare('SELECT data FROM memory_output_drafts WHERE job_id=?').get(job.id):undefined;
    let recovery:MemoryProposal[]|undefined;
    if(!saved&&options.verifyOutput&&stage==='scene'&&kind==='request'&&job.error==='scene_no_result'&&sceneContext?.newFactRefs.length){
     const existing=records.find(r=>r.status==='active'&&r.layer==='L2'&&r.semanticKey?.startsWith('scene.')&&sceneContext!.newFactRefs.every(ref=>allRecords.find(old=>old.recordId===r.recordId)!.dependencies.some(old=>sameReference(ref,old))));
     if(existing){
      const original=allRecords.find(r=>r.recordId===existing.recordId)!;
      const candidate:MemoryProposal={collectionId:original.collectionId,layer:original.layer,contentType:original.contentType,text:original.text,semanticKey:original.semanticKey,operation:'skip',replaces:[{recordId:original.recordId,revision:original.revision}],evidence:original.evidence,support:original.support,dependencies:original.dependencies,validUntil:original.validUntil,certainty:'observed'};
      const hash=memoryHash(JSON.stringify([job.principal,job.generation,sources,sceneContext.newFactRefs,candidate])),attempt=db.prepare('SELECT data FROM memory_scene_recoveries WHERE job_id=?').get(job.id);
      if(attempt?.data!==hash){
       let valid=true;try{validateOutput(candidate,0);}catch{validate(records);valid=false;}
       if(valid){
        memory.store.transaction(()=>{validate(records);db.prepare('INSERT OR REPLACE INTO memory_scene_recoveries VALUES(?,?)').run(job.id,hash);});
        try{
         const verified=await generate(records,undefined,[candidate]),checked=Array.isArray(verified)?verified:verified.proposals;
         if(checked.length!==1)memoryFail('verification_no_result',422);
         if(!verifiedIdentity(candidate,checked[0]))memoryFail('verification_identity_changed',422);
         validateOutput(checked[0],0);recovery=checked;
        }catch(error){
         validate([...records,...[...retainedByRecord.values()].flat()]);
         if(!(error instanceof DomainError)||!['invalid_memory_generation','verification_no_result','verification_identity_changed','unsupported_no_change','invalid_proposal'].includes(error.code))throw error;
        }
       }
      }
     }
     activeDraftIndex=undefined;
    }
    if(!saved&&options.verifyOutput&&['scene','profile','consolidate'].includes(stage))memory.store.transaction(()=>{
     jobs.validateLease(job,now);
     const current=JSON.parse(db.prepare('SELECT data FROM memory_jobs WHERE id=?').get(job.id)!.data as string) as MemoryJob;
     current.outputInputs={stage,records:records.map(({recordId,revision})=>({recordId,revision})),...sceneContext?{newFactRefs:sceneContext.newFactRefs}:{}};
     db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(current),job.id);
    });
    output=recovery??(saved?normalizeOutput(JSON.parse(saved.data as string)):stage==='extract'&&extractionSources.length===0&&!summaryOnly?[]:await generate(records));proposals=Array.isArray(output)?output:output?.proposals;
    if(stage==='profile'&&Array.isArray(proposals)&&proposals.length>1)memoryFail('profile_multiple_results',422);
    if(!Array.isArray(proposals)||proposals.length>20)memoryFail('invalid_proposals',422);
    if(!recovery&&options.verifyOutput&&(proposals.length||kind==='session'&&stage==='extract')){
     memory.store.transaction(()=>{jobs.validateLease(job,now);db.prepare('INSERT OR REPLACE INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify(output));});
     if(stage==='extract'){
      type ExtractCheckpoint={hash:string;checked:Record<string,MemoryProposal|null>;summary?:string};
      const hash=memoryHash(JSON.stringify([output,job.id,job.principal,job.collectionId,job.generation,job.extractorVersion,chunkIndex,inputSources,reusable])),row=db.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id);
      let checkpoint:ExtractCheckpoint=row?JSON.parse(row.data as string):{hash,checked:{}};
      if(checkpoint.hash!==hash)checkpoint={hash,checked:{}};
      const ids=proposals.map((_,i)=>`${job.id}:extract:${i}`);
      const validateExtract=(proposal:MemoryProposal,index:number)=>{
       const normalized=(normalizeOutput([proposal]) as MemoryProposal[])[0];
       if(!verifiedIdentity(proposals[index],normalized))memoryFail('verification_identity_changed',422);
       if(normalized.layer!=='L1'||normalized.collectionId!==job.collectionId||normalized.evidence.some(e=>!inputSources.some(s=>s.id===e.sourceId&&s.revision===e.sourceRevision)))memoryFail('job_evidence_mismatch',422);
       if(normalized.scope==='user')memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:null});
       if(normalized.scope==='agent'){const agentId=sources.find(s=>s.id===normalized.evidence[0]?.sourceId)?.agentId;if(!agentId)memoryFail('agent_scope_required',422);memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:agentId!});}
       // Exercise the ordinary evidence/scope validator without publishing facts or conflicts.
       memory.store.transaction(()=>{db.exec('SAVEPOINT memory_extract_check');try{memory.applyProposal(job.principal,{...normalized,operation:'store',replaces:[],pipeline:kind},job.generation,'evidence_extract');}finally{db.exec('ROLLBACK TO memory_extract_check');db.exec('RELEASE memory_extract_check');}});
       return normalized;
      };
      const revalidateChecked=()=>{validate(records);for(const [id,p] of Object.entries(checkpoint.checked)){const index=ids.indexOf(id);if(index<0)memoryFail('invalid_memory_generation',422);if(p!==null)validateExtract(p,index);}};
      revalidateChecked();
      const pending=ids.filter(id=>!Object.hasOwn(checkpoint.checked,id)),needsSummary=kind==='session'&&checkpoint.summary===undefined;
      if(pending.length||needsSummary){
       auditing=true;
       const verified=await generate(records,undefined,pending.map(id=>proposals[ids.indexOf(id)]),needsSummary&&!Array.isArray(output)?output.summary:undefined,job.error,undefined,undefined,pending,needsSummary);
       revalidateChecked();
       if(verified instanceof MemoryReviewOutcome){
        let localError:unknown;
        for(const [id,p] of Object.entries(verified.decisions)){
         if(!pending.includes(id))memoryFail('invalid_memory_generation',422);
         try{checkpoint.checked[id]=p===null?null:validateExtract(p,ids.indexOf(id));}catch(error){localError??=error;}
        }
        if(needsSummary&&verified.summary!==undefined)checkpoint.summary=verified.summary;
        revalidateChecked();memory.store.transaction(()=>{validate(records);db.prepare('INSERT OR REPLACE INTO memory_output_verifications VALUES(?,?)').run(job.id,JSON.stringify(checkpoint));});
        if(localError)throw localError;
        if(ids.some(id=>!Object.hasOwn(checkpoint.checked,id)))memoryFail('invalid_memory_generation',422);
        if(kind==='session'&&checkpoint.summary===undefined)memoryFail('invalid_verified_summary',422);
       }else{
        // Legacy arrays/objects remain atomic, including omission-as-rejection.
        const checked=Array.isArray(verified)?verified:verified.proposals;
        if(!Array.isArray(checked)||checked.length>pending.length)memoryFail('verification_no_result',422);
        const remaining=[...pending],accepted:Record<string,MemoryProposal|null>={};
        for(const p of checked){const index=remaining.findIndex(id=>verifiedIdentity(proposals[ids.indexOf(id)],p));if(index<0)memoryFail('verification_identity_changed',422);const [id]=remaining.splice(index,1);accepted[id]=validateExtract(p,ids.indexOf(id));}
        if(needsSummary&&(Array.isArray(verified)||!verified.summary?.trim()||Array.from(verified.summary).length>6000))memoryFail('invalid_verified_summary',422);
        for(const id of remaining)accepted[id]=null;
        Object.assign(checkpoint.checked,accepted);if(needsSummary&&!Array.isArray(verified))checkpoint.summary=verified.summary;
       }
      }
      auditing=false;revalidateChecked();
      proposals=ids.flatMap(id=>checkpoint.checked[id]?[checkpoint.checked[id]!]:[]);
      output={proposals,...kind==='session'?{summary:checkpoint.summary}:{}};
     }else if(proposals.length>=3){
      batchCheckpoint=true;
      type AuditCheckpoint={hash:string;checked:Record<number,MemoryProposal>;isolated:number[];repairs:number[]};
      const hash=memoryHash('retained-proof-review-v1:'+JSON.stringify(output)),row=db.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id);
      let checkpoint=row?JSON.parse(row.data as string) as AuditCheckpoint:undefined;
      if(checkpoint?.hash!==hash||Array.isArray(checkpoint.checked))checkpoint={hash,checked:{},isolated:[],repairs:[]};
      const save=()=>memory.store.transaction(()=>{jobs.validateLease(job,now);db.prepare('INSERT OR REPLACE INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify(output));db.prepare('INSERT OR REPLACE INTO memory_output_verifications VALUES(?,?)').run(job.id,JSON.stringify(checkpoint));});
      save();
      for(const index of [...checkpoint.repairs]){
       activeDraftIndex=index;
       const result=await generate(records,undefined,undefined,undefined,job.error,[proposals[index]]),items=Array.isArray(result)?result:result.proposals;
       if(!Array.isArray(items)||items.length!==1)memoryFail('invalid_proposals',422);
       const old=proposals[index],replacement=items[0];
       if(replacement.collectionId!==old.collectionId||replacement.scope!==old.scope||replacement.contentType!==old.contentType||replacement.validUntil!==old.validUntil||old.semanticKey&&replacement.semanticKey!==old.semanticKey)memoryFail('repair_identity_changed',422);
       proposals[index]=replacement;checkpoint.repairs=checkpoint.repairs.filter(i=>i!==index);output=Array.isArray(output)?proposals:{...output,proposals};checkpoint.hash=memoryHash('retained-proof-review-v1:'+JSON.stringify(output));save();
      }
      let retainedError:unknown;
      for(const [index,p] of Object.entries(checkpoint.checked))try{validateOutput(p,Number(index));}catch(error){const slot=Number(index);delete checkpoint.checked[slot];checkpoint.repairs=[...new Set([...checkpoint.repairs,slot])];checkpoint.isolated=[...new Set([...checkpoint.isolated,slot])];retainedError??=error;}
      if(retainedError){save();throw retainedError;}
      let initialError:unknown;
      for(const [index,p] of proposals.entries())if(!checkpoint.checked[index])try{validateOutput(p,index);}catch(error){checkpoint.repairs.push(index);checkpoint.isolated.push(index);initialError??=error;}
      if(initialError){save();throw initialError;}
      while(Object.keys(checkpoint.checked).length<proposals.length){
       const pending=proposals.map((_,i)=>i).filter(i=>!checkpoint!.checked[i]);
       const group:number[]=[],targets=new Set<string>(),keys=new Set<string>();
       if(checkpoint.isolated.includes(pending[0]))group.push(pending[0]);else for(const i of pending){if(checkpoint.isolated.includes(i))continue;const refs=proposals[i].replaces.map(r=>r.recordId),key=proposals[i].semanticKey?`${proposals[i].collectionId}:${proposals[i].scope??'collection'}:${proposals[i].semanticKey}`:undefined;if(refs.some(id=>targets.has(id))||key&&keys.has(key))continue;group.push(i);refs.forEach(id=>targets.add(id));if(key)keys.add(key);if(group.length===5)break;}
       if(group.length<3)group.splice(1);
       const batchItems=group.length>=3?group.map(index=>({id:`${job.id}:${stage}:${index}`,draft:proposals[index],records})):undefined;
       let result:Awaited<ReturnType<MemoryGenerator>>;
       try{auditing=true;result=await generate(records,undefined,group.map(i=>proposals[i]),undefined,job.error,undefined,batchItems);}catch(error){checkpoint.isolated=[...new Set([...checkpoint.isolated,...group])];save();throw error;}
       const items=Array.isArray(result)?result:result.proposals;let failure:unknown;
       for(const index of group){
        activeDraftIndex=index;
        try{
         const id=`${job.id}:${stage}:${index}`,matches=Array.isArray(items)?batchItems?items.filter(p=>p&&(p as MemoryProposal&{batchItemId?:string}).batchItemId===id):items:[];
         if(matches.length!==1)memoryFail('verification_no_result',422);
         const p=(normalizeOutput(matches) as MemoryProposal[])[0],original=proposals[index];
         if(!verifiedIdentity(original,p))memoryFail('verification_identity_changed',422);
         auditing=false;validateOutput(p,index);checkpoint.checked[index]=p;
        }catch(error){checkpoint.isolated=[...new Set([...checkpoint.isolated,index])];if(!auditing)checkpoint.repairs=[...new Set([...checkpoint.repairs,index])];failure??=error;}
        auditing=true;
       }
       auditing=false;save();if(failure)throw failure;
      }
      proposals=proposals.map((_,index)=>checkpoint!.checked[index]);output=Array.isArray(output)?proposals:{...output,proposals};
     }else{
     const verificationRow=db.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id);
     const hash=memoryHash('retained-proof-review-v1:'+JSON.stringify(output));let checkpoint=verificationRow?JSON.parse(verificationRow.data as string) as {hash:string;next:number;checked:MemoryProposal[];reviewError:string|null;repairIndex?:number}:undefined;
     if(checkpoint?.hash!==hash)checkpoint={hash,next:0,checked:[],reviewError:job.error};
     {
      activeDraftIndex=checkpoint!.next;
      // Checkpoints bind to the complete draft; replace just the failed slot, then audit it again.
      if(checkpoint!.repairIndex!==undefined){
       activeDraftIndex=checkpoint!.repairIndex;
       const index=checkpoint!.repairIndex,result=await generate(records,undefined,undefined,undefined,job.error,[proposals[index]]),repaired=Array.isArray(result)?result:result.proposals;
       if(!Array.isArray(repaired)||repaired.length!==1)memoryFail('invalid_proposals',422);
       const original=proposals[index],replacement=repaired[0];if(replacement.collectionId!==original.collectionId||replacement.scope!==original.scope||replacement.contentType!==original.contentType||replacement.validUntil!==original.validUntil||original.semanticKey&&replacement.semanticKey!==original.semanticKey)memoryFail('repair_identity_changed',422);
       proposals[index]=repaired[0];output=Array.isArray(output)?proposals:{...output,proposals};checkpoint!.hash=memoryHash('retained-proof-review-v1:'+JSON.stringify(output));delete checkpoint!.repairIndex;
      }
      memory.store.transaction(()=>{jobs.validateLease(job,now);db.prepare('INSERT OR REPLACE INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify(output));db.prepare('INSERT OR REPLACE INTO memory_output_verifications VALUES(?,?)').run(job.id,JSON.stringify(checkpoint));});
      checkpoint!.checked.forEach((proposal,index)=>validateOutput(proposal,index));
      if(checkpoint!.next===0)proposals.forEach((proposal,index)=>validateOutput(proposal,index));activeDraftIndex=checkpoint!.next;
      if(checkpoint!.next>0&&checkpoint!.next<proposals.length)validateOutput(proposals[checkpoint!.next],checkpoint!.next);
     }
     const reviewed=[proposals[checkpoint!.next]];
     auditing=true;
     const verified=await generate(records,undefined,reviewed,Array.isArray(output)?undefined:output.summary,job.error??checkpoint?.reviewError);let checked=Array.isArray(verified)?verified:verified.proposals;
     if(!Array.isArray(checked)||!checked.length||checked.length>reviewed.length)memoryFail('verification_no_result',422);
     for(const proposal of checked)if(!reviewed.some(draft=>verifiedIdentity(draft,proposal)))memoryFail('verification_identity_changed',422);
     auditing=false;
     {
      checked.forEach(p=>validateOutput(p,checkpoint!.next));
      checkpoint!.checked.push(...checked);checkpoint!.next++;checkpoint!.reviewError=null;
      if(checkpoint!.next<proposals.length){memory.store.transaction(()=>{jobs.validateLease(job,now);db.prepare('INSERT OR REPLACE INTO memory_output_verifications VALUES(?,?)').run(job.id,JSON.stringify(checkpoint));jobs.advance(job,stage,now);});return jobs.list(job.principal,{collectionId:c.id}).find(j=>j.id===job.id)!;}
      checked=checkpoint!.checked;
     }
     proposals=checked;output=Array.isArray(output)?checked:{...output,proposals:checked};
     }
    }
   }
   if(stage==='extract'&&!summaryOnly&&reusable.sources.length)proposals=proposals.filter(p=>!p.evidence.length||p.evidence.some(ref=>!reusable.sources.some(source=>source.id===ref.sourceId&&source.revision===ref.sourceRevision)));
   if(stage!=='extract'&&stage!=='conflict')proposals=proposals.map((proposal,index)=>{
    const parents=dependencyParents(proposal,index);
    return {...proposal,evidence:[...new Map([...proposal.evidence,...parents.flatMap(r=>r.evidence)].map(ref=>[JSON.stringify(ref),ref])).values()]};
   });
   if(proposals.some(p=>p.scope==='user'))memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:null});
   for(const proposal of proposals.filter(p=>p.scope==='agent')){
    const agentId=sources.find(s=>s.id===proposal.evidence[0]?.sourceId)?.agentId;
    if(!agentId)memoryFail('agent_scope_required',422);
    memory.ensureCollection({userId:job.principal.userId},{projectId:null,agentId:agentId!});
   }
   const published:MemoryRevision[]=[];let retracted=false;
   memory.store.transaction(()=>{
    jobs.validateLease(job,now);
    applyingOutput=true;
    for(const [index,proposal] of (stage==='extract'||stage==='conflict'?[]:proposals).entries()){
     let saved:MemoryRevision|null;
     try{saved=applyOutput(proposal,index);}catch(error){
      const earlier=proposals.slice(0,index).flatMap((p,slot)=>['update','merge','retract'].includes(p.operation)?p.replaces.map(ref=>({ref,slot})):[]),replacement=earlier.find(({ref})=>proposal.replaces.some(old=>old.recordId===ref.recordId)),dependency=earlier.find(({ref})=>proposal.dependencies?.some(old=>old.recordId===ref.recordId));
      const overlap=error instanceof DomainError?(error.code==='revision_conflict'?replacement:error.code==='stale_memory_dependency'?dependency:undefined):undefined;
      if(overlap)throw new DomainError('invalid_replacement',422,JSON.stringify({proposalIndex:index,reason:replacement&&error instanceof DomainError&&error.code==='revision_conflict'?'overlapping_replacement':'dependency_replaced_in_stage',earlierProposalIndex:overlap.slot,reference:overlap.ref}));
      throw error;
     }
     if(saved?.status==='active')published.push(saved);
     if(proposal.operation==='retract')retracted=true;
    }
    applyingOutput=false;
    activeDraftIndex=undefined;
    if(stage==='extract')for(const fact of reusable.facts){const scope=memory.collection({userId:job.principal.userId},fact.collectionId),evidence=fact.evidence.filter(ref=>job.sourceRefs.some(old=>old.sourceId===ref.sourceId&&old.sourceRevision===ref.sourceRevision)),support=fact.support?.filter(ref=>evidence.some(old=>old.sourceId===ref.sourceId));memory.applyProposal(job.principal,{collectionId:c.id,layer:'L1',contentType:fact.contentType,text:fact.text,operation:'store',replaces:[],evidence,support,validUntil:fact.validUntil,certainty:'observed',semanticKey:fact.semanticKey,dependencies:fact.dependencies,pipeline:kind,...fact.collectionId!==c.id?{scope:scope.agentId?'agent' as const:'user' as const}:{}},job.generation,'evidence_extract');}
    if(kind==='session'&&(stage==='conflict'||stage==='extract'&&!proposals.length)) {
     const text=Array.isArray(output)?'':output.summary??'';
     if(!text||Array.from(text).length>6000)memoryFail('invalid_session_summary',422);
     const conversationId=job.conversationId??sources[0]?.conversationId;
     if(!conversationId)memoryFail('session_conversation_required',422);
     const refs=job.sourceRefs;
     const facts=memory.list(job.principal,{projectId:c.projectId,collectionId:c.id,status:'active'}).filter(r=>r.layer==='L1'&&r.evidence.some(e=>refs.some(ref=>ref.sourceId===e.sourceId)));
     const summary:SessionMemorySummary={conversationId:conversationId!,text,evidence:refs,dependencies:facts.map(({recordId,revision})=>({recordId,revision}))};
     db.prepare('INSERT OR REPLACE INTO memory_session_summaries VALUES (?,?,?,?)').run(chunkIndex?job.id+':'+chunkIndex:job.id,c.id,conversationId,JSON.stringify(summary));
    }
    db.prepare('DELETE FROM memory_output_drafts WHERE job_id=?').run(job.id);
    db.prepare('DELETE FROM memory_output_verifications WHERE job_id=?').run(job.id);
    if(stage==='consolidate'){
     if(summaries.some(summary=>summary.dependencies.length)&&!published.length)memoryFail('consolidation_no_result',422);
     const covered=new Set(published.flatMap(r=>r.dependencies).map(ref=>ref.recordId+'@'+ref.revision)),coveredIds=new Set(published.flatMap(r=>r.dependencies).map(ref=>ref.recordId));let pending=false;
     for(const row of selectedSummaryRows){const summary=JSON.parse(row.data) as SessionMemorySummary;if(summary.dependencies.every(ref=>{if(!coveredIds.has(ref.recordId))return false;memory.validateReferences(job.principal,{projectId:c.projectId,items:[ref]});return true;})||!summary.dependencies.length)db.prepare('INSERT INTO memory_consolidation_cursors VALUES(?,?,?) ON CONFLICT(collection_id,summary_id) DO UPDATE SET data_hash=excluded.data_hash').run(c.id,row.id,memoryHash(row.data));else pending=true;}
     if(pending&&!records.filter(r=>r.layer==='L1').some(r=>covered.has(r.recordId+'@'+r.revision)))memoryFail('consolidation_no_coverage',422);
     if(pending||summaryRows.length>selectedSummaryRows.length){jobs.advance(job,'consolidate',now);return;}
    }
    if(stage==='extract'&&summaryOnly&&proposals.length)memoryFail('job_evidence_mismatch',422);
    if(stage==='extract'&&proposals.length){
     for(const proposal of proposals){
      if(!proposal||!Array.isArray(proposal.evidence)||!proposal.evidence.length||!Array.isArray(proposal.replaces)||typeof proposal.text!=='string'||!proposal.text.trim())memoryFail('invalid_proposal',422);
      if(proposal.layer!=='L1'||proposal.collectionId!==job.collectionId||proposal.evidence.some(e=>!inputSources.some(s=>s.id===e.sourceId&&s.revision===e.sourceRevision)))memoryFail('job_evidence_mismatch',422);
      if(!Array.isArray(proposal.support)||!proposal.support.length||proposal.support.some(ref=>!inputSources.some(source=>source.id===ref.sourceId&&source.events.some(event=>event.id===ref.eventId&&!event.contextOnly&&['user','tool'].includes(event.kind)&&event.text.includes(ref.quote)))))memoryFail('unsupported_extract',422);
     }
     const summary=Array.isArray(output)?undefined:output.summary;
     if(kind==='session'&&(!summary||Array.from(summary).length>6000))memoryFail('invalid_session_summary',422);
     db.prepare('DELETE FROM memory_output_drafts WHERE job_id=?').run(job.id);
     db.prepare('INSERT OR REPLACE INTO memory_extraction_drafts VALUES (?,?)').run(job.id,JSON.stringify({atoms:proposals,nextAtom:0,summary}));jobs.advance(job,'conflict',now,{nextChunk:chunkIndex,totalChunks:batches.length});return;
    }
    if(stage==='conflict')db.prepare('DELETE FROM memory_extraction_drafts WHERE job_id=?').run(job.id);
    if(stage==='scene'&&sceneContext?.newFactRefs.length&&!published.length&&!retracted)memoryFail('scene_no_result',422);
    if(stage==='scene')db.prepare('DELETE FROM memory_scene_recoveries WHERE job_id=?').run(job.id);
    if(stage==='scene')options.afterScene?.(job,Date.parse(now??new Date().toISOString()));
    if(stage==='scene'){const covered=published.flatMap(p=>p.dependencies??[]),covers=(ref:{recordId:string;revision:number})=>covered.some(old=>{if(old.recordId!==ref.recordId)return false;try{const record=allRecords.find(r=>r.recordId===ref.recordId)!;const scope=memory.collection({userId:job.principal.userId},record.collectionId);memory.validateReferences({...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}},{projectId:scope.projectId,items:[old,ref]});return true;}catch{return false;}});if(sceneContext?.newFactRefs.length&&!sceneContext.newFactRefs.some(covers)&&!retracted)memoryFail('scene_no_coverage',422);for(const id of scopes)scenes.commit(id,records.filter(r=>r.layer!=='L1'||covers(r)),now??new Date().toISOString());}
    if(stage==='profile'&&!published.length&&scopes.some(id=>records.some(r=>r.collectionId===id&&r.layer==='L2')&&!records.some(r=>r.collectionId===id&&r.layer==='L3')))memoryFail('profile_no_result',422);
    if(profileScope&&published.length)profiles.committed(profileScope,now??new Date().toISOString());
    const remaining=stage==='scene'&&job.extractorVersion!=='deterministic-v1'&&scopes.some(id=>scenes.prepare(id,allRecords.filter(r=>r.status==='active')).newFacts.length>0);
    if(remaining){jobs.advance(job,'scene',now);return;}
    const active=stage==='scene'?scopes.flatMap(id=>{const scope=memory.collection({userId:job.principal.userId},id);return memory.list({...job.principal,...!job.principal.agentId&&scope.agentId?{agentId:scope.agentId}:{}},{projectId:scope.projectId,collectionId:id,status:'active'});}):[];
    const personaRequested=job.personaRequested===true||!Array.isArray(output)&&output.requestPersonaUpdate===true;
    if(options.verifyOutput&&(stage==='conflict'||stage==='extract'&&!proposals.length)&&chunkIndex+1>=batches.length)l1Reuse.save(job,job.sourceRefs.map(ref=>memory.validateSource(job.principal,ref,true,c.projectId)));
    const next:MemoryStage|null=stage==='extract'||stage==='conflict'?(kind==='session'?'consolidate':'scene'):null;
    if((stage==='extract'||stage==='conflict')&&chunkIndex+1<batches.length)jobs.advance(job,'extract',now,{nextChunk:chunkIndex+1,totalChunks:batches.length});
    else if(stage==='scene'){enterProfiles(active,personaRequested);}
    else if(next){jobs.advance(job,next,now,stage==='extract'||stage==='conflict'?{nextChunk:batches.length,totalChunks:batches.length}:undefined);if(kind==='request'&&next==='scene'&&options.afterL1){const availableAt=options.afterL1(job,Date.parse(now??new Date().toISOString()));const current=jobs.list(job.principal,{collectionId:c.id}).find(j=>j.id===job.id)!;db.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...current,availableAt}),job.id);}}else jobs.complete(job.id,job.leaseToken,now);
   });
  }catch(error){fail(error instanceof DomainError?error.code:error instanceof Error?error.message:'generation_failed',error instanceof DomainError,error instanceof DomainError&&error.message!==error.code?error.message:null);}
  finally{if(timer)clearTimeout(timer);}
  return jobs.list(job.principal,{collectionId:job.collectionId}).find(j=>j.id===job.id)??{...job,state:'obsolete',error:'source_unavailable'};
 }};
}
