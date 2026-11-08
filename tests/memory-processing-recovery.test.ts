import {readConfiguredRuntime} from './configured-runtime';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import { createMemoryPipeline } from '../server/memory-pipeline';
import { createMemoryScenes } from '../server/memory-scenes';
import { createMemoryRuntime } from '../server/memory-runtime';
import { readConfig } from '../server/config';
import { buildMemoryPrompt } from '../server/memory-prompts';
import type { MemoryProposal } from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(close=>close()));
function setup(text='项目使用 pnpm。发布必须人工验收。') {
 const home=mkdtempSync(join(tmpdir(),'memory-processing-recovery-')),store=openStore(home);
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local'}),jobs=createMemoryJobs(store,memory),c=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 const event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
 const source=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const proposal=(text='项目使用 pnpm。'):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:[],validUntil:null,certainty:'observed'});
 const stage=(value:'extract'|'conflict'|'scene')=>{const job=jobs.list(root)[0];store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:value}),job.id);return job;};
 return {home,store,memory,jobs,c,source,proposal,stage};
}
test.each(['invalid_proposal','scene_no_result','scene_no_coverage','profile_no_result','consolidation_no_result','invalid_session_summary','conflict_candidate_mismatch','job_evidence_mismatch'])('%s stops after two attempts without discarding source or progress',error=>{
 const s=setup();let now=new Date().toISOString();
 for(let attempt=1;attempt<=2;attempt++){
  const job=s.jobs.claim('w',now)!;s.jobs.fail(job.id,job.leaseToken,error,now);
  const result=s.jobs.list(root)[0];expect(result).toMatchObject({state:attempt<2?'queued':'failed',error,attempt});now=result.availableAt;
 }
 expect(s.jobs.claim('w',now)).toBeNull();expect(s.jobs.list(root)[0].sourceRefs).toHaveLength(1);
});
test.each(['{}','{broken json'])('native output %s has a stable error and stops after two attempts',async value=>{
 const s=setup(),config=(await readConfiguredRuntime(s.home)).config;
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,generate:async()=>value});
 try{
  for(let attempt=1;attempt<=2;attempt++){
   const job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,availableAt:new Date().toISOString()}),job.id);
   await runtime.drain();expect(s.jobs.list(root)[0]).toMatchObject({error:'invalid_memory_generation',attempt,state:attempt<2?'queued':'failed'});
  }
 }finally{await runtime.close();}
});
test.each([
 ['{"password":"private-diagnostic-value",broken', 'json', 'invalid_json'],
 ['{"proposals":{}}', 'shape', 'proposals_not_array'],
 [JSON.stringify(Array.from({length:21},()=>({}))), 'shape', 'too_many_proposals'],
 ['{"referenceReceipt":"private-diagnostic-value","result":[]}', 'decode', 'reference_encoding_disabled'],
])('invalid output retains a safe diagnostic for %s',async(value,phase,reason)=>{
 const s=setup(),config=(await readConfiguredRuntime(s.home)).config;
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,generate:async()=>value});
 try{
  await runtime.drain();const job=s.jobs.list(root)[0];
  expect(job.error).toBe('invalid_memory_generation');
  expect(job.errorDetail).not.toBeNull();
  const detail=JSON.parse(job.errorDetail!);
  expect(detail).toMatchObject({phase,reason,responseBytes:Buffer.byteLength(value),stage:'extract',callKind:'initial'});
  expect(detail.responseHash).toMatch(/^[a-f0-9]{64}$/);
  expect(job.errorDetail).not.toContain('private-diagnostic-value');
  expect(s.memory.listAll(root,{status:'active'})).toEqual([]);
 }finally{await runtime.close();}
});
test.each([
 ['invalid_json','json'],
 ['reference_receipt_mismatch','decode'],
 ['reference_receipt_required','decode'],
 ['reference_alias_range','decode'],
 ['reference_revision_not_provided','decode'],
 ['proposals_not_array','shape'],
 ['too_many_proposals','shape'],
])('scene fault injection attributes %s and preserves saved facts',async(reason,phase)=>{
 const lines=Array.from({length:20},(_,index)=>`项目规则 ${index}：执行检查 ${index}。`);
 const s=setup(lines.join('\n')),config=(await readConfiguredRuntime(s.home)).config;
 const facts=lines.map(text=>s.memory.applyProposal(root,s.proposal(text),s.c.generation,'evidence_extract')!);s.stage('scene');
 const responses:string[]=[];
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.slice(prompt.indexOf('SOURCE_JSON:\n')+13,prompt.lastIndexOf('\nEND_SOURCE_JSON')));
  expect(data.stage).toBe('scene');expect(data.referenceDictionary).toBeDefined();
  const wrap=(result:unknown)=>JSON.stringify({referenceReceipt:data.referenceDictionary.receipt,result});
  let response:string;
  switch(reason){
   case 'invalid_json':response='{"password":"private-diagnostic-value",broken';break;
   case 'reference_receipt_mismatch':response=JSON.stringify({referenceReceipt:'private-diagnostic-value',result:[]});break;
   case 'reference_receipt_required':response=JSON.stringify([{evidence:[{sourceId:{s:0},sourceRevision:1}]}]);break;
   case 'reference_alias_range':response=wrap([{evidence:[{sourceId:{s:9999},sourceRevision:1}]}]);break;
   case 'reference_revision_not_provided':response=wrap([{evidence:[{sourceId:{s:0},sourceRevision:9999}]}]);break;
   case 'proposals_not_array':response=wrap({proposals:{}});break;
   case 'too_many_proposals':response=wrap(Array.from({length:21},()=>({})));break;
   default:throw new Error('unknown synthetic fault');
  }
  responses.push(response);return response;
 }});
 try{
  for(let attempt=1;attempt<=2;attempt++){
   const job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,availableAt:new Date().toISOString()}),job.id);
   await runtime.drain();const failed=s.jobs.list(root)[0];
   expect(failed).toMatchObject({state:attempt===1?'queued':'failed',stage:'scene',attempt,error:'invalid_memory_generation'});
   expect(JSON.parse(failed.errorDetail!)).toMatchObject({phase,reason,stage:'scene',callKind:attempt===1?'initial':'retry',responseBytes:Buffer.byteLength(responses[attempt-1])});
   expect(JSON.parse(failed.errorDetail!).responseHash).toMatch(/^[a-f0-9]{64}$/);
   expect(failed.errorDetail).not.toContain('private-diagnostic-value');
   const persisted=JSON.parse(s.store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(failed.id)!.data as string);
   expect(persisted.errorDetail).toBe(failed.errorDetail);
  }
  expect(responses).toHaveLength(2);
  expect(s.memory.listAll(root,{status:'active'}).map(record=>record.recordId).sort()).toEqual(facts.map(fact=>fact.recordId).sort());
 }finally{await runtime.close();}
});
test('a malformed saved extraction draft is regenerated instead of verified forever',async()=>{
 const s=setup();let extractions=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return input.drafts!;
  extractions++;return [s.proposal()];
 }}),job=s.jobs.list(root)[0],{text,...fields}=s.proposal();
 s.store.database.prepare('INSERT INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify([{...fields,content:text}]));
 const failed=await pipeline.runNext('w');expect(failed).toMatchObject({error:'invalid_proposal'});
 expect(s.store.database.prepare('SELECT data FROM memory_output_drafts WHERE job_id=?').get(job.id)).toBeUndefined();
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({stage:'conflict',error:null});expect(extractions).toBe(1);
});
test('modern historical recall references cannot block independently supported new user facts',async()=>{
 const s=setup(),old=s.memory.applyProposal(root,s.proposal(),s.c.generation,'evidence_extract')!;
 s.store.database.prepare('UPDATE memory_sources SET data=? WHERE id=?').run(JSON.stringify({...s.source,modern:true,memoryRefs:[{recordId:old.recordId,revision:old.revision}]}),s.source.id);
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...old,status:'superseded',revision:2}),old.recordId);
 s.store.database.prepare("UPDATE memory_record_scope SET status='superseded' WHERE record_id=?").run(old.recordId);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({stage})=>stage==='extract'?[s.proposal('发布必须人工验收。')]:[]});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'conflict',error:null});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});
 expect(s.memory.listAll(root,{status:'active'}).map(r=>r.text)).toEqual(['发布必须人工验收。']);
});
test('a retraction-only scene pass commits cleanup and leaves new facts for the next pass',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,s.proposal(),s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...s.proposal(),layer:'L2',semanticKey:'scene.package',support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 createMemoryScenes(s.memory).commit(s.c.id,[fact],new Date().toISOString());
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...scene,status:'stale'}),scene.recordId);
 s.store.database.prepare("UPDATE memory_record_scope SET status='stale' WHERE record_id=?").run(scene.recordId);
 const fresh=s.memory.applyProposal(root,s.proposal('发布必须人工验收。'),s.c.generation,'evidence_extract')!;s.stage('scene');let calls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return input.drafts!;
  calls++;
  if(calls===1)return [{...s.proposal(),layer:'L2',semanticKey:'scene.package',operation:'retract',replaces:[{recordId:scene.recordId,revision:scene.revision}],evidence:[],support:[],dependencies:[]}];
  expect(input.records.some(r=>r.recordId===scene.recordId)).toBe(false);
  return [{...s.proposal('发布必须人工验收。'),layer:'L2',semanticKey:'scene.release',support:[],dependencies:[{recordId:fresh.recordId,revision:fresh.revision}]}];
 }});
 expect(await pipeline.runNext('w')).toMatchObject({state:'queued',stage:'scene',error:null});
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(scene.recordId)!.data as string).status).toBe('retracted');
 expect(s.store.database.prepare("SELECT revision FROM memory_scene_cursors WHERE record_id=? AND kind='scene'").get(fresh.recordId)).toBeUndefined();
 expect(await pipeline.runNext('w')).toMatchObject({error:null});
 expect(s.store.database.prepare("SELECT revision FROM memory_scene_cursors WHERE record_id=? AND kind='scene'").get(fresh.recordId)?.revision).toBe(fresh.revision);
});
test('a stale scene with no surviving evidence can still be retracted',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,s.proposal(),s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...s.proposal(),layer:'L2',semanticKey:'scene.package',support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...fact,status:'retracted',revision:2}),fact.recordId);
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...scene,status:'stale'}),scene.recordId);s.stage('scene');
 s.store.database.prepare("UPDATE memory_record_scope SET status='retracted' WHERE record_id=?").run(fact.recordId);
 s.store.database.prepare("UPDATE memory_record_scope SET status='stale' WHERE record_id=?").run(scene.recordId);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{expect(input.records.find(r=>r.recordId===scene.recordId)?.dependencies).toEqual([]);return input.stage==='verify'?input.drafts!:[{...s.proposal(),layer:'L2',semanticKey:'scene.package',operation:'retract',replaces:[{recordId:scene.recordId,revision:scene.revision}],evidence:[],support:[],dependencies:[]}];}});
 expect(await pipeline.runNext('w')).toMatchObject({state:'completed',error:null});
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(scene.recordId)!.data as string).status).toBe('retracted');
});
test.each(['缺少日期 /synthetic/server/recall.ts 的预算为6000。','2026-10-07 /synthetic/server/wrong.ts 的预算为6000。'])('file observation review rejects %s before it can block valid atoms',async text=>{
 const s=setup();s.store.database.prepare('DELETE FROM memory_jobs').run();
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 const user=s.store.appendEvent(chat.id,'user',{text:'项目使用 pnpm。'},'2026-10-07T00:00:00Z');
 const tool=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'read',command:'cat server/recall.ts',cwd:'/synthetic',status:'completed',exitCode:0,aggregatedOutput:'const budget = 6000;'}}},'2026-10-07T00:00:00Z');s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const supported={...s.proposal(),evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:user.id,quote:'项目使用 pnpm。'}]};
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return [supported,{...supported,text,support:[{sourceId:source.id,eventId:tool.id,quote:'const budget = 6000;'}]}];
  if(input.stage==='verify'){expect(input.draftIssues).toEqual([{index:1,reason:'unsupported_extract'}]);return [input.drafts![0]];}
  return input.atoms!;
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'conflict',error:null});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});
 expect(s.memory.listAll(root,{status:'active'}).map(r=>r.text)).toEqual(['项目使用 pnpm。']);
});

test('invalid scene references are rejected before semantic review and only the failed draft is repaired with precise feedback',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,s.proposal(),s.c.generation,'evidence_extract')!;s.stage('scene');
 const scene={...s.proposal(),layer:'L2' as const,semanticKey:'scene.package',support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]};
 let generations=0,reviews=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){reviews++;return input.drafts!;}
  generations++;
  if(generations===1)return [scene,{...scene,semanticKey:'scene.invalid',dependencies:[{recordId:'unprovided-record',revision:1}]}];
  expect(input.job.error).toBe('dependency_not_provided');
  expect(input.job.errorDetail).toContain('unprovided-record');
  expect(buildMemoryPrompt(input)).toContain('unprovided-record');
  expect(input.repairDrafts).toHaveLength(1);return [{...scene,semanticKey:'scene.invalid'}];
 }});
 const rejected=await pipeline.runNext('w');
 expect(reviews).toBe(0);expect(rejected).toMatchObject({state:'queued',error:'dependency_not_provided',outputFailures:1});
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(0);
 expect(await pipeline.runNext('w',rejected!.availableAt)).toMatchObject({error:null});
 expect(await pipeline.runNext('w',rejected!.availableAt)).toMatchObject({error:null});
 expect(generations).toBe(2);expect(reviews).toBe(2);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(2);
});
test('successful verification checkpoints do not erase the stage failure budget',()=>{
 const s=setup();s.stage('scene');let now=new Date().toISOString();
 for(let failures=1;failures<=2;failures++){
  let job=s.jobs.claim('w',now)!;
  s.jobs.advance(job,'scene',now);job=s.jobs.claim('w',now)!;
  s.jobs.fail(job.id,job.leaseToken,'verification_no_result',now);
  const result=createMemoryJobs(s.store,s.memory).list(root)[0];expect(result).toMatchObject({state:failures<2?'queued':'failed',outputFailures:failures});now=result.availableAt;
 }
 expect(s.jobs.claim('w',now)).toBeNull();
});
test('verification claims are not counted as failed model outputs',()=>{
 const s=setup();s.stage('scene');const now=new Date().toISOString(),initial=s.jobs.list(root)[0];
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...initial,attempt:19}),initial.id);
 const job=s.jobs.claim('w',now)!;s.jobs.fail(job.id,job.leaseToken,'verification_no_result',now);
 expect(s.jobs.list(root)[0]).toMatchObject({state:'queued',attempt:20,outputFailures:1});
});
test('repeated model timeouts stop after two failures',()=>{
 const s=setup();let now=new Date().toISOString();
 for(let failures=1;failures<=2;failures++){
  const job=s.jobs.claim('w',now)!;s.jobs.fail(job.id,job.leaseToken,'generation_timed_out',now);
  const result=createMemoryJobs(s.store,s.memory).list(root)[0];expect(result).toMatchObject({state:failures<2?'queued':'failed',outputFailures:failures});now=result.availableAt;
 }
 expect(s.jobs.claim('w',now)).toBeNull();
});

test('a successful stage transition preserves the job failure budget',()=>{
 const s=setup(),now=new Date().toISOString();let job=s.jobs.claim('w',now)!;
 s.jobs.fail(job.id,job.leaseToken,'verification_no_result',now);job=s.jobs.claim('w',s.jobs.list(root)[0].availableAt)!;
 s.jobs.advance(job,'conflict',s.jobs.list(root)[0].availableAt);
 expect(s.jobs.list(root)[0]).toMatchObject({stage:'conflict',outputFailures:0,failureCount:1,error:null});
});

test('resuming a legacy tool-heavy checkpoint regenerates text input instead of consuming old atoms',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];
 const {inputVersion:_,...legacy}=job as typeof job & {inputVersion?:string};
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...legacy,stage:'conflict',extraction:{nextChunk:9,totalChunks:15}}),job.id);
 let calls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{calls++;expect(input.stage).toBe('extract');return [];}});
 s.store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(job.id,JSON.stringify({atoms:[s.proposal('旧工具草稿')],nextAtom:0}));
 s.store.database.prepare('INSERT INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify([s.proposal('旧工具草稿')]));
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null,extraction:{nextChunk:1,totalChunks:1}});
 expect(calls).toBe(1);expect(s.memory.listAll(root,{status:'active'})).toEqual([]);
 expect(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(job.id)).toBeUndefined();
});

test.each(['request','session'] as const)('%s pipeline captures raw tools but sends only selected text and exact user evidence to the model',async kind=>{
 const s=setup();s.store.database.prepare('DELETE FROM memory_jobs').run();
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 const user=s.store.appendEvent(chat.id,'user',{text:'项目使用 pnpm。'});
 s.store.appendEvent(chat.id,'text',{text:'助手解释。\n```ts\nCODE_NOISE\n```\n结论未验收。'});
 s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'large',command:'cat huge.log',cwd:'/synthetic',status:'completed',exitCode:0,aggregatedOutput:'TOOL_NOISE'.repeat(27000)}}});
 s.store.appendEvent(chat.id,'status',{status:'idle'});
 const capture=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind}),source=capture.sources[0],raw=JSON.stringify(source);
 expect(capture.jobs[0]).toMatchObject({state:'queued',error:null});expect(capture.pendingReason).toBeNull();
 let extracts=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract'||input.stage==='verify'){
   expect(JSON.stringify(input.sources)).not.toContain('TOOL_NOISE');expect(JSON.stringify(input.context)).not.toContain('CODE_NOISE');
   expect(input.sources.flatMap(s=>s.events).map(e=>e.kind)).toEqual(['user','text']);
   if(input.stage==='extract')extracts++;
   const proposals=input.stage==='verify'?input.drafts!:[{...s.proposal(),evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:user.id,quote:'项目使用 pnpm。'}]}];
   return kind==='session'?{proposals,summary:'用户确认项目使用 pnpm；助手结论未验证。'}:proposals;
  }
  return [];
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'conflict',extraction:{nextChunk:0,totalChunks:1},error:null});
 expect(await pipeline.runNext('w')).toMatchObject({stage:kind==='session'?'consolidate':'scene',extraction:{nextChunk:1,totalChunks:1},error:null});
 expect(extracts).toBe(1);expect(s.memory.listAll(root,{status:'active'}).map(r=>r.text)).toEqual(['项目使用 pnpm。']);
 expect(JSON.stringify(s.memory.source(root,source.id))).toBe(raw);
});

test('a source completed by another job removes obsolete cached drafts when deduplicated',async()=>{
 const s=setup(),original=s.jobs.list(root)[0];
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...original,state:'completed'}),original.id);
 const job={...original,id:'overlap',stage:'conflict',state:'queued'};
 s.store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,'overlap',JSON.stringify(job));
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>{throw new Error('already published sources must not generate');}});
 for(const table of ['memory_extraction_drafts','memory_output_drafts','memory_output_verifications'])s.store.database.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(job.id,'{}');
 expect(await pipeline.runNext('w')).toMatchObject({id:job.id,state:'completed'});
 for(const table of ['memory_extraction_drafts','memory_output_drafts','memory_output_verifications'])expect(s.store.database.prepare(`SELECT data FROM ${table} WHERE job_id=?`).get(job.id)).toBeUndefined();
});


test.each(['replaces','evidence'])('malformed conflict %s is bounded as invalid model output rather than an unclassified TypeError',async missing=>{
 const s=setup(),old=s.memory.applyProposal(root,s.proposal(),s.c.generation,'evidence_extract')!;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return [s.proposal()];
  const bad={...s.proposal(),operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}]} as any;
  delete bad[missing];return [bad];
 }});
 await pipeline.runNext('w');let now=new Date().toISOString();
 for(let attempt=1;attempt<=2;attempt++){
  const result=await pipeline.runNext('w',now);expect(result).toMatchObject({error:'invalid_proposal',state:attempt<2?'queued':'failed',outputFailures:attempt});now=result!.availableAt;
 }
});

test('discarded sources stay discarded when text filtering changes how requests are grouped',()=>{
 const s=setup(),old=s.jobs.list(root)[0];
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...old,state:'obsolete',error:'user_discarded'}),old.id);
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 s.store.appendEvent(chat.id,'user',{text:'新请求确认项目采用中文报告。'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const fresh=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const jobs=s.memory.enqueue(root,s.c,[s.source,fresh],true,[],'request');
 expect(jobs.flatMap(j=>j.sourceRefs)).toEqual([{sourceId:fresh.id,sourceRevision:fresh.revision}]);
 expect(s.jobs.list(root).find(j=>j.id===old.id)).toMatchObject({state:'obsolete',error:'user_discarded'});
});
