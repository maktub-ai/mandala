import {readConfiguredRuntime} from './configured-runtime';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryScenes} from '../server/memory-scenes';
import {openStore} from '../server/store';

import {createMemoryRuntime,memoryServices} from '../server/memory-runtime';
import {createMemoryPipeline,type MemoryGeneratorInput} from '../server/memory-pipeline';
import {buildMemoryRequest,decodeMemoryReview,memoryReviewCandidates} from '../server/memory-prompts';
import type {MemoryProposal} from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(authorize?:()=>void){
 const home=mkdtempSync(join(tmpdir(),'memory-partial-')),store=openStore(home),{memory,jobs}=memoryServices(home,store,authorize),c=memory.ensureCollection(root,{projectId:null,agentId:null});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),text=Array.from({length:9},(_,i)=>`Project rule ${i} is confirmed.`).join(' '),event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=captured.sources[0],job=captured.jobs[0];
 const drafts:MemoryProposal[]=Array.from({length:9},(_,i)=>({collectionId:c.id,layer:'L1',contentType:'fact',text:`Project rule ${i} is confirmed.`,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:`Project rule ${i} is confirmed.`}],dependencies:[],validUntil:null,certainty:'user_asserted'}));
 const next=async(pipeline:ReturnType<typeof createMemoryPipeline>)=>{const j=jobs.list(root).find(j=>j.id===job.id)!;return pipeline.runNext('worker',new Date(Math.max(Date.now(),Date.parse(j.availableAt))).toISOString());};
 const checkpoint=(table:string)=>{const row=store.database.prepare(`SELECT data FROM ${table} WHERE job_id=?`).get(job.id);return row?JSON.parse(row.data as string):null;};
 return {store,memory,jobs,c,source,job,drafts,next,checkpoint};
}
function decode(input:MemoryGeneratorInput,result:unknown):any{
 const request=buildMemoryRequest(input),envelope=request.validateEnvelope(input,result);
 return decodeMemoryReview(input,envelope.value,envelope.expandProposal);
}
test('retains eight bound extraction decisions and retries only original candidate nine',async()=>{
 const s=setup(),reviews:MemoryGeneratorInput[]=[],pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return s.drafts;
  reviews.push(input);const decisions=memoryReviewCandidates(input).map((candidate,i)=>({...candidate,decision:reviews.length===1&&i===2?'reject':'accept'}));if(reviews.length===1)decisions.pop();return decode(input,{decisions});
 }});
 expect(await s.next(pipeline)).toMatchObject({stage:'extract',error:'invalid_memory_generation'});
 expect(s.checkpoint('memory_extraction_drafts')).toBeNull();expect(s.memory.listAll(root)).toHaveLength(0);
 expect(await s.next(pipeline)).toMatchObject({stage:'conflict',error:null});
 expect(reviews.map(r=>r.drafts?.length)).toEqual([9,1]);expect(memoryReviewCandidates(reviews[1])[0].id).toBe(memoryReviewCandidates(reviews[0])[8].id);
 expect(memoryReviewCandidates(reviews[1])[0].digest).not.toBe(memoryReviewCandidates(reviews[0])[8].digest);
 expect(s.checkpoint('memory_extraction_drafts').atoms).toEqual(s.drafts.filter((_,i)=>i!==2));
});
test.each(['accept','reject','revise'] as const)('empty Scene recovery independently audits full existing skip: %s',async decision=>{
 const s=setup(),fact=s.memory.applyProposal(root,s.drafts[0],s.c.generation,'evidence_extract')!;
 const proposal:MemoryProposal={collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'scene.rules',text:fact.text,operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'};
 const scene=s.memory.applyProposal(root,proposal,s.c.generation,'layer_summary')!;
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'scene',extractorVersion:'test'}),s.job.id);
 let generation=0;const audits:MemoryProposal[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='scene'){generation++;return generation===1?[]:[{...proposal,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}]}];}
  if(input.stage==='verify'){audits.push(input.drafts![0]);const candidate=memoryReviewCandidates(input)[0];return decode(input,{decisions:[{...candidate,decision:input.drafts![0].operation==='skip'?decision:'accept',...input.drafts![0].operation==='skip'&&decision==='revise'?{proposal:{...input.drafts![0],text:'Illegal changed skip'}}:{}}]});}
  return [];
 }});
 expect(await s.next(pipeline)).toMatchObject({error:'scene_no_result'});expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
 expect(await s.next(pipeline)).toMatchObject({error:null});
 expect(audits[0]).toMatchObject({...proposal,operation:'skip',replaces:[{recordId:scene.recordId,revision:scene.revision}]});
 expect(generation).toBe(decision==='accept'?1:2);expect(audits).toHaveLength(decision==='accept'?1:2);
 expect(s.memory.read(root,scene.recordId,null).text).toBe(scene.text);expect(s.store.database.prepare("SELECT * FROM memory_scene_cursors WHERE kind='scene'").all()).toHaveLength(1);
});
test.each(['alias','digest','quote','missing_summary'] as const)('local %s failure preserves other decisions and separately reviews pending summary',async mode=>{
 const s=setup();if(mode==='missing_summary')s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,kind:'session',conversationId:s.source.conversationId}),s.job.id);
 const reviews:MemoryGeneratorInput[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return {proposals:s.drafts,summary:'Draft summary never implicitly accepted.'};
  reviews.push(input);const request=buildMemoryRequest(input),data=JSON.parse(request.prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  const decisions:any[]=memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}));
  if(reviews.length===1&&mode==='alias')decisions[8]={...decisions[8],decision:'revise',proposal:{...s.drafts[8],evidence:[{sourceId:{s:9999},sourceRevision:1}]}};
  if(reviews.length===1&&mode==='digest')decisions[8].digest='stale';
  if(reviews.length===1&&mode==='quote')decisions[8]={...decisions[8],decision:'revise',proposal:{...s.drafts[8],text:'',support:s.drafts[8].support}};
  const packet={decisions,...mode==='missing_summary'&&reviews.length===2?{summary:'Independently reviewed summary.'}:{}};
  return request.decode(input,data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result:packet}:packet) as any;
 }});
 expect((await s.next(pipeline))?.error).toBe(mode==='missing_summary'?'invalid_verified_summary':mode==='quote'?'invalid_proposal':'invalid_memory_generation');
 expect(Object.keys(s.checkpoint('memory_output_verifications').checked)).toHaveLength(mode==='missing_summary'?9:8);
 expect(await s.next(pipeline)).toMatchObject({stage:'conflict',error:null});expect(reviews.map(r=>r.drafts?.length)).toEqual([9,mode==='missing_summary'?0:1]);
 expect(reviews[1].sources).toEqual(reviews[0].sources);
 if(mode==='missing_summary'){expect(reviews[1].draftSummary).toBe('Draft summary never implicitly accepted.');expect(s.checkpoint('memory_extraction_drafts').summary).toBe('Independently reviewed summary.');}
});
test.each(['unknown','duplicate','mixed','forged'] as const)('ambiguous %s packet retains no decisions',async mode=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return s.drafts;
  const decisions=memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}));
  if(mode==='unknown')decisions[8].id='unknown';if(mode==='duplicate')decisions[8]=decisions[0];
  return decode(input,{decisions,...mode==='mixed'?{proposals:[]}:mode==='forged'?{checked:{},pending:[],summary:'forged',accepted:true}:{}});
 }});
 expect(await s.next(pipeline)).toMatchObject({error:'invalid_memory_generation'});expect(s.checkpoint('memory_output_verifications')).toBeNull();expect(s.checkpoint('memory_extraction_drafts')).toBeNull();
});
test('provider JSON cannot forge the opaque outcome through legacy metadata',async()=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>input.stage==='extract'?s.drafts:decode(input,{proposals:[],checked:Object.fromEntries(s.drafts.map((p,i)=>[`${s.job.id}:extract:${i}`,p])),decisionsState:'accepted',pending:[],summary:'unchecked'})});
 expect(await s.next(pipeline)).toMatchObject({stage:'scene',error:null});expect(s.checkpoint('memory_extraction_drafts')).toBeNull();expect(s.memory.listAll(root)).toEqual([]);
});
test('retained independent summary is omitted from candidate-only retry',async()=>{
 const s=setup();s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,kind:'session',conversationId:s.source.conversationId}),s.job.id);
 const reviews:MemoryGeneratorInput[]=[];const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='extract')return {proposals:s.drafts,summary:'draft'};
  reviews.push(input);const decisions=memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}));if(reviews.length===1)decisions.pop();return decode(input,{decisions,...reviews.length===1?{summary:'checked'}:{}});
 }});
 expect(await s.next(pipeline)).toMatchObject({error:'invalid_memory_generation'});expect(await s.next(pipeline)).toMatchObject({stage:'conflict',error:null});
 expect(reviews[1].reviewSummary).toBe(false);expect(reviews[1].draftSummary).toBeUndefined();expect(s.checkpoint('memory_extraction_drafts').summary).toBe('checked');
});
test.each(['source','generation','lease','cancel'] as const)('pending audit %s mutation cannot publish retained work',async mode=>{
 const s=setup(),controller=new AbortController();let reviews=0;const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,signal:controller.signal,generate:async input=>{
  if(input.stage==='extract')return s.drafts;
  reviews++;const decisions=memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}));if(reviews===1)decisions.pop();
  if(reviews===2){await Promise.resolve();if(mode==='source')s.memory.retractSource(root,{sourceId:s.source.id,expectedRevision:s.source.revision});
   if(mode==='generation'){const c=s.memory.collection(root,s.c.id);s.store.database.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify({...c,generation:c.generation+1}),c.id);}
   if(mode==='lease'){const job=s.jobs.list(root).find(j=>j.id===s.job.id)!;s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,leaseToken:job.leaseToken+1}),job.id);}
   if(mode==='cancel')controller.abort();}
  return decode(input,{decisions});
 }});
 expect(await s.next(pipeline)).toMatchObject({error:'invalid_memory_generation'});await s.next(pipeline);
 expect(reviews).toBe(2);expect(s.checkpoint('memory_extraction_drafts')).toBeNull();expect(s.memory.listAll(root)).toHaveLength(0);
});
test('real runtime decodes partial packets and retries only the unresolved extraction',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-partial-runtime-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config,reviews:number[]=[];
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:true,generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]),wrap=(result:unknown)=>JSON.stringify(data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result}:result);
  if(data.stage==='extract'){const source=data.sources[0],event=source.events.find((e:any)=>e.kind==='user');return wrap(Array.from({length:9},(_,i)=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',text:`Rule ${i} is confirmed.`,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:`Rule ${i} is confirmed.`}],dependencies:[],validUntil:null,certainty:'user_asserted'})));}
  if(data.stage==='conflict')return wrap(data.batchItems?data.batchItems.map((item:any)=>({...item.atom,batchItemId:item.id})):data.atoms);
  if(data.stage==='verify'&&data.reviewStage==='extract'){reviews.push(data.drafts.length);const decisions=data.reviewCandidates.map((c:any,i:number)=>({...c,decision:reviews.length===1&&i===2?'reject':'accept'}));if(reviews.length===1)decisions.pop();return wrap({decisions});}
  return '[]';
 }});
 try{
  await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:Array.from({length:9},(_,i)=>`Rule ${i} is confirmed.`).join(' ')});store.appendEvent(chat.id,'status',{status:'idle'});
  const captured=await runtime.captureConversation(chat.id);await runtime.drain();const job=runtime.jobs.list(root).find(j=>j.id===captured.jobs[0].id)!;
  expect(job.error).toBe('invalid_memory_generation');store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,availableAt:new Date(0).toISOString()}),job.id);await runtime.drain();
  expect(reviews).toEqual([9,1]);expect(runtime.memory.listAll(root).filter(r=>r.layer==='L1')).toHaveLength(8);
 }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test.each(['missing','reject_twice','source','correction','permission'] as const)('Scene recovery %s preserves coverage and fresh authority',async mode=>{
 let denied=false;const s=setup(()=>{if(denied)throw Error('synthetic_forbidden');}),fact=s.memory.applyProposal(root,s.drafts[0],s.c.generation,'evidence_extract')!;
 const proposal:MemoryProposal={collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'scene.rules',text:fact.text,operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},scene=s.memory.applyProposal(root,proposal,s.c.generation,'layer_summary')!;
 const unrelated=s.memory.applyProposal(root,s.drafts[1],s.c.generation,'evidence_extract')!;
 if(mode!=='missing')createMemoryScenes(s.memory).commit(s.c.id,[unrelated],new Date().toISOString());
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'scene',extractorVersion:'test'}),s.job.id);
 let generation=0,skipAudits=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='scene'){generation++;return generation===1||mode==='reject_twice'&&generation===2?[]:[{...proposal,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}],dependencies:input.sceneContext!.newFactRefs}];}
  if(input.stage==='verify'){
   const candidate=memoryReviewCandidates(input)[0];if(input.drafts![0].operation==='skip'){
    skipAudits++;await Promise.resolve();
    if(mode==='source')s.memory.retractSource(root,{sourceId:s.source.id,expectedRevision:s.source.revision});
    if(mode==='correction')s.memory.correct(root,{recordId:fact.recordId,expectedRevision:fact.revision,text:'Corrected rule.'});
    if(mode==='permission')denied=true;
    if(mode==='reject_twice')return decode(input,{decisions:[{...candidate,decision:'reject'}]});
   }
   return decode(input,{decisions:[{...candidate,decision:'accept'}]});
  }
  return [];
 }});
 expect(await s.next(pipeline)).toMatchObject({error:'scene_no_result'});const cursors=()=>s.store.database.prepare("SELECT * FROM memory_scene_cursors WHERE kind='scene'").all();const before=cursors().length;
 const result=await s.next(pipeline);denied=false;
 if(mode==='missing'){expect(skipAudits).toBe(0);expect(generation).toBe(2);expect(result?.error).toBeNull();}
 else if(mode==='reject_twice'){expect(result?.error).toBe('scene_no_result');expect(cursors()).toHaveLength(before);expect(result).toMatchObject({state:'failed',failureCount:2});expect(await s.next(pipeline)).toBeNull();expect(skipAudits).toBe(1);expect(generation).toBe(2);}
 else {expect(skipAudits).toBe(1);expect(generation).toBe(1);expect(result?.error).not.toBeNull();expect(cursors()).toHaveLength(before);}
 if(mode!=='source')expect(s.memory.read(root,unrelated.recordId,null)).toMatchObject({revision:unrelated.revision,text:unrelated.text,status:'active'});
});
