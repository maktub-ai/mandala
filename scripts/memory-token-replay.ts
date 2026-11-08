// Real-model experiment. Inputs/outputs must stay outside the repository; never point this at a serving HOME.
import {copyFileSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openStore} from '../server/store';
import {memoryServices} from '../server/memory-runtime';
import {createMemoryPipeline} from '../server/memory-pipeline';
import {buildMemoryRequest} from '../server/memory-prompts';
import {memoryThinking} from '../server/memory-thinking';
import {nativeGenerate} from '../server/system-tasks';
import {meterGeneration,getUsage} from '../server/usage';
import {DomainError} from '../shared/workspace-contracts';
import type {MemoryJob,MemoryProposal} from '../shared/memory';
const [manifestPath,outputPath,spentPath]=process.argv.slice(2);
if(!manifestPath||!outputPath)throw new Error('Usage: node --import tsx scripts/memory-token-replay.ts /private/manifest.json /private/output');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as {model:string;maxCalls:number;maxReportedTokens:number;samples:{name:string;database:string;sha256:string;job:MemoryJob}[]};
const spent=spentPath?JSON.parse(readFileSync(spentPath,'utf8')) as {calls:number;reportedTokens:number;unknownCalls:number}:{calls:0,reportedTokens:0,unknownCalls:0};
if(![spent.calls,spent.reportedTokens,spent.unknownCalls].every(value=>Number.isSafeInteger(value)&&value>=0)||spent.unknownCalls>spent.calls)throw new Error('Invalid spent lane budget');
const output=resolve(outputPath);
if(existsSync(output))throw new Error('Output must be a fresh directory');
mkdirSync(output,{recursive:true,mode:0o700});
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
writeFileSync(join(output,'manifest.json'),JSON.stringify({manifestHash:hash(readFileSync(manifestPath)),model:manifest.model,maxCalls:manifest.maxCalls,maxReportedTokens:manifest.maxReportedTokens,spent,startedAt:new Date().toISOString()},null,2),{mode:0o600});
let calls=spent.calls,reported=spent.reportedTokens,startupFailure=false;
for(const sample of manifest.samples){
 if(hash(readFileSync(sample.database))!==sample.sha256)throw new Error('Frozen database hash changed');
 const home=join(output,sample.name);mkdirSync(home,{mode:0o700});copyFileSync(sample.database,join(home,'state.sqlite'));
 const store=openStore(home),{memory,jobs,recall}=memoryServices(home,store),root={userId:store.ownerUserId},steps:unknown[]=[];
 const database=store.database;
 if(database.prepare('SELECT id FROM memory_jobs LIMIT 1').get())throw new Error('Frozen fixture must have an empty job queue to isolate the exact sample');
 if(database.prepare('SELECT id FROM usage_executions LIMIT 1').get()||database.prepare('SELECT identity FROM usage_observations LIMIT 1').get())throw new Error('Frozen fixture must have no historical usage');
 database.prepare('INSERT OR REPLACE INTO memory_jobs(id,dedupe_key,data) VALUES(?,?,?)').run(sample.job.id,sample.job.id,JSON.stringify(sample.job));
 const pipeline=createMemoryPipeline(memory,jobs,{verifyOutput:true,generate:async input=>{
  const projectId=memory.collection(root,input.job.collectionId).projectId;
  if(input.sources.some(source=>memory.collection(root,source.collectionId).projectId!==projectId))throw new Error('experiment_source_outside_approved_project');
  if(calls>=manifest.maxCalls||reported>=manifest.maxReportedTokens)throw new Error('experiment_budget_exhausted');calls++;
  const request=buildMemoryRequest(input),prompt=request.prompt,executionId=randomUUID(),started=Date.now();
  let response:string|undefined,error:string|undefined;
  try{
   response=await meterGeneration(store,nativeGenerate,{executionId,category:'memory',cli:'omp',model:manifest.model,systemJobId:input.job.id,projectId:memory.collection(root,input.job.collectionId).projectId,stage:input.stage,reviewStage:input.reviewStage??null,callKind:input.callKind??(input.job.error?(input.stage==='verify'?'repair':'retry'):'initial')},{cli:'omp',model:manifest.model,thinking:memoryThinking(input)},prompt,input.signal);
   let parsed:unknown;try{parsed=JSON.parse(response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));}catch{throw new DomainError('invalid_memory_generation',422,'invalid_memory_generation');}
   input.revalidate?.();
   parsed=request.decode(input,parsed);
   const proposals=Array.isArray(parsed)?parsed:(parsed as {proposals?:unknown})?.proposals;if(!Array.isArray(proposals)||proposals.length>20)throw new DomainError('invalid_memory_generation',422,'invalid_memory_generation');
   return parsed as MemoryProposal[];
  }catch(e){error=e instanceof Error?e.message:String(e);if(/startup|native-exit|model-unavailable|quota-exhausted/.test(error))startupFailure=true;throw e;}
  finally{
   const usage=JSON.parse(database.prepare('SELECT data FROM usage_executions WHERE id=?').get(executionId)!.data as string);reported+=usage.totals.totalTokens??0;
   appendFileSync(join(home,'calls.jsonl'),JSON.stringify({executionId,stage:input.stage,reviewStage:input.reviewStage,callKind:usage.callKind,elapsedMs:Date.now()-started,promptHash:hash(prompt),prompt,response,error,usage})+'\n',{mode:0o600});
   console.log(JSON.stringify({sample:sample.name,call:calls,stage:input.stage,reviewStage:input.reviewStage,tokens:usage.totals.totalTokens,coverage:usage.coverage,error}));
  }
 }});
 try{
  for(let step=0;step<80;step++){
   const job=jobs.list(root,{collectionId:sample.job.collectionId}).find(j=>j.id===sample.job.id)!;
   if(['completed','failed','obsolete'].includes(job.state)||calls>=manifest.maxCalls||reported>=manifest.maxReportedTokens)break;
   const result=await pipeline.runNext('token-experiment',new Date(Math.max(Date.now(),Date.parse(job.availableAt))).toISOString());steps.push(result);
   if(!result||startupFailure)break;
  }
  const records=memory.listAll(root,{status:'active'}),result=jobs.list(root).find(j=>j.id===sample.job.id),usage=getUsage(store,{period:'today',timeZone:'Asia/Singapore'});
  const queries=(JSON.parse(readFileSync(manifestPath,'utf8')).queries??[]) as string[];
  const retrieval=queries.map(query=>({query,hits:recall.search(root,{query,projectId:memory.collection(root,sample.job.collectionId).projectId}).items}));
  writeFileSync(join(home,'result.json'),JSON.stringify({result,steps,usage,records,retrieval,stopReason:startupFailure?'native_startup_or_capacity':calls>=manifest.maxCalls?'call_budget':reported>=manifest.maxReportedTokens?'reported_token_budget':null},null,2),{mode:0o600});
  console.log(JSON.stringify({sample:sample.name,state:result?.state,error:result?.error,total:usage.totals.totalTokens}));
 }finally{store.close();}
 if(startupFailure)break;
}
