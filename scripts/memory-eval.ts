/** Synthetic regression evaluator. Never activates inference or calls a model. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore, memoryStageSummary } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import { createMemoryPipeline } from '../server/memory-pipeline';
import { createMemoryRecall } from '../server/memory-recall';
import type { KnowledgeEntry } from '../shared/types';
import type { MemoryLayer, MemoryRevision, MemorySource } from '../shared/memory';

export type EvalCase = {
 id:string; category:string; language:'zh'|'en'; user:string; assistant:string; query:string;
 allowed:string[]; required:string[]; forbiddenIds:string[]; forbiddenClaims:string[];
 sourceExpectations:Record<string,string[]>; historicalText:string;
 survivorUser:string; survivorHistoricalText:string; correction:string; withdrawalMode:'record'|'expired'|'source_update'|'source_retract';
};
export type EvalHit = { id:string; text:string; layer:MemoryLayer; verification:string; sources:string[]; status:string };
const units = (s:string) => Array.from(s).length;
const hash = (s:string|Buffer) => createHash('sha256').update(s).digest('hex');
const expectedText = (c:EvalCase,id:string) => id === 'target:L2' ? c.historicalText : id === 'survivor:L2' ? c.survivorHistoricalText : id === 'survivor:L1' ? c.survivorUser : c.category==='correction' ? c.correction : c.user;
export function scoreCase(c:EvalCase,hits:EvalHit[]) {
 let scopeLeaks=0, withdrawnLeaks=0, sourceErrors=0, unsupportedClaims=0, contentErrors=0;
 for(const hit of hits) {
  const allowed=c.allowed.includes(hit.id);
  if(/^(foreign|other-agent):/.test(hit.id)) scopeLeaks++;
  if(hit.status!=='active'||c.category==='withdrawal'&&hit.id.startsWith('target:')) withdrawnLeaks++;
  const expected=c.sourceExpectations[hit.id];
  if(!expected || !hit.sources.length || expected.length!==new Set(hit.sources).size || hit.sources.some(s=>!expected.includes(s))) sourceErrors++;
  const historical=hit.layer==='L2'&&hit.verification==='stage_summary'&&hit.text===expectedText(c,hit.id)&&allowed;
  const trusted=historical||hit.layer!=='L2'&&['source_extract','user_correction'].includes(hit.verification);
  if(!trusted||c.forbiddenClaims.some(claim=>hit.text.includes(claim))&&!historical) unsupportedClaims++;
  if(!allowed||hit.text!==expectedText(c,hit.id)||hit.layer!==hit.id.split(':')[1]) contentErrors++;
 }
 const found=new Set(hits.slice(0,5).map(h=>h.id));
 return {scopeLeaks,withdrawnLeaks,sourceErrors,unsupportedClaims,contentErrors,
  budgetErrors:Number(hits.length>8)+Number(hits.reduce((n,h)=>n+units(h.text),0)>6000)+Number(new Set(hits.map(h=>h.id)).size!==hits.length),
  recallAt5:c.required.filter(id=>found.has(id)).length/c.required.length, returned:hits.length,
  layers:Object.fromEntries((['L1','L2','L3'] as const).map(layer=>{const required=c.required.filter(id=>id.endsWith(`:${layer}`));return [layer,{required:required.length,found:required.filter(id=>found.has(id)).length,returned:hits.filter(h=>h.layer===layer).length}];}))};
}
type Score=ReturnType<typeof scoreCase>;
function aggregate(scores:Score[]) {
 const sums={scopeLeaks:0,withdrawnLeaks:0,sourceErrors:0,unsupportedClaims:0,contentErrors:0,budgetErrors:0,recallAt5:0,returned:0};
 for(const score of scores) for(const key of Object.keys(sums) as (keyof typeof sums)[]) sums[key]+=score[key];
 sums.recallAt5/=scores.length;
 return {...sums,sourceAccuracy:sums.returned?(sums.returned-sums.sourceErrors)/sums.returned:null,
  layers:Object.fromEntries(['L1','L2','L3'].map(layer=>{const rows=scores.map(s=>s.layers[layer]);const required=rows.reduce((n,r)=>n+r.required,0),found=rows.reduce((n,r)=>n+r.found,0);return [layer,{required,found,recallAt5:required?found/required:null,returned:rows.reduce((n,r)=>n+r.returned,0)}];}))};
}
type BaselineModule={recallMemory:(home:string,context:{projectId:string;agentId:string;query:string})=>Promise<{entries:KnowledgeEntry[];instructions:string;truncated:boolean}>};
/** Requires the original module AND its local dependencies; no algorithm fallback. */
export async function loadBaseline(path:string):Promise<{module:BaselineModule;path:string;sha256:string;dependencies:Record<string,string>}> {
 const absolute=resolve(path);
 if(!existsSync(absolute)) throw new Error(`Baseline module missing: ${absolute}; supply the frozen original knowledge.ts and dependencies via --baseline.`);
 const dependencies:Record<string,string>={};
 const visit=(file:string)=>{if(dependencies[file])return;const source=readFileSync(file,'utf8');dependencies[file]=hash(source);
  for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {const base=resolve(dirname(file),match[1]);const child=[base,`${base}.ts`,`${base}.mjs`,join(base,'index.ts')].find(existsSync);if(!child)throw new Error(`Baseline dependency missing: ${base}`);visit(child);}
 };
 try { visit(absolute); const module=await import(pathToFileURL(absolute).href) as BaselineModule;
  if(typeof module.recallMemory!=='function')throw new Error('recallMemory export missing');
  return {module,path:absolute,sha256:dependencies[absolute],dependencies};
 } catch(error) {throw new Error(`Baseline load failed: ${error instanceof Error?error.message:String(error)}`);}
}
const owner={userId:'eval-user'}, reader={...owner,agentId:'eval-agent'};
function setup() {
 const home=mkdtempSync(join(tmpdir(),'mandala-synthetic-eval-')),store=openStore(home);
 const assets=createAssets(store,createAssetFiles(home));
 const tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:owner.userId}),jobs=createMemoryJobs(store,memory);
 return {home,store,memory,recall:createMemoryRecall(memory),jobs,pipeline:createMemoryPipeline(memory,jobs),close:()=>{store.close();rmSync(home,{recursive:true,force:true});}};
}
async function prepare(c:EvalCase) {
 const s=setup(),sources=new Map<string,{name:string;source:MemorySource}>(),records=new Map<string,MemoryRevision>();
 async function add(name:string,user:string,assistant:string,projectId='eval-project',agentId='eval-agent') {
  const collection=s.memory.ensureCollection(owner,{projectId,agentId});
  const chat=s.store.createConversation({projectId,agentId,cli:'codex',model:null});
  s.store.appendEvent(chat.id,'user',{text:user},'2026-10-04T00:00:00Z');
  s.store.appendEvent(chat.id,'text',{text:assistant},'2026-10-04T00:00:00Z');
  s.store.appendEvent(chat.id,'status',{status:'idle'},'2026-10-04T00:00:00Z');
  const capture=s.memory.captureConversation(owner,{collectionId:collection.id,conversationId:chat.id,trigger:'completed'});
  sources.set(capture.sources[0].id,{name,source:capture.sources[0]});
  if(name==='target'&&c.category==='withdrawal'&&c.withdrawalMode==='expired') {
   // Seed expired but correctly sourced records through the production proposal validator.
   const source=capture.sources[0],job=s.jobs.claim('eval')!;
   for(const layer of ['L1','L2'] as const)s.memory.applyProposal(owner,{collectionId:collection.id,layer,contentType:'fact',text:layer==='L1'?user:memoryStageSummary(source),operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:1,...(layer==='L1'?{startEventId:source.eventIds[0],endEventId:source.eventIds[0]}:{})}],validUntil:'2000-01-01T00:00:00Z',certainty:'user_asserted'},collection.generation,layer==='L1'?'source_extract':'stage_summary');
   s.jobs.complete(job.id,job.leaseToken);
  }else await s.pipeline.runNext('eval');
  for(const r of s.memory.list(owner,{projectId,conversationId:chat.id})) records.set(r.recordId,r);
  return {collection,source:capture.sources[0]};
 }
 try {
  const target=await add('target',c.user,c.assistant);
  if(c.category==='scope') {
   await add('foreign',c.user,c.assistant,'other-project');
   await add('other-agent',c.user,c.assistant,'eval-project','other-agent');
  }
  // A genuine unverified proposal uses real evidence but must never be active.
  const candidate=s.memory.applyProposal(owner,{collectionId:target.collection.id,layer:'L1',contentType:'fact',text:c.forbiddenClaims[0],operation:'store',replaces:[],evidence:[{sourceId:target.source.id,sourceRevision:1}],validUntil:null,certainty:'observed'},target.collection.generation)!;
  records.set(candidate.recordId,candidate);
  if(c.category==='withdrawal'||c.category==='correction') {
   const atomic=[...records.values()].find(r=>r.layer==='L1'&&r.status!=='proposed')!;
   if(c.category==='correction')s.memory.correct(owner,{recordId:atomic.recordId,expectedRevision:atomic.revision,text:c.correction});
   else {
    if(c.withdrawalMode==='record')s.memory.retract(owner,{recordId:atomic.recordId,expectedRevision:atomic.revision});
    if(c.withdrawalMode==='source_update')s.store.replaceHistory(target.source.conversationId!,target.source.eventIds[0],'fork');
    if(c.withdrawalMode==='source_retract')s.memory.retractSource(owner,{sourceId:target.source.id,expectedRevision:1});
    await add('survivor',c.survivorUser,c.assistant);
   }
  }
  // Refresh actual status after withdrawal (including invalidated derived summaries).
  for(const id of records.keys()) {
   const row=s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(id)!;
   const raw=JSON.parse(row.data as string) as MemoryRevision;
   try {records.set(id,s.memory.read(owner,id));}catch {records.set(id,{...raw,status:'stale'});}
  }
  function adapt(r:MemoryRevision):EvalHit {
   const origin=sources.get(r.evidence[0]?.sourceId),name=r.status==='proposed'?'candidate':origin?.name??'unknown';
   const sourceLabels=r.evidence.flatMap(ref=>{const entry=sources.get(ref.sourceId);if(!entry||ref.sourceRevision!==entry.source.revision)return ['invalid:source'];return entry.source.events.filter(e=>['user','text'].includes(e.kind)&&(!ref.startEventId||e.id>=ref.startEventId)&&(!ref.endEventId||e.id<=ref.endEventId)).map(e=>`${entry.name}:${e.kind==='text'?'assistant':'user'}`);});
   // Normalize only generated numeric event IDs for fixed gold text comparison; source labels above validate their actual range.
   const text=r.layer==='L2'?r.text.replace(/来源事件：[\d,]+$/, '来源事件：1,2,3'):r.text;
   return {id:`${name}:${r.layer}`,text,layer:r.layer,verification:r.verification,sources:[...new Set(sourceLabels)],status:r.status};
  }
  const entries:KnowledgeEntry[]=[...records.values()].map(r=>{const source=sources.get(r.evidence[0]?.sourceId)!.source,c=s.memory.collection(owner,r.collectionId);return {id:r.recordId,kind:'memory',title:'Synthetic memory',content:r.text,scope:'agent',projectId:c.projectId!,agentId:c.agentId!,access:{mode:'owner'},level:r.layer,status:r.status==='active'?'active':'candidate',sourceConversationId:source.conversationId!,sourceEventId:source.eventIds[0],createdAt:'2026-10-04T00:00:00Z',updatedAt:r.extractedAt};});
  return {...s,records,entries,adapt};
 }catch(error){s.close();throw error;}
}
export async function runCorpus(cases:EvalCase[],baseline?:Awaited<ReturnType<typeof loadBaseline>>) {
 // Retired gold requires raw phase excerpts and per-agent project isolation; it cannot assess the new shared extraction model.
 if(cases.some(c=>c.historicalText.startsWith('对话阶段摘录')))throw new Error('legacy_memory_gold_incompatible');
 const current:Score[]=[],old:Score[]=[],details:unknown[]=[];
 for(const c of cases) {
  const s=await prepare(c);
  try {
   const hits=s.recall.search(reader,{projectId:'eval-project',query:c.query}).items.map(s.adapt),score=scoreCase(c,hits);current.push(score);
   let baselineScore:Score|null=null;
   if(baseline) {
    // Separate flat-file home: original code performs its own scope/status/ranking checks.
    const flatHome=join(s.home,'flat');
    mkdirSync(flatHome);writeFileSync(join(flatHome,'knowledge.json'),JSON.stringify(s.entries));
    const result=await baseline.module.recallMemory(flatHome,{projectId:'eval-project',agentId:'eval-agent',query:c.query});
    const oldHits=result.entries.map(entry=>s.adapt({...s.records.get(entry.id)!,text:entry.content}));
    baselineScore=scoreCase(c,oldHits);old.push(baselineScore);
   }
   details.push({id:c.id,category:c.category,language:c.language,current:score,baseline:baselineScore,returnedIds:hits.map(h=>h.id)});
  }finally{s.close();}
 }
 return {cases:cases.length,new:aggregate(current),baseline:old.length?aggregate(old):null,details};
}
const percentile=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1];
export async function benchmark(sizes=[100,1000,10000],runs=20) {
 const results=[];
 for(const size of sizes) {
  const s=setup();
  try {
   const entries:KnowledgeEntry[]=Array.from({length:size},(_,i)=>({id:`scale-${i}`,kind:'memory',title:`Scale ${i}`,content:`Synthetic archive item ${i}; 检索规模样例 ${i}`,scope:'agent',projectId:'eval-project',agentId:'eval-agent',access:{mode:'owner'},level:'L1',status:'active',createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'}));
   const seedStart=performance.now();s.memory.importLegacy(owner,entries);const seedMs=performance.now()-seedStart;
   const measure=()=>{const start=performance.now();const result=s.recall.search(reader,{projectId:'eval-project',query:'archive 42'});if(!result.items.length)throw new Error('Scale query returned no records');return performance.now()-start;};
   const firstQueryMs=measure(),warmMs=Array.from({length:runs},measure);
   results.push({records:size,datasetSha256:hash(JSON.stringify(entries)),seedMs,firstQueryMs,warmRuns:runs,warmMs,p50Ms:percentile(warmMs,.5),p95Ms:percentile(warmMs,.95),targetMs:300,pass:percentile(warmMs,.95)<300,fixture:'Source-less legacy records via actual importLegacy; real SQLite and Asset ACL. Does not measure deep derived-source chains.'});
  }finally{s.close();}
 }
 return results;
}
async function main() {
 const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const baselinePath=value('--baseline');if(!baselinePath)throw new Error('Explicit --baseline <frozen knowledge.ts> required; no substituted baseline.');
 const baseline=await loadBaseline(baselinePath),fixturePath=resolve(value('--fixture')??'tests/fixtures/memory-eval.json'),fixtureText=readFileSync(fixturePath,'utf8');
 const corpus=JSON.parse(fixtureText) as {cases:EvalCase[];provenance:string};
 const startedAt=new Date().toISOString(),repeats=[];
 for(let i=0;i<3;i++)repeats.push(await runCorpus(corpus.cases,baseline));
 const performanceResults=await benchmark();
 const report={startedAt,finishedAt:new Date().toISOString(),provenance:corpus.provenance,fixtureSha256:hash(fixtureText),environment:{node:process.version,platform:platform(),release:release(),arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},baseline:{path:baseline.path,sha256:baseline.sha256,dependencies:baseline.dependencies},method:{repeats:3,maximumRecords:8,maximumBodyUnicode:6000,baselineBudget:'Original code additionally includes JSON/prefix overhead in its 6000 UTF-16 limit and clips records at1600; left intact. These short corpus records fit both limits.',baselineMapping:'Identical post-processing text/status/scope/access sets; nonactive -> candidate because old schema has only active/candidate. Layer retained as old level. Sidecar evidence/layer/verification only audit fixed input; old retrieval itself has no MemoryRevision provenance.',cold:'First query after seeding, process/OS caches not flushed; warm20 queries same process. Not a cold boot.',quality:'Agent-authored synthetic regression only. No model generation/self-grading/human review. No default activation gate.',summaryBudget:'Separate production summary is 2000; not included in this 6000-body ranking comparison.'},repeats,performance:performanceResults,freeInference:'shadow',semanticGate:'unverified'};
 const output=value('--output');if(output)writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');else process.stdout.write(JSON.stringify(report,null,2)+'\n');
 process.stderr.write(JSON.stringify({repeats:repeats.map(r=>({new:r.new,baseline:r.baseline})),performance:performanceResults.map(({records,firstQueryMs,p50Ms,p95Ms,pass})=>({records,firstQueryMs,p50Ms,p95Ms,pass}))},null,2)+'\n');
 if(repeats.some(r=>r.new.scopeLeaks||r.new.withdrawnLeaks||r.new.sourceErrors||r.new.unsupportedClaims||r.new.contentErrors||r.new.budgetErrors||r.new.recallAt5<.85||r.baseline&&r.new.recallAt5<r.baseline.recallAt5)||performanceResults.some(r=>!r.pass))process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:error}\n`);process.exitCode=1;});
