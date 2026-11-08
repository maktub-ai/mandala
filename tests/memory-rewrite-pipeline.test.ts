import {DomainError} from '../shared/workspace-contracts';
import { afterEach, expect, test, vi } from 'vitest';
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
import {createMemoryRecall} from '../server/memory-recall';
import {createMemoryScenes} from '../server/memory-scenes';
import {buildMemoryPrompt} from '../server/memory-prompts';
import { memoryExtractionBatches } from '../server/memory-chunks';
const root={userId:'local'};
const cleanup:(()=>void)[]=[];
afterEach(()=>{vi.useRealTimers();cleanup.splice(0).forEach(fn=>fn());});
function setup(text='这个项目使用 pnpm。') {
 const home=mkdtempSync(join(tmpdir(),'memory-rewrite-pipeline-')),store=openStore(home),assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local'}),jobs=createMemoryJobs(store,memory),c=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 const input=store.appendEvent(chat.id,'user',{text});
 store.appendEvent(chat.id,'text',{text:'收到。'});store.appendEvent(chat.id,'status',{status:'idle'});
 const capture=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 return {store,memory,jobs,c,chat,input,source:capture.sources[0]};
}
test('canonical numeric event IDs from a saved native draft normalize without changing evidence identity',async()=>{
 const s=setup(),job=s.jobs.list(root)[0],proposal={collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:String(s.input.id),quote:s.source.events[0].text}],validUntil:null,certainty:'observed'};
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async({stage,drafts})=>{
  expect(stage).toBe('verify');return drafts!.map(p=>({...p,support:p.support?.map(ref=>({...ref,eventId:String(ref.eventId) as unknown as number}))}));
 }});
 s.store.database.prepare('INSERT INTO memory_output_drafts VALUES(?,?)').run(job.id,JSON.stringify([proposal]));
 expect(await pipeline.runNext('w')).toMatchObject({stage:'conflict',error:null});
 await pipeline.runNext('w');expect(s.memory.listAll(root,{status:'active'})).toEqual([expect.objectContaining({text:proposal.text,support:[expect.objectContaining({eventId:s.input.id})]})]);
});
test.each(['01','1.0','-1','9007199254740992','99999'])('invalid or unknown native event ID %s cannot become evidence',async id=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>[{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:id as unknown as number,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'}]});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'extract',error:'unsupported_extract'});expect(s.memory.listAll(root,{status:'active'})).toEqual([]);
});
test('semantic review receives exact citation failures instead of retrying a poisoned draft',async()=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return [{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'项目使用 pnpm',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'项目  使用 pnpm'}],validUntil:null,certainty:'observed'}];
  expect(input.draftIssues).toEqual([{index:0,reason:'unsupported_extract'}]);return [];
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});expect(s.memory.listAll(root,{status:'active'})).toEqual([]);
});
test('semantic review rejects a fabricated quote from an excluded conversation tool',async()=>{
 const s=setup();s.store.database.prepare('DELETE FROM memory_jobs').run();const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});s.store.appendEvent(chat.id,'user',{text:'检查记忆源码。'});const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'mixed',command:'cat server/one.ts server/two.ts',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:'const budget = 6000;'}}});s.store.appendEvent(chat.id,'status',{status:'idle'});const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return [{collectionId:s.c.id,layer:'L1',contentType:'fact',text:`${e.createdAt.slice(0,10)} /synthetic/worktree/server/two.ts 定义6000字符预算。`,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:e.id,quote:'const budget = 6000;'}],validUntil:null,certainty:'observed'}];
  expect(input.draftIssues).toEqual([{index:0,reason:'unsupported_extract'}]);return [];
 }});expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});expect(s.memory.listAll(root,{status:'active'})).toEqual([]);
});
test('derived semantic audit receives only exact bounded proof for its atomic dependencies',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});s.store.appendEvent(chat.id,'user',{text:'检查检索预算。'});const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'budget',command:'cat server/recall.ts',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:'if (size + length > 6000) continue;\nUNRELATED_PRIVATE_BODY'}}});s.store.appendEvent(chat.id,'status',{status:'idle'});const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:`${e.createdAt.slice(0,10)} /synthetic/worktree/server/recall.ts 跳过超出预算的条目。`,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:e.id,quote:'if (size + length > 6000) continue;'}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const prompt=buildMemoryPrompt({job:s.jobs.list(root).at(-1)!,sources:[source],records:[fact],stage:'verify',reviewStage:'scene',drafts:[],signal:new AbortController().signal});expect(prompt).toContain('if (size + length > 6000) continue;');expect(prompt).toContain('/synthetic/worktree/server/recall.ts');expect(prompt).not.toContain('UNRELATED_PRIVATE_BODY');
});
test('derived audit preserves complete selected quotes instead of silently dropping long evidence',()=>{
 const text='事实长引用'.repeat(1800),s=setup(text),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'项目事实。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const prompt=buildMemoryPrompt({job:s.jobs.list(root)[0],sources:[s.source],records:[fact],stage:'verify',reviewStage:'scene',drafts:[],signal:new AbortController().signal});const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);expect(data.recordEvidence[0].support[0].quote).toBe(text);expect(data.records[0].support).toBeUndefined();expect(data.sources[0].text).toBe('');
});
test('derived audit cannot treat unrelated facts or stale replacement narratives as supporting proof',()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const unrelated={...fact,recordId:'unrelated',text:'UNRELATED_DEFAULT_VALUE'},stale={...fact,recordId:'stale-scene',layer:'L2' as const,status:'stale' as const,text:'INVALID_OLD_NARRATIVE'};
 const draft={collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:'使用 pnpm。',operation:'update' as const,replaces:[{recordId:stale.recordId,revision:stale.revision}],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const};
 const prompt=buildMemoryPrompt({job:s.jobs.list(root)[0],sources:[s.source],records:[fact,unrelated,stale],stage:'verify',reviewStage:'scene',drafts:[draft],signal:new AbortController().signal});
 const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);expect(data.records.map((r:any)=>r.recordId)).toEqual([fact.recordId]);expect(data.recordEvidence.map((r:any)=>r.recordId)).toEqual([fact.recordId]);expect(prompt).not.toContain('UNRELATED_DEFAULT_VALUE');expect(prompt).not.toContain('INVALID_OLD_NARRATIVE');
});
test('long sources run bounded extraction chunks and persist a fact from the final chunk',async()=>{
 const fact='本项目的正式发布必须经过人工验收。',s=setup('背景材料。'.repeat(7000)+fact),seen:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,sources,stage,context})=>{
  if(stage!=='extract')return [];
  expect(context?.requests[0]).toContain('背景材料。');
  const part=sources[0].events.find(e=>e.id===s.input.id)?.text??'';seen.push(part);
  expect(Array.from(sources[0].text).length).toBeLessThanOrEqual(24000);
  if(!part.includes(fact))return [];
  return [{collectionId:job.collectionId,layer:'L1',contentType:'constraint',text:fact,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:s.source.revision}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:fact}],validUntil:null,certainty:'user_asserted'}];
 }});
 for(let step=0;step<10;step++){const result=await pipeline.runNext('w');if(!result)break;}
 expect(seen.length).toBeGreaterThan(1);
 expect(seen.join('')).toBe(s.source.events.find(e=>e.id===s.input.id)!.text);
 expect(s.jobs.list(root)[0]).toMatchObject({state:'queued',stage:'scene',error:'scene_no_result'});
 expect(s.memory.listAll(root)).toEqual([expect.objectContaining({text:fact,layer:'L1'})]);
});
test('extraction checkpoints resume after failure without replaying successful chunks',async()=>{
 const s=setup('合成资料。'.repeat(7000));let calls=0;
 let pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>{calls++;if(calls===2)throw new Error('quota_exhausted');return [];}});
 await pipeline.runNext('w');const checkpoint=s.jobs.list(root)[0];expect(checkpoint.extraction?.nextChunk).toBe(1);
 await pipeline.runNext('w');const failed=s.jobs.list(root)[0];expect(failed.extraction).toEqual(checkpoint.extraction);expect(failed.error).toBe('quota_exhausted');
 const resumed:string[]=[];pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({stage,sources})=>{if(stage==='extract')resumed.push(sources[0].events[0].text);return [];}});
 for(let step=0;step<10;step++){const result=await pipeline.runNext('w',failed.availableAt);if(!result)break;}
 expect(s.jobs.list(root)[0].state).toBe('completed');expect(resumed.join('')).toBe(s.source.events[0].text.slice(17968));
});
test('a rejected immutable proposal retains supported facts without retrying the invalid atom',async()=>{
 const s=setup(),evidence=[{sourceId:s.source.id,sourceRevision:s.source.revision}],support=[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job})=>[
  {collectionId:job.collectionId,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence,support,validUntil:null,certainty:'user_asserted'},
  {collectionId:job.collectionId,scope:'user',layer:'L1',contentType:'preference',text:'用户在所有项目偏好 pnpm。',operation:'store',replaces:[],evidence,support,validUntil:null,certainty:'user_asserted'},
 ]});
 expect(await pipeline.runNext('w')).toMatchObject({state:'queued',stage:'conflict',error:null});
 expect(await pipeline.runNext('w')).toMatchObject({state:'failed',stage:'conflict',error:'unsupported_user_scope'});
 expect(s.memory.listAll(root)).toEqual([expect.objectContaining({text:'这个项目使用 pnpm。'})]);
});
test('ready session work is claimed before a newer request continuation',()=>{
 const s=setup();s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});
 const now=new Date().toISOString(),first=s.jobs.claim('w',now)!;expect(first.kind).toBe('request');
 const later=new Date(Date.parse(now)+1000).toISOString();s.jobs.advance(first,'scene',later);
 expect(s.jobs.claim('w',later)!.kind).toBe('session');
});
test('ordinary request derives L2 from facts and does not generate L3 without a valid scene',async()=>{
 const s=setup();const stages:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,records,sources,stage})=>{
  stages.push(stage);
  if(stage!=='extract')return [];
  return [{collectionId:job.collectionId,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence:[{sourceId:sources[0].id,sourceRevision:sources[0].revision}],support:[{sourceId:sources[0].id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],semanticKey:'project.package_manager',validUntil:null,certainty:'user_asserted'}];
 }});
 await pipeline.runNext('w');await pipeline.runNext('w');await pipeline.runNext('w');await pipeline.runNext('w');
 expect(stages).toEqual(['extract','scene']);
 expect(s.memory.listAll(root).filter(r=>r.status==='active')).toEqual([expect.objectContaining({layer:'L1',text:'这个项目使用 pnpm。',verification:'evidence_extract',pipelines:['request']})]);
 expect(s.memory.listAll(root).some(r=>r.verification==='stage_summary')).toBe(false);
});
test('model timeout is durable retryable work, not completed with a shadow error',async()=>{
 const s=setup();vi.useFakeTimers();
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{timeoutMs:10000,generate:async()=>await new Promise(()=>{})});
 const pending=pipeline.runNext('w');await vi.advanceTimersByTimeAsync(10001);const result=await pending;
 expect(result).toMatchObject({state:'queued',error:'generation_timed_out'});
 expect(s.memory.listAll(root)).toEqual([]);expect(s.jobs.list(root)[0].sourceRefs).toHaveLength(1);
});
test('disable during processing leaves generation pending and commits nothing',async()=>{
 const s=setup();const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>{throw new Error('memory_generation_disabled');}});
 expect(await pipeline.runNext('w')).toMatchObject({state:'queued',error:'memory_generation_disabled'});
 expect(s.memory.listAll(root)).toEqual([]);
});
test('project hook can extract and derive source-Agent private experience without leaking to project readers',async()=>{
 const s=setup();const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),text='我的个人经验是排查时先检查日志。',event=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,stage,sources,records})=>{
  const source=sources.find(source=>source.conversationId===chat.id);if(!source)return [];if(stage==='profile'){const scene=records.find(r=>r.layer==='L2');return scene?[{collectionId:job.collectionId,semanticKey:'persona.operating-doctrine',layer:'L3',contentType:'procedure',text,support:[],operation:'store',replaces:[],evidence:scene.evidence,dependencies:[{recordId:scene.recordId,revision:scene.revision}],validUntil:null,certainty:'observed'}]:[];}
  const facts=records.filter(record=>record.layer==='L1'&&record.text===text);
  return [{collectionId:job.collectionId,scope:'agent',semanticKey:stage==='extract'?'private.experience':'scene.private.experience',layer:stage==='extract'?'L1':'L2',contentType:'procedure',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:stage==='extract'?[]:facts.map(({recordId,revision})=>({recordId,revision})),validUntil:null,certainty:'user_asserted'}];
 }});
 for(let step=0;step<10;step++)await pipeline.runNext('w');
 expect(s.jobs.list(root).every(job=>job.error===null),JSON.stringify(s.jobs.list(root))).toBe(true);
 const personal=s.memory.list({userId:'local',agentId:'a'},{projectId:'p',status:'active'}).filter(r=>r.text===text);expect(personal.map(r=>r.layer).sort()).toEqual(['L1','L2']);expect(s.memory.profile({userId:'local',agentId:'a'},{projectId:null,agentId:'a'})).toMatchObject({layer:'L3',text});expect(s.memory.profile({userId:'local',agentId:'a'},{projectId:'p',agentId:'a'})).toBeNull();
 expect(s.memory.list({userId:'local',agentId:'b'},{projectId:'p',status:'active'}).some(r=>r.text===text)).toBe(false);
 expect(s.jobs.list(root).every(job=>job.state==='completed')).toBe(true);
});

test('extraction input excludes recalled context without erasing original L0',()=>{
 const s=setup(),source={...s.source,events:[{...s.source.events[0],kind:'tool',contextOnly:true,text:'过时的旧记忆'}],text:'工具结果: 过时的旧记忆'};
 const batches=memoryExtractionBatches([source]);
 expect(batches.flat().map(s=>s.text).join('')).not.toContain('过时的旧记忆');
 expect(batches.flat().flatMap(s=>s.events)).toEqual([]);
 expect(source.text).toContain('过时的旧记忆');
});


test('conflict decisions have a separate ranked input and retry persisted atoms without extracting again',async()=>{
 const s=setup(),old='这个项目使用 pnpm。',fresh='这个项目改用 bun。';
 s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:old,semanticKey:'project.package_manager',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:s.source.revision}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:old}],validUntil:null,certainty:'user_asserted'},s.c.generation,'evidence_extract');
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),event=s.store.appendEvent(chat.id,'user',{text:fresh});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];let extracts=0,conflicts=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{
  if(input.stage==='extract'){expect(input.records).toEqual([]);extracts++;if(!input.sources.some(x=>x.id===source.id))return [];return [{collectionId:s.c.id,layer:'L1',contentType:'fact',text:fresh,semanticKey:'project.package_manager',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:fresh}],validUntil:null,certainty:'user_asserted'}];}
  if(input.stage==='conflict'){conflicts++;expect(input.atoms?.[0].text).toBe(fresh);expect(input.records).toEqual([expect.objectContaining({text:old})]);if(conflicts===1)throw new Error('quota_exhausted');return [{...input.atoms![0],operation:'update',replaces:input.records.map(({recordId,revision})=>({recordId,revision})),explicitChange:true}];}
  return [];
 }});
 for(let i=0;i<8;i++){const job=await pipeline.runNext('w');if(job?.error==='quota_exhausted')break;}
 const failed=s.jobs.list(root).find(j=>j.error==='quota_exhausted')!;expect(failed.stage).toBe('conflict');expect(failed).toBeDefined();
 const before=extracts;for(let i=0;i<6;i++)await pipeline.runNext('w',failed.availableAt);
 expect(extracts).toBe(before);expect(conflicts).toBe(2);
 expect(s.memory.listAll(root).filter(r=>r.status==='active'&&r.layer==='L1').map(r=>r.text)).toEqual([fresh]);
});


test('later atoms retrieve newly written facts in the same batch',async()=>{
 const s=setup('项目使用 pnpm。项目改用 bun。'),seen:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,stage,atoms,records})=>{
  if(stage==='extract')return ['项目使用 pnpm。','项目改用 bun。'].map(text=>({collectionId:job.collectionId,layer:'L1' as const,contentType:'fact' as const,text,semanticKey:'package.manager',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:s.source.revision}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:text}],validUntil:null,certainty:'user_asserted' as const}));
  if(stage==='conflict'){seen.push(records[0].text);return [{...atoms![0],operation:'update',replaces:records.map(({recordId,revision})=>({recordId,revision})),explicitChange:true}];}return [];
 }});await pipeline.runNext('w');await pipeline.runNext('w');expect(seen).toEqual(['项目使用 pnpm。']);expect(s.memory.listAll(root).filter(r=>r.layer==='L1'&&r.status==='active').map(r=>r.text)).toEqual(['项目改用 bun。']);
});

test('an empty scene response never consumes new fact revisions',async()=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,stage})=>stage==='extract'?[{collectionId:job.collectionId,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:s.source.revision}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'user_asserted'}]:[]});
 await pipeline.runNext('w');await pipeline.runNext('w');const result=await pipeline.runNext('w');expect(result).toMatchObject({state:'queued',stage:'scene',error:'scene_no_result'});expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_scene_cursors').get()?.n).toBe(0);
});


test('actual conflict prompt includes only the primary quote and bounded candidates',()=>{
 const s=setup('无关资料。'.repeat(40000)+'项目使用 pnpm。'),job=s.jobs.list(root)[0],atom={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:'项目使用 pnpm。',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'项目使用 pnpm。'}],validUntil:null,certainty:'observed' as const};
 const prompt=buildMemoryPrompt({job,sources:[s.source],records:[],stage:'conflict',signal:new AbortController().signal,atoms:[atom]});expect(prompt.length).toBeLessThan(18000);expect(prompt).not.toContain('无关资料。');expect(prompt).toContain('项目使用 pnpm。');
});

test('semantic duplicate skip preserves shared-chain provenance and independent session reading',async()=>{
 const s=setup(),first={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:'本项目用 pnpm 管理依赖。',semanticKey:'package.manager',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed' as const,pipeline:'request' as const};const record=s.memory.applyProposal(root,first,s.c.generation,'evidence_extract')!;
 s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({job,stage,atoms,records})=>{
  if(stage==='extract')return {proposals:[{...first,pipeline:undefined,text:'项目的依赖管理器是 pnpm。'}],summary:'项目用 pnpm 管理依赖。'};
  if(stage==='conflict')return [{...atoms![0],operation:'skip',skipReason:'duplicate',replaces:[{recordId:records[0].recordId,revision:records[0].revision}]}];return [];
 }});for(let i=0;i<5;i++)await pipeline.runNext('w');const canonical=s.memory.listAll(root).find(r=>r.recordId===record.recordId)!;expect(canonical.status).toBe('active');expect(canonical.text).toBe(first.text);expect(canonical.pipelines).toContain('session');expect(s.memory.listAll(root).filter(r=>r.layer==='L1'&&r.status==='active')).toHaveLength(1);
});


test('semantic verification rejection commits no unsupported fact and permits an empty valid extraction',async()=>{
 const s=setup(),stages:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async({job,stage})=>{
  stages.push(stage);return stage==='extract'?[{collectionId:job.collectionId,layer:'L1',contentType:'fact',text:'项目禁止使用 npm。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed'}]:[];
 }});expect(await pipeline.runNext('w')).toMatchObject({state:'queued',stage:'scene',error:null});expect(stages).toEqual(['extract','verify']);expect(s.memory.listAll(root)).toEqual([]);
});

test('session summaries are independently verified even when there are no atomic facts',async()=>{
 const s=setup('今天只需要帮我看一下界面。');s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});const stages:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async(input)=>{
  stages.push(input.stage);if(input.stage==='extract')return {proposals:[],summary:'用户禁止任何自动发布。'};
  if(input.stage==='verify'){expect((input as unknown as {draftSummary:string}).draftSummary).toBe('用户禁止任何自动发布。');return {proposals:[],summary:'用户本次请求检查界面。'};}return [];
 }});await pipeline.runNext('w');await pipeline.runNext('w');expect(stages).toContain('verify');expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_session_summaries').get()!.data as string).text).toBe('用户本次请求检查界面。');
});

test('verification retries the persisted draft and cannot change its operation or factual identity',async()=>{
 const s=setup();let extracts=0,verifications=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async(input)=>{
  if(input.stage==='extract'){extracts++;return [{collectionId:input.job.collectionId,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed'}];}
  if(input.stage==='verify'){verifications++;if(verifications===1)throw new Error('quota_exhausted');return input.drafts!.map(d=>({...d,contentType:'constraint'}));}return [];
 }});const failed=await pipeline.runNext('w');expect(failed?.error).toBe('quota_exhausted');const retried=await pipeline.runNext('w',failed!.availableAt);expect(retried?.error).toBe('verification_identity_changed');expect(extracts).toBe(1);expect(s.memory.listAll(root)).toEqual([]);
});
test('verification compares reference identities independently of JSON property order',async()=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return [{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'}];
  if(input.stage==='verify')return input.drafts!.map(d=>({...d,evidence:d.evidence.map(ref=>({sourceRevision:ref.sourceRevision,sourceId:ref.sourceId}))}));return [];
 }});expect(await pipeline.runNext('w')).toMatchObject({stage:'conflict',error:null});await pipeline.runNext('w');expect(s.memory.listAll(root,{status:'active'})).toHaveLength(1);
});
test('derived proposals are audited separately and successful checks survive the next audit failure',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const j=s.jobs.list(root)[0];s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene') WHERE id=?").run(j.id);
 const audits:string[]=[];let fail=true;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){expect(input.drafts).toHaveLength(1);const key=input.drafts![0].semanticKey!;audits.push(key);if(key==='scene.second'&&fail){fail=false;throw new Error('quota_exhausted');}return input.drafts!;}
  return ['scene.first','scene.second'].map(semanticKey=>({collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:semanticKey+' 使用 pnpm。',semanticKey,operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const}));
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',state:'queued'});expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(0);
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('quota_exhausted');await pipeline.runNext('w',failed!.availableAt);
 expect(audits).toEqual(['scene.first','scene.second','scene.second']);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(2);
});
test('a compatible evidence append retains the old draft dependency proof on audit retry',async()=>{
 const s=setup(),p={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:s.source.events[0].text,semanticKey:'project.manager',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed' as const},fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();let first=true;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){if(first){first=false;throw new Error('quota_exhausted');}const data=JSON.parse(buildMemoryPrompt(input).split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);expect(data.records.map((r:any)=>r.recordId)).toContain(fact.recordId);expect(data.recordEvidence.map((r:any)=>r.recordId)).toContain(fact.recordId);return input.drafts!;}
  return [{collectionId:s.c.id,layer:'L2',contentType:'fact',text:'项目采用 pnpm。',semanticKey:'scene.manager',operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}];
 }});const failed=await pipeline.runNext('w');
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),e=s.store.appendEvent(chat.id,'user',{text:p.text});s.store.appendEvent(chat.id,'status',{status:'idle'});const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'session'}).sources[0];s.memory.applyProposal(root,{...p,evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:e.id,quote:p.text}]},s.c.generation,'evidence_extract');
 s.memory.validateReferences(root,{projectId:'p',items:[{recordId:fact.recordId,revision:fact.revision}]});expect(await pipeline.runNext('w',failed!.availableAt,['request'])).toMatchObject({stage:'profile',error:null});
});
test('derived provenance comes from validated dependencies when the model omits redundant evidence',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>input.stage==='verify'?input.drafts!:[{collectionId:s.c.id,layer:'L2',contentType:'fact',text:'项目采用 pnpm。',semanticKey:'scene.manager',operation:'store',replaces:[],evidence:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}]});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'profile',error:null});expect(s.memory.listAll(root,{status:'active'}).find(r=>r.layer==='L2')?.evidence).toEqual(fact.evidence);
});
test('private derived provenance is resolved before Agent scope initialization without sharing it',async()=>{
 const s=setup('我的个人经验，仅供我，不要共享：排查前先比对本地样例。'),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',scope:'agent',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>input.stage==='verify'?input.drafts!:[{collectionId:s.c.id,layer:'L2',scope:'agent',contentType:'fact',text:'个人排查经验：先比对本地样例。',semanticKey:'scene.private',operation:'store',replaces:[],evidence:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}]});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',state:'completed',error:null});expect(s.jobs.list(root).some(j=>j.stage==='profile'&&j.profileScope?.projectId===null&&j.profileScope.agentId==='a')).toBe(true);const record=s.memory.listAll(root,{status:'active'}).find(r=>r.layer==='L2')!;expect(record.collectionId).toBe(fact.collectionId);expect(record.evidence).toEqual(fact.evidence);expect(()=>s.memory.read({userId:'local',agentId:'b'},record.recordId,null)).toThrow();
});
test('an impossible replacement keeps a repairable draft instead of freezing its invalid operation',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!,job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let generations=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{if(input.stage==='verify')return input.drafts!;generations++;return [{collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'scene.package',text:'项目采用 pnpm。',operation:generations===1?'update':'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}];}});
 const first=await pipeline.runNext('w');expect(first?.error).toBe('invalid_replacement');expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_output_drafts').get()?.n).toBe(1);await pipeline.runNext('w',first!.availableAt);expect(generations).toBe(2);expect(s.memory.listAll(root,{status:'active'}).some(r=>r.layer==='L2')).toBe(true);
});


test('oversized session dependency closure is consolidated across batches before its summary is acknowledged',async()=>{
 const texts=['甲项目约定'+ '甲'.repeat(9800),'乙项目约定'+ '乙'.repeat(9800)],s=setup(texts.join('。')),facts=texts.map(text=>s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{expect(buildMemoryPrompt(input).length).toBeLessThan(45000);const prior=input.records.find(r=>r.semanticKey==='session.context');return [{collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'session.context',text:(prior?.text??'')+input.records.filter(r=>r.layer==='L1').map(r=>r.text.slice(0,6)).join('；'),operation:prior?'update':'store',replaces:prior?[{recordId:prior.recordId,revision:prior.revision}]:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision})),validUntil:null,certainty:'observed'}];}});
 const job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,kind:'session',stage:'consolidate'}),job.id);s.store.database.prepare('INSERT INTO memory_session_summaries VALUES(?,?,?,?)').run('summary',s.c.id,s.chat.id,JSON.stringify({conversationId:s.chat.id,text:'甲乙两项项目约定。',evidence:[{sourceId:s.source.id,sourceRevision:1}],dependencies:facts.map(({recordId,revision})=>({recordId,revision}))}));
 expect(await pipeline.runNext('w')).toMatchObject({state:'queued',stage:'consolidate',error:null});expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_consolidation_cursors').get()?.n).toBe(0);expect(await pipeline.runNext('w')).toMatchObject({state:'completed',error:null});expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_consolidation_cursors').get()?.n).toBe(1);expect(s.memory.listAll(root).find(r=>r.layer==='L2'&&r.status==='active')?.dependencies).toHaveLength(2);
});

test('summary coverage accepts evidence-only compatible revision advances',async()=>{
 const s=setup(),proposal={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:'这个项目使用 pnpm。',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed' as const,pipeline:'request' as const};const old=s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')!;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>[{collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'session.context',text:'项目使用 pnpm。',operation:'store',replaces:[],evidence:proposal.evidence,dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision})),validUntil:null,certainty:'observed'}]});
 const current=s.memory.applyProposal(root,{...proposal,pipeline:'session'},s.c.generation,'evidence_extract')!;expect(current.revision).toBeGreaterThan(old.revision);
 const job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,kind:'session',stage:'consolidate'}),job.id);s.store.database.prepare('INSERT INTO memory_session_summaries VALUES(?,?,?,?)').run('summary',s.c.id,s.chat.id,JSON.stringify({conversationId:s.chat.id,text:'项目使用 pnpm。',evidence:proposal.evidence,dependencies:[{recordId:old.recordId,revision:old.revision}]}));
 expect(await pipeline.runNext('w')).toMatchObject({state:'completed',error:null});expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_consolidation_cursors').get()?.n).toBe(1);
});


test('compatible fact evidence appends are covered by an unchanged persisted scene anchor',async()=>{
 const s=setup(),proposal={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:'这个项目使用 pnpm。',operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed' as const,pipeline:'request' as const};const first=s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:'scene.package',support:[],dependencies:[{recordId:first.recordId,revision:first.revision}]},s.c.generation,'layer_summary')!;
 const newer=s.memory.applyProposal(root,{...proposal,pipeline:'session'},s.c.generation,'evidence_extract')!;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>[{...proposal,layer:'L2',semanticKey:'scene.package',support:[],dependencies:[{recordId:newer.recordId,revision:newer.revision}]}]});const job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);
 const result=await pipeline.runNext('w');expect(result?.error).toBeNull();expect(s.store.database.prepare("SELECT revision FROM memory_scene_cursors WHERE kind='scene' AND record_id=?").get(first.recordId)?.revision).toBe(newer.revision);expect(s.memory.read(root,scene.recordId,'p').dependencies[0].revision).toBe(first.revision);
});


test('scene navigation counts real recall hits without changing semantic revisions',()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L2',contentType:'fact',text:'这个项目使用 pnpm。',semanticKey:'scene.package',operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},s.c.generation,'layer_summary')!;
 const scenes=createMemoryScenes(s.memory),recall=createMemoryRecall(s.memory);const before=JSON.parse(scenes.prepare(s.c.id,s.memory.listAll(root)).index)[0].heat;expect(recall.search(root,{projectId:'p',query:'pnpm',layers:['L2']}).items).toHaveLength(1);expect(JSON.parse(scenes.prepare(s.c.id,s.memory.listAll(root)).index)[0].heat).toBe(before+1);expect(s.memory.read(root,scene.recordId,'p').revision).toBe(scene.revision);
});


test('explicit stable preference requests trigger profile refresh, ordinary facts still extract automatically',()=>{
 const ordinary=setup(),explicit=setup('请记住：以后用中文回答');expect(ordinary.jobs.list(root)[0].personaRequested).toBe(false);expect(explicit.jobs.list(root)[0].personaRequested).toBe(true);expect(ordinary.jobs.list(root)[0].stage).toBe('extract');
});


test('a cold profile with a valid scene cannot report success while generating no stable context',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'这个项目使用 pnpm。',operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:'这个项目使用 pnpm。'}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L2',contentType:'fact',text:'这个项目使用 pnpm。',semanticKey:'scene.package',operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},s.c.generation,'layer_summary');
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>[]}),job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'profile'}),job.id);expect(await pipeline.runNext('w')).toMatchObject({state:'queued',stage:'profile',error:'profile_no_result'});
});

test('evidence-only append advances compatible scene and profile cursors without rewriting derived layers',()=>{
 const s=setup(),p={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:s.source.events[0].text,operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed' as const},fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!,scenes=createMemoryScenes(s.memory);
 scenes.commit(s.c.id,[fact],'before');scenes.profileCommitted(s.c.id,[fact],'before');
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),event=s.store.appendEvent(chat.id,'user',{text:p.text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const appended=s.memory.applyProposal(root,{...p,evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:p.text}]},s.c.generation,'evidence_extract')!;
 expect(appended.revisionKind).toBe('evidence_append');expect(scenes.prepare(s.c.id,[appended]).newFacts).toEqual([]);
 expect(s.store.database.prepare('SELECT revision FROM memory_scene_cursors WHERE kind=?').get('scene')?.revision).toBe(appended.revision);
 expect(s.store.database.prepare('SELECT revision FROM memory_scene_cursors WHERE kind=?').get('profile')?.revision).toBe(appended.revision);
 const corrected=s.memory.correct(root,{recordId:appended.recordId,expectedRevision:appended.revision,text:'这个项目改用 npm。'});
 expect(s.memory.compatibleRevision({recordId:corrected.recordId,revision:fact.revision},{...corrected,revisionKind:'evidence_append'})).toBe(false);
 expect(scenes.prepare(s.c.id,[corrected]).newFacts).toEqual([corrected]);
});

test('semantic rejection retries only the rejected derived audit and retains the already checked item',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();let generated=0,second=0;const audits:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){const key=input.drafts![0].semanticKey!;audits.push(key);if(key==='scene.second'&&second++===0)return [];return input.drafts!;}
  generated++;return ['scene.first','scene.second'].map(semanticKey=>({collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:semanticKey+' 使用 pnpm。',semanticKey,operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const}));
 }});
 await pipeline.runNext('w');const failed=await pipeline.runNext('w');expect(failed?.error).toBe('verification_no_result');
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({stage:'profile',error:null});expect(generated).toBe(1);expect(audits).toEqual(['scene.first','scene.second','scene.second']);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(2);
});

test('audited exact no-change scene acknowledges only facts already present in its valid dependencies',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const draft={collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:'项目使用 pnpm。',semanticKey:'scene.manager',operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const},scene=s.memory.applyProposal(root,draft,s.c.generation,'layer_summary')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>input.stage==='verify'?input.drafts!:[{...draft,operation:'skip',replaces:[{recordId:scene.recordId,revision:scene.revision}]}]});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'profile',error:null});expect(s.memory.read(root,scene.recordId).revision).toBe(1);
 expect(s.store.database.prepare('SELECT revision FROM memory_scene_cursors WHERE record_id=?').get(fact.recordId)?.revision).toBe(fact.revision);
});

test('engineering rejection regenerates only its failed item while retaining the checked scene',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();let initial=0,repairs=0;const audited:string[]=[];
 const valid=(semanticKey:string)=>({collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:semanticKey+' 使用 pnpm。',semanticKey,operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){audited.push(input.drafts![0].semanticKey!);return input.drafts!;}
  if(input.repairDrafts){repairs++;expect(input.repairDrafts).toHaveLength(1);expect(input.repairDrafts[0].semanticKey).toBe('scene.second');return [valid('scene.second')];}
  initial++;return [valid('scene.first'),{...valid('scene.second'),dependencies:[{recordId:'not-provided',revision:1}]}];
 }});
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('dependency_not_provided');
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({stage:'scene',error:null});expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({stage:'profile',error:null});expect(initial).toBe(1);expect(repairs).toBe(1);expect(audited).toEqual(['scene.first','scene.second']);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(2);
});

test('no-change cannot cover a newly supplied fact absent from the old scene',()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const p={collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:'项目采用 pnpm。',semanticKey:'scene.manager',operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const},scene=s.memory.applyProposal(root,p,s.c.generation,'layer_summary')!;
 const extra=s.memory.applyProposal(root,{...p,layer:'L1',text:'项目使用固定工作区。',semanticKey:'project.workspace',support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],dependencies:[]},s.c.generation,'evidence_extract')!;
 expect(()=>s.memory.applyProposal(root,{...p,operation:'skip',replaces:[{recordId:scene.recordId,revision:scene.revision}],dependencies:[...p.dependencies,{recordId:extra.recordId,revision:extra.revision}]},s.c.generation,'layer_summary')).toThrow('unsupported_no_change');
});

test('profile evidence progress advances independently from scene progress without hiding an earlier correction',()=>{
 const s=setup(),p={collectionId:s.c.id,layer:'L1' as const,contentType:'fact' as const,text:s.source.events[0].text,operation:'store' as const,replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed' as const},fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!,scenes=createMemoryScenes(s.memory);
 scenes.commit(s.c.id,[fact],'before');scenes.profileCommitted(s.c.id,[fact],'before');
 const append=(text:string)=>{const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),e=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];return s.memory.applyProposal(root,{...p,text,evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:e.id,quote:text}]},s.memory.collection(root,s.c.id).generation,'evidence_extract')!;};
 const second=append(p.text);scenes.commit(s.c.id,[second],'after-scene');const third=append(p.text);expect(scenes.prepare(s.c.id,[third]).newFacts).toEqual([]);
 expect(s.store.database.prepare("SELECT revision FROM memory_scene_cursors WHERE kind='profile'").get()?.revision).toBe(third.revision);
 const corrected=s.memory.correct(root,{recordId:third.recordId,expectedRevision:third.revision,text:'这个项目改用 npm。'});scenes.commit(s.c.id,[corrected],'corrected-scene');const corroborated=append(corrected.text);scenes.prepare(s.c.id,[corroborated]);
 expect(s.store.database.prepare("SELECT revision FROM memory_scene_cursors WHERE kind='profile'").get()?.revision).toBe(third.revision);
 expect(s.memory.compatibleRevision({recordId:fact.recordId,revision:fact.revision},corroborated)).toBe(false);
});


test('a malformed local repair exhausts the retry budget without replacing an earlier valid draft',async()=>{
 const s=setup(),fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:s.source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:s.source.id,sourceRevision:1}],support:[{sourceId:s.source.id,eventId:s.input.id,quote:s.source.events[0].text}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 s.store.database.prepare("UPDATE memory_jobs SET data=json_set(data,'$.stage','scene')").run();const repairKeys:string[]=[];
 const valid=(semanticKey:string)=>({collectionId:s.c.id,layer:'L2' as const,contentType:'fact' as const,text:semanticKey+' 使用 pnpm。',semanticKey,operation:'store' as const,replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed' as const});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return input.drafts!;
  if(input.repairDrafts){repairKeys.push(input.repairDrafts[0].semanticKey!);if(repairKeys.length===1)throw new DomainError('invalid_memory_generation',422,'invalid_memory_generation');return [valid('scene.second')];}
  return [valid('scene.first'),{...valid('scene.second'),dependencies:[{recordId:'not-provided',revision:1}]}];
 }});
 const first=await pipeline.runNext('w'),second=await pipeline.runNext('w',first!.availableAt);expect(second?.error).toBe('invalid_memory_generation');
 expect(second).toMatchObject({state:'failed',failureCount:2});expect(await pipeline.runNext('w',second!.availableAt)).toBeNull();expect(repairKeys).toEqual(['scene.second']);
 const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_drafts WHERE job_id=?').get(first!.id)!.data as string);expect(saved[0].semanticKey).toBe('scene.first');
});
