/** Offline retrieval and paired-recording scorer. No inference, embedding or native CLI entry point. */
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import {createMemoryRecall} from '../server/memory-recall';
import {DomainError} from '../shared/workspace-contracts';
import type {MemoryRevision,MemorySource,MemoryLayer,MemoryContentType} from '../shared/memory';
import type {UsageTokens,UsageCoverage} from '../shared/usage';

type SourceRef={sourceId:string;sourceRevision:number};
type Seed={id:string;revision:number;projectId:string|null;agentId:string|null;scope:'user'|'project'|'agent';layer:MemoryLayer;contentType:MemoryContentType;text:string;status:string;verification:string;sourceRefs:SourceRef[];dependencies:{recordId:string;revision:number}[];validUntil:string|null};
export type PairedCase={id:string;category:string;language:string;scope:{userId:string;projectId:string;agentId:string};evaluatedAt:string;
 sourceHistory:{id:string;revision:number;projectId:string|null;agentId:string|null;eventKind:string;text:string;status:string;observedAt:string;visibility:string}[];
 seedMemory:Seed[];task:{request:string;availableSourceIds:string[]};
 gold:{requiredMemoryIds:string[];allowedMemoryIds:string[];forbiddenMemoryIds:string[];answerFacts:Record<string,unknown>;forbiddenAnswerClaims:string[];backgroundFactsAlreadySupplied:number;acceptableClarificationCount:number;acceptedAliases:Record<string,unknown[]>}};
export type PairedFixture={schemaVersion:string;cases:PairedCase[]};
type Hit={id:string;sourceRefs:SourceRef[];characters:number;text?:string};
type Observation=UsageTokens&{executionId:string;stage:string;reviewStage:string|null;callKind:string;status:string;coverage:UsageCoverage;durationMs:number|null};
export type PairedRecording={schemaVersion:string;evidenceClass:string;taskId:string;repeat:number;lanes:{lane:'without_memory'|'with_memory';answer:Record<string,unknown>;answerOrigin:string;recalledMemoryIds:string[];sourceReads:string[];unnecessaryBackgroundQuestions:number;userRestatedBackgroundFacts:number;nativeCallsInitiated:number;nativeCallsCompleted:number;observations:Observation[]}[]};
export type RuntimeFixtures={schemaVersion:string;evidenceClass:string;fixtures:{id:string;lanes:{lane:string;observations:(Omit<Observation,keyof UsageTokens>&{totals:UsageTokens})[];syntheticInitiatedCalls:number;actualNativeCallsInitiated:number}[]}[]};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const distinct=(ids:string[])=>new Set(ids).size===ids.length;
const assert=(condition:unknown,reason:string)=>{if(!condition)throw new Error(reason);};

export function validateFixture(f:PairedFixture){
 assert(f.schemaVersion==='mandala-paired-task-v1'&&Array.isArray(f.cases)&&f.cases.length,'Invalid paired fixture');
 assert(distinct(f.cases.map(c=>c.id)),'Duplicate case ID');
 for(const c of f.cases){
  assert(Number.isFinite(Date.parse(c.evaluatedAt)),'Invalid evaluation time');
  assert(distinct(c.sourceHistory.map(s=>s.id))&&distinct(c.seedMemory.map(m=>m.id)),'Duplicate source/memory ID');
  for(const id of c.task.availableSourceIds)assert(c.sourceHistory.some(s=>s.id===id&&s.status==='ready'),'Unavailable source ID');
  for(const m of c.seedMemory){
   assert(m.sourceRefs.length&&m.sourceRefs.every(r=>c.sourceHistory.some(s=>s.id===r.sourceId&&s.revision===r.sourceRevision)),'Invalid source revision');
   assert(m.dependencies.every(r=>c.seedMemory.some(d=>d.id===r.recordId&&d.revision===r.revision)),'Invalid dependency revision');
  }
  for(const ids of [c.gold.requiredMemoryIds,c.gold.allowedMemoryIds,c.gold.forbiddenMemoryIds])assert(distinct(ids)&&ids.every(id=>c.seedMemory.some(m=>m.id===id)),'Invalid gold ID');
  assert(c.gold.requiredMemoryIds.every(id=>c.gold.allowedMemoryIds.includes(id))&&!c.gold.allowedMemoryIds.some(id=>c.gold.forbiddenMemoryIds.includes(id)),'Conflicting gold');
 }
 return f.cases;
}
function eligible(c:PairedCase,m:Seed):boolean{
 return m.status==='active'&&['evidence_extract','layer_summary','user_correction'].includes(m.verification)&&
  (!m.validUntil||Date.parse(m.validUntil)>Date.parse(c.evaluatedAt))&&
  (m.scope==='user'||m.scope==='agent'&&m.agentId===c.scope.agentId||m.scope==='project'&&m.projectId===c.scope.projectId)&&
  m.sourceRefs.every(r=>c.task.availableSourceIds.includes(r.sourceId)&&c.sourceHistory.some(s=>s.id===r.sourceId&&s.revision===r.sourceRevision&&s.status==='ready'))&&
  m.dependencies.every(d=>{const seed=c.seedMemory.find(s=>s.id===d.recordId);return seed&&eligible(c,seed);});
}
export function scoreRetrieval(c:PairedCase,hits:Hit[]){
 const unique=[...new Map(hits.map(h=>[h.id,h])).values()];
 let authorityErrors=0,sourceErrors=0,contentErrors=0;const valid=new Set<string>();
 for(const h of unique){const m=c.seedMemory.find(m=>m.id===h.id);
  if(!m||!eligible(c,m))authorityErrors++;
  const sourceError=!m||!distinct(h.sourceRefs.map(r=>r.sourceId))||h.sourceRefs.length!==m.sourceRefs.length||h.sourceRefs.some(r=>!m.sourceRefs.some(s=>s.sourceId===r.sourceId&&s.sourceRevision===r.sourceRevision));
  const contentError=h.text!==undefined&&h.text!==m?.text;if(sourceError)sourceErrors++;if(contentError)contentErrors++;
  if(m&&eligible(c,m)&&!sourceError&&!contentError)valid.add(h.id);
 }
 const at=(k:number)=>{const top=unique.slice(0,k),relevant=top.filter(h=>valid.has(h.id)&&c.gold.allowedMemoryIds.includes(h.id));return {
  precision:top.length?relevant.length/top.length:null,
  recall:c.gold.requiredMemoryIds.length?c.gold.requiredMemoryIds.filter(id=>top.some(h=>valid.has(h.id)&&h.id===id)).length/c.gold.requiredMemoryIds.length:null};};
 const five=at(5),eight=at(8),rank=unique.findIndex(h=>valid.has(h.id)&&c.gold.requiredMemoryIds.includes(h.id));
 return {precisionAt5:five.precision,recallAt5:five.recall,precisionAt8:eight.precision,recallAt8:eight.recall,
  reciprocalRank:c.gold.requiredMemoryIds.length?(rank<0?0:1/(rank+1)):null,authorityErrors,sourceErrors,contentErrors,contentUnmeasuredHits:unique.filter(h=>h.text===undefined).length,
  irrelevantHits:unique.filter(h=>!c.gold.allowedMemoryIds.includes(h.id)).length,duplicateHits:hits.length-unique.length,
  returned:hits.length,characters:hits.reduce((sum,h)=>sum+h.characters,0),negativeFalsePositive:!c.gold.requiredMemoryIds.length&&hits.length>0,
  budgetErrors:Number(hits.length>8)+Number(hits.reduce((sum,h)=>sum+h.characters,0)>6000)};
}
export function summarizeObservations(observations:Observation[]){
 const unique=new Map<string,Observation>();
 for(const o of observations){const prior=unique.get(o.executionId);assert(!prior||JSON.stringify(prior)===JSON.stringify(o),'Conflicting final execution snapshots');unique.set(o.executionId,o);}
 const duplicateSnapshots=observations.length-unique.size;observations=[...unique.values()];
 const calls=observations.filter(o=>o.status!=='not_run');
 for(const o of observations){
  assert(['observed','partial','unknown'].includes(o.coverage)&&['not_run','running','completed','failed','interrupted'].includes(o.status),'Invalid observation');
  for(const key of ['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','durationMs'] as const)assert(o[key]===null||typeof o[key]==='number'&&Number.isFinite(o[key])&&o[key]!>=0,'Invalid usage counter');
 }
 const sum=(key:keyof UsageTokens)=>calls.reduce((n,o)=>n+(o[key]??0),0);
 const full=(key:keyof UsageTokens)=>calls.length&&calls.every(o=>o[key]!==null)?sum(key):null;
 const complete=calls.length>0&&calls.every(o=>o.coverage==='observed'&&o.totalTokens!==null&&o.inputTokens!==null&&o.outputTokens!==null&&o.status!=='running');
 return {duplicateSnapshots,initiated:calls.length,completed:calls.filter(o=>o.status==='completed').length,failed:calls.filter(o=>o.status==='failed').length,interrupted:calls.filter(o=>o.status==='interrupted').length,
  observed:calls.filter(o=>o.coverage==='observed').length,partial:calls.filter(o=>o.coverage==='partial').length,unknown:calls.filter(o=>o.coverage==='unknown').length,
  complete,reportedTotalTokens:calls.some(o=>o.totalTokens!==null)?sum('totalTokens'):null,totalTokens:complete?sum('totalTokens'):null,
  inputTokens:full('inputTokens'),outputTokens:full('outputTokens'),reasoningOutputTokens:full('reasoningOutputTokens'),reportedReasoningOutputTokens:calls.some(o=>o.reasoningOutputTokens!==null)?sum('reasoningOutputTokens'):null,
  reasoningObservable:full('reasoningOutputTokens')!==null,cachedInputTokens:full('cachedInputTokens'),cacheWriteInputTokens:full('cacheWriteInputTokens'),
  durationMs:calls.length&&calls.every(o=>o.durationMs!==null)?calls.reduce((n,o)=>n+o.durationMs!,0):null,
  stages:[...new Set(observations.map(o=>o.stage+':'+(o.reviewStage??'')))].map(key=>{const rows=calls.filter(o=>o.stage+':'+(o.reviewStage??'')===key),source=observations.find(o=>o.stage+':'+(o.reviewStage??'')===key)!;
   const tokens=(field:keyof UsageTokens)=>rows.length&&rows.every(o=>o[field]!==null)?rows.reduce((n,o)=>n+o[field]!,0):null;
   return {stage:source.stage,reviewStage:source.reviewStage,calls:rows.length,retries:rows.filter(o=>o.callKind==='retry').length,repairs:rows.filter(o=>o.callKind==='repair').length,
    inputTokens:tokens('inputTokens'),outputTokens:tokens('outputTokens'),reasoningOutputTokens:tokens('reasoningOutputTokens'),totalTokens:rows.every(o=>o.coverage==='observed')?tokens('totalTokens'):null,
    reportedTotalTokens:rows.some(o=>o.totalTokens!==null)?rows.reduce((n,o)=>n+(o.totalTokens??0),0):null};})};
}
export function scoreRuntimeFixtures(f:RuntimeFixtures){
 assert(f.schemaVersion==='mandala-runtime-fixtures-v1'&&f.evidenceClass==='synthetic_protocol','Invalid runtime fixture protocol');
 const fixtures=f.fixtures.map(fixture=>{
  const lanes=fixture.lanes.map(l=>{assert(l.actualNativeCallsInitiated===0,'Runtime fixture cannot claim real native calls');const usage=summarizeObservations(l.observations.map(o=>({...o,...o.totals})));assert(usage.initiated===l.syntheticInitiatedCalls,'Synthetic initiation receipt mismatch');return {lane:l.lane,usage};});
  const without=lanes.find(l=>l.lane==='without_memory')!.usage.totalTokens,withMemory=lanes.find(l=>l.lane==='with_memory')!.usage.totalTokens;
  return {id:fixture.id,lanes,syntheticLifecycleSavingFraction:without!==null&&without>0&&withMemory!==null?(without-withMemory)/without:null,claimableRealBenefit:false};
 });
 return {evidenceClass:'synthetic_protocol',answerBenefitMeasured:false,nativeTokenBenefitMeasured:false,actualNativeCallsInitiated:0,fixtures};
}
export function scoreRecording(c:PairedCase,r:PairedRecording){
 assert(r.schemaVersion==='mandala-paired-recording-v1'&&r.evidenceClass==='synthetic_protocol'&&r.taskId===c.id,'Only explicit offline protocol recordings are supported');
 assert(r.lanes.length===2&&new Set(r.lanes.map(l=>l.lane)).size===2&&r.lanes.some(l=>l.lane==='with_memory')&&r.lanes.some(l=>l.lane==='without_memory'),'Both paired lanes required');
 const lanes=r.lanes.map(l=>{
  assert(l.sourceReads.every(id=>c.task.availableSourceIds.includes(id)),'Unauthorized source read');
  assert(l.lane!=='without_memory'||!l.recalledMemoryIds.length,'No-memory lane recalled memory');
  const usage=summarizeObservations(l.observations);assert(usage.initiated===l.nativeCallsInitiated&&usage.completed===l.nativeCallsCompleted,'Native call receipt mismatch');
  const answerErrors=Object.entries(c.gold.answerFacts).filter(([key,value])=>l.answer[key]!==value&&!c.gold.acceptedAliases[key]?.includes(l.answer[key])).length;
  const forbiddenClaims=c.gold.forbiddenAnswerClaims.filter(claim=>JSON.stringify(l.answer).includes(claim)).length;
  const hits=l.recalledMemoryIds.map(id=>({id,sourceRefs:c.seedMemory.find(m=>m.id===id)?.sourceRefs??[],characters:0})),retrieval=scoreRetrieval(c,hits);
  return {lane:l.lane,answerErrors,forbiddenClaims,taskPass:answerErrors===0&&forbiddenClaims===0&&retrieval.authorityErrors===0&&l.unnecessaryBackgroundQuestions<=c.gold.acceptableClarificationCount,
   retrieval,sourceReadCount:l.sourceReads.length,unnecessaryBackgroundQuestions:l.unnecessaryBackgroundQuestions,userRestatedBackgroundFacts:l.userRestatedBackgroundFacts,usage};
 });
 const without=lanes.find(l=>l.lane==='without_memory')!,withMemory=lanes.find(l=>l.lane==='with_memory')!;
 return {evidenceClass:'synthetic_protocol',answerBenefitMeasured:false,nativeTokenBenefitMeasured:false,taskId:c.id,repeat:r.repeat,lanes,
  protocolOutcome:withMemory.taskPass===without.taskPass?'tie':withMemory.taskPass?'win':'loss',interference:without.taskPass&&!withMemory.taskPass,
  protocolBackgroundQuestionDifference:without.unnecessaryBackgroundQuestions-withMemory.unnecessaryBackgroundQuestions,
  backgroundFactsSaved:null,pairedSaving:null,missingMeasurements:['native_model_not_run','extraction_quality_not_measured','real_answer_quality_not_measured','user_background_burden_not_measured']};
}

/** Use real source/proposal, correction and retraction APIs; seeded gold bypasses extraction. */
export async function runOfflineRetrieval(f:PairedFixture){
 const cases=[];let nativeCallsInitiated=0;
 for(const c of validateFixture(f)){
  const home=mkdtempSync(join(tmpdir(),'mandala-paired-')),store=openStore(home),owner={userId:c.scope.userId};
  try{
   const assets=createAssets(store,createAssetFiles(home)),sourceIds=new Map<string,string>();
   const memory=createMemoryStore(store,{assets,tasks:createTasks(store,{assets}),localUserId:owner.userId,
    authorizeProject:(p,id)=>{if(p.agentId&&id!==c.scope.projectId)throw new DomainError('forbidden',403,'Fixture project unavailable');},
    authorizeConversationRead:(p,id)=>{if(p.agentId&&!c.task.availableSourceIds.includes(sourceIds.get(id)!))throw new DomainError('forbidden',403,'Fixture source unavailable');}});
   const sources=new Map<string,MemorySource>(),records=new Map<string,MemoryRevision>(),labels=new Map<string,string>();
   for(const s of c.sourceHistory){
    const projectId=s.visibility==='agent_private'?null:s.projectId,collection=memory.ensureCollection(owner,{projectId,agentId:s.agentId});
    const chat=store.createConversation({projectId:projectId??'',agentId:s.agentId??'',cli:'codex',model:null});sourceIds.set(chat.id,s.id);
    // Request capture needs a user boundary; this wrapper asserts no answer fact.
    if(s.eventKind==='assistant')store.appendEvent(chat.id,'user',{text:'请分析下列未核实的回答。'},s.observedAt);
    store.appendEvent(chat.id,s.eventKind==='assistant'?'text':'user',{text:s.text},s.observedAt);store.appendEvent(chat.id,'status',{status:'idle'},s.observedAt);
    sources.set(s.id,memory.captureConversation(owner,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0]);
   }
   for(const m of c.seedMemory){
    const source=sources.get(m.sourceRefs[0].sourceId)!,collection=memory.collection(owner,source.collectionId),dependencies=m.dependencies.map(d=>({recordId:records.get(d.recordId)!.recordId,revision:records.get(d.recordId)!.revision}));
    const previous=m.status==='active'?c.seedMemory.find(old=>old.status==='superseded'&&old.projectId===m.projectId):undefined;
    const replaces=previous?[{recordId:records.get(previous.id)!.recordId,revision:records.get(previous.id)!.revision}]:[];
    const record=memory.applyProposal(owner,{collectionId:collection.id,layer:m.layer,contentType:m.contentType,text:m.text,scope:m.scope==='project'?'collection':m.scope,
     operation:replaces.length?'update':'store',replaces,explicitChange:!!replaces.length,evidence:m.sourceRefs.map(r=>({sourceId:sources.get(r.sourceId)!.id,sourceRevision:sources.get(r.sourceId)!.revision})),
     support:m.status==='proposed'||m.layer!=='L1'?[]:m.sourceRefs.map(r=>{const s=sources.get(r.sourceId)!;return {sourceId:s.id,eventId:s.events[0].id,quote:s.events[0].text};}),dependencies,validUntil:m.validUntil,certainty:'user_asserted',pipeline:'request'},collection.generation,m.status==='proposed'?null:m.layer==='L1'?'evidence_extract':'layer_summary')!;
    records.set(m.id,record);labels.set(record.recordId,m.id);
   }
   for(const s of c.sourceHistory)if(s.status==='retracted'){const source=sources.get(s.id)!;memory.retractSource(owner,{sourceId:source.id,expectedRevision:source.revision});}
   const sourceLabels=new Map([...sources].map(([id,s])=>[s.id,id]));
   const start=performance.now(),result=createMemoryRecall(memory).search({...owner,agentId:c.scope.agentId},{projectId:c.scope.projectId,query:c.task.request});
   const elapsedMs=performance.now()-start,hits=result.items.map(m=>({id:labels.get(m.recordId)??'unmapped',text:m.text,sourceRefs:m.evidence.map(r=>({sourceId:sourceLabels.get(r.sourceId)??'unmapped',sourceRevision:r.sourceRevision})),characters:Array.from(m.text).length}));
   nativeCallsInitiated+=Number(store.database.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='usage_executions'").get()!.n)?Number(store.database.prepare('SELECT count(*) n FROM usage_executions').get()!.n):0;
   cases.push({id:c.id,category:c.category,language:c.language,returnedIds:hits.map(h=>h.id),score:scoreRetrieval(c,hits),retrievalMs:elapsedMs});
  }finally{store.close();rmSync(home,{recursive:true,force:true});}
 }
 const positives=cases.filter(c=>c.score.recallAt5!==null),negatives=cases.filter(c=>c.score.recallAt5===null);
 return {evidenceClass:'retrieval_regression',provider:'production_synchronous_BM25_no_vectors',seed:'Supported proposal APIs with hand-authored evidence; extraction and semantic quality unmeasured',answerBenefitMeasured:false,nativeTokenBenefitMeasured:false,nativeCallsInitiated,embeddingCalls:0,
  aggregate:{cases:cases.length,meanRecallAt5:positives.length?positives.reduce((n,c)=>n+c.score.recallAt5!,0)/positives.length:null,negativeQueries:negatives.length,negativeFalsePositiveRate:negatives.length?negatives.filter(c=>c.score.negativeFalsePositive).length/negatives.length:null,
   authorityErrors:cases.reduce((n,c)=>n+c.score.authorityErrors,0),sourceErrors:cases.reduce((n,c)=>n+c.score.sourceErrors,0),contentErrors:cases.reduce((n,c)=>n+c.score.contentErrors,0),irrelevantHits:cases.reduce((n,c)=>n+c.score.irrelevantHits,0)},cases};
}
async function main(){
 const args=process.argv.slice(2),value=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
 const fixturePath=resolve(value('--fixture')??'tests/fixtures/memory-paired-personal.json'),fixtureText=readFileSync(fixturePath,'utf8'),fixture=JSON.parse(fixtureText) as PairedFixture;
 const recordingPath=value('--recording'),recordingText=recordingPath?readFileSync(resolve(recordingPath),'utf8'):null,recording=recordingText?JSON.parse(recordingText) as PairedRecording:null;
 const runtimeText=readFileSync(resolve(value('--runtime-fixtures')??'tests/fixtures/memory-paired-runtime.json'),'utf8'),started=performance.now();
 const retrieval=await runOfflineRetrieval(fixture),paired=recording?scoreRecording(fixture.cases.find(c=>c.id===recording.taskId)!,recording):null,runtime=scoreRuntimeFixtures(JSON.parse(runtimeText));
 const report={generatedAt:new Date().toISOString(),node:process.version,sourceCommit:value('--source-commit')??null,fixtureSha256:hash(fixtureText),implementationSha256:hash(readFileSync(fileURLToPath(import.meta.url),'utf8')),recordingSha256:recordingText?hash(recordingText):null,runtimeFixtureSha256:hash(runtimeText),elapsedMs:performance.now()-started,retrieval,paired,runtime,
  benefitDecision:'unverified; no native model execution or real user burden measurement',nativeStageTokens:Object.fromEntries(['extract','conflict','scene','profile','consolidate','verify','answer'].map(stage=>[stage,{inputTokens:null,outputTokens:null,reasoningOutputTokens:null,totalTokens:null,callsInitiated:0,reason:'offline_no_model_call'}]))};
 const text=JSON.stringify(report,null,2)+'\n',output=value('--output');if(output)writeFileSync(resolve(output),text,{mode:0o600,flag:'wx'});else process.stdout.write(text);
 // Returning a diagnostic report does not mean a quality gate passed. Fail only actual authority/protocol violations.
 if(retrieval.nativeCallsInitiated||retrieval.aggregate.authorityErrors||retrieval.aggregate.sourceErrors||retrieval.aggregate.contentErrors)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(String(error instanceof Error?error.message:error)+'\n');process.exitCode=1;});
