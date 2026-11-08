import {readConfiguredRuntime} from './configured-runtime';
import {expect,test} from 'vitest';
import {memoryReviewCandidates,decodeMemoryReview} from '../server/memory-prompts';
import type {MemoryGeneratorInput} from '../server/memory-pipeline';
import type {MemoryProposal,MemoryRevision} from '../shared/memory';
import {createMemoryRuntime} from '../server/memory-runtime';
import {openStore} from '../server/store';

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const proposal=(text:string):MemoryProposal=>({collectionId:'collection',layer:'L2',contentType:'fact',text,semanticKey:`scene.${text}`,operation:'store',replaces:[],evidence:[{sourceId:'source',sourceRevision:1}],support:[],dependencies:[{recordId:'fact',revision:1}],validUntil:null,certainty:'observed'});
const input=(drafts:MemoryProposal[],batch=false):MemoryGeneratorInput=>({stage:'verify',reviewStage:'scene',job:{id:'job',collectionId:'collection',principal:{userId:'local'},sourceRefs:[],generation:7,state:'running',attempt:1,leaseToken:3,leaseUntil:null,workerId:'test',availableAt:'',createdAt:'',error:null,extractorVersion:'test'},sources:[],records:[],drafts,signal:new AbortController().signal,...batch?{batchItems:drafts.map((draft,i)=>({id:`job:scene:${i}`,draft,records:[]}))}:{}});
const packet=(candidate:{id:string;digest:string},decision:'accept'|'revise'|'reject',proposal?:MemoryProposal)=>({decisions:[{...candidate,decision,...proposal?{proposal}:{}}]});
test('accept returns exact held candidate; revise carries full content; reject uses omission',()=>{
 const draft=proposal('first'),request=input([draft]),[candidate]=memoryReviewCandidates(request);
 expect(decodeMemoryReview(request,packet(candidate,'accept'))).toEqual([draft]);
 const changed={...draft,text:'revised'};expect(decodeMemoryReview(request,packet(candidate,'revise',changed))).toEqual([changed]);
 expect(decodeMemoryReview(request,packet(candidate,'reject'))).toEqual([]);
 expect(decodeMemoryReview(request,[changed])).toEqual([changed]);
});
test('packet rejects missing, unknown, duplicate, stale, mixed and extra accept fields',()=>{
 const request=input([proposal('first'),proposal('second')],true),[a,b]=memoryReviewCandidates(request),accept=(c:typeof a)=>({...c,decision:'accept'});
 for(const bad of [
  {decisions:[accept(a)]},
  {decisions:[accept(a),accept(a)]},
  {decisions:[accept(a),accept({...b,id:'wrong'})]},
  {decisions:[accept(a),accept({...b,digest:'0'.repeat(64)})]},
  {decisions:[{...accept(a),proposal:proposal('forged')},accept(b)]},
  {decisions:[{...accept(a),extra:true},accept(b)]},
  {decisions:[{...a,decision:'revise'},accept(b)]},
  {decisions:[{...a,decision:'reject',proposal:proposal('forged')},accept(b)]},
  {decisions:[accept(a),accept(b)],proposals:[]},
 ])expect(()=>decodeMemoryReview(request,bad)).toThrow();
});
test('complete batch packet rejects each stale job, stage, generation, lease and held draft binding',()=>{
 const request=input([proposal('first'),proposal('second')],true),[a,b]=memoryReviewCandidates(request),complete={decisions:[{...a,decision:'accept'},{...b,decision:'accept'}]};
 expect(decodeMemoryReview(request,complete)).toEqual(request.drafts!.map((draft,i)=>({...draft,batchItemId:request.batchItems![i].id})));
 const changed:MemoryGeneratorInput[]=[
  {...request,job:{...request.job,id:'new-job'}},
  {...request,reviewStage:'profile'},
  {...request,job:{...request.job,generation:8}},
  {...request,job:{...request.job,leaseToken:4}},
  {...request,batchItems:request.batchItems!.map((item,i)=>i?item:{...item,draft:{...item.draft!,text:'changed'}})},
 ];
 for(const stale of changed){
  expect(memoryReviewCandidates(stale).map(candidate=>candidate.id)).toEqual([a.id,b.id]);
  expect(()=>decodeMemoryReview(stale,complete)).toThrow();
 }
});
test('batch identity attaches only its own held draft and does not permit cross-item revisions',()=>{
 const drafts=[proposal('first'),proposal('second')],request=input(drafts,true),[a,b]=memoryReviewCandidates(request);
 expect(decodeMemoryReview(request,{decisions:[{...a,decision:'accept'},{...b,decision:'accept'}]})).toEqual(drafts.map((draft,i)=>({...draft,batchItemId:`job:scene:${i}`})));
 expect(()=>decodeMemoryReview(request,{decisions:[{...a,decision:'revise',proposal:{...drafts[1],batchItemId:b.id}},{...b,decision:'accept'}]})).toThrow();
});
test('session packet preserves separate reviewed summary and missing summary still fails',()=>{
 const request={...input([proposal('first')]),reviewStage:'extract' as const,job:{...input([]).job,kind:'session' as const}},[candidate]=memoryReviewCandidates(request);
 expect(decodeMemoryReview(request,{decisions:[{...candidate,decision:'accept'}],summary:'Reviewed independently.'})).toEqual({proposals:[request.drafts![0]],summary:'Reviewed independently.'});
 expect(decodeMemoryReview(request,{decisions:[{...candidate,decision:'accept'}]})).toEqual({proposals:[request.drafts![0]]});
});
test('packet accept passes the real runtime pipeline and persists only source-backed facts',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-review-packet-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config;
 const calls:string[]=[];
 const generate=async(_config:unknown,prompt:string)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);calls.push(data.stage);
  if(data.stage==='verify')return JSON.stringify({decisions:data.reviewCandidates.map((candidate:{id:string;digest:string},i:number)=>data.reviewStage==='scene'?{...candidate,decision:'revise',proposal:{...data.drafts[i],text:'Use pnpm in this project.'}}:{...candidate,decision:'accept'})});
  if(data.stage==='extract')return JSON.stringify(data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').map((event:any)=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies:[],validUntil:null,certainty:'user_asserted'}))));
  if(data.stage==='scene')return JSON.stringify(data.records.filter((record:any)=>record.layer==='L1').map((record:any)=>({collectionId:data.collectionId,layer:'L2',contentType:'fact',semanticKey:'scene.packet',text:record.text+' UNVERIFIED_CLAIM',operation:'store',replaces:[],evidence:record.evidence,support:[],dependencies:[{recordId:record.recordId,revision:record.revision}],validUntil:null,certainty:'observed'})));
  if(data.stage==='profile')return JSON.stringify(data.records.filter((record:any)=>record.layer==='L2').map((record:any)=>({collectionId:data.collectionId,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',text:record.text,operation:'store',replaces:[],evidence:record.evidence,support:[],dependencies:[{recordId:record.recordId,revision:record.revision}],validUntil:null,certainty:'observed'})));
  return '[]';
 };
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,generate,schedule:false,verifyOutput:true});
 try{
  await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:'Use pnpm in this project.'});store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);
  const captured=await runtime.captureConversation(chat.id);await runtime.drain();
  const job=runtime.jobs.list({userId:'local'}).find(item=>item.id===captured.jobs[0]?.id);
  expect(job?.state,JSON.stringify({job,calls})).toBe('completed');expect(calls).toContain('verify');
  const facts=runtime.memory.listAll({userId:'local'},{status:'active'}),atom=facts.find(fact=>fact.layer==='L1'&&fact.text==='Use pnpm in this project.'),scene=facts.find(fact=>fact.layer==='L2'&&fact.semanticKey==='scene.packet');
  expect(atom?.support).toEqual([{sourceId:captured.sources[0].id,eventId:1,quote:'Use pnpm in this project.'}]);expect(scene?.text).toBe('Use pnpm in this project.');expect(scene?.dependencies).toEqual([{recordId:atom!.recordId,revision:atom!.revision}]);expect(facts.every(fact=>!fact.text.includes('UNVERIFIED_CLAIM'))).toBe(true);
 }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test('packet accept cannot bless a project-local preference as global user scope',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-review-scope-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config;
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:true,generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage==='verify')return JSON.stringify({decisions:data.reviewCandidates.map((candidate:{id:string;digest:string})=>({...candidate,decision:'accept'}))});
  if(data.stage==='extract')return JSON.stringify(data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').map((event:any)=>({collectionId:data.collectionId,layer:'L1',contentType:'preference',scope:'user',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies:[],validUntil:null,certainty:'user_asserted'}))));
  return '[]';
 }});
 try{
  await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:'For this project, I always prefer pnpm.'});store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);
  const captured=await runtime.captureConversation(chat.id);await runtime.drain();
  expect(runtime.jobs.list({userId:'local'}).find(job=>job.id===captured.jobs[0]?.id)?.error).toBe('unsupported_user_scope');
  expect(runtime.memory.listAll({userId:'local'},{status:'active'})).toEqual([]);
 }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test.each([
 ['unexpected_summary','invalid_memory_generation'],
 ['reject_extract',null],
 ['reject_scene','verification_no_result'],
 ['correct_await','generation_changed'],
 ['retract_await','generation_changed'],
 ['source_await','generation_changed'],
 ['permission_await','synthetic_forbidden'],
] as const)('packet %s preserves review and source fences',async(mode,expectedError)=>{
 const home=mkdtempSync(join(tmpdir(),'memory-review-fence-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config,root={userId:'local'};
 const targetText='Use pnpm in this project.';let denied=false,mutated=false,sceneReviewed=false,targetSourceId='',targetSourceRevision=0;
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:true,authorizeConversationRead:()=>{if(denied)throw new Error('synthetic_forbidden');},generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage==='verify'){
   if(data.reviewStage==='scene'&&!mutated){
    sceneReviewed=true;await Promise.resolve();
    if(mode==='correct_await'||mode==='retract_await'){
     const fact=runtime.memory.listAll(root,{status:'active'}).find(record=>record.layer==='L1'&&record.text===targetText)!;
     if(mode==='correct_await')runtime.memory.correct(root,{recordId:fact.recordId,expectedRevision:fact.revision,text:'Use pnpm only after approval.'});
     else runtime.memory.retract(root,{recordId:fact.recordId,expectedRevision:fact.revision});
     mutated=true;
    }else if(mode==='source_await'){runtime.memory.retractSource(root,{sourceId:targetSourceId,expectedRevision:targetSourceRevision});mutated=true;}
    else if(mode==='permission_await'){denied=true;mutated=true;}
   }
   return JSON.stringify({...mode==='unexpected_summary'?{summary:'Unreviewed independent summary'}:{},decisions:data.reviewCandidates.map((candidate:{id:string;digest:string})=>({...candidate,decision:mode==='reject_extract'&&data.reviewStage==='extract'||mode==='reject_scene'&&data.reviewStage==='scene'?'reject':'accept'}))});
  }
  if(data.stage==='extract'){
   const proposals=data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').map((event:any)=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies:[],validUntil:null,certainty:'user_asserted'})));
   return JSON.stringify(proposals);
  }
  if(data.stage==='scene')return JSON.stringify(data.records.filter((record:any)=>record.layer==='L1'&&record.text===targetText).map((record:any)=>({collectionId:data.collectionId,layer:'L2',contentType:'fact',semanticKey:'scene.packet',text:record.text,operation:'store',replaces:[],evidence:record.evidence,support:[],dependencies:[{recordId:record.recordId,revision:record.revision}],validUntil:null,certainty:'observed'})));
  return '[]';
 }});
 try{
  await runtime.initialize();let unrelated:MemoryRevision|undefined;
  if(['correct_await','retract_await','source_await','permission_await'].includes(mode)){
   const collection=runtime.memory.ensureCollection(root,{projectId:null,agentId:null});
   const unrelatedChat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),unrelatedEvent=store.appendEvent(unrelatedChat.id,'user',{text:'Keep CI logs.'});store.appendEvent(unrelatedChat.id,'status',{status:'idle'});
   const seed=runtime.memory.captureConversation(root,{collectionId:collection.id,conversationId:unrelatedChat.id,trigger:'explicit',kind:'request'});
   for(const job of seed.jobs)store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'obsolete',error:'synthetic_seed'}),job.id);
   unrelated=runtime.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:'Keep CI logs.',operation:'store',replaces:[],evidence:[{sourceId:seed.sources[0].id,sourceRevision:seed.sources[0].revision}],support:[{sourceId:seed.sources[0].id,eventId:unrelatedEvent.id,quote:'Keep CI logs.'}],dependencies:[],validUntil:null,certainty:'user_asserted'},collection.generation,'evidence_extract')!;
  }
  const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:targetText});store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);
  const captured=await runtime.captureConversation(chat.id,'explicit','request');targetSourceId=captured.sources[0].id;targetSourceRevision=captured.sources[0].revision;
  await runtime.drain();denied=false;
  const job=JSON.parse(store.database.prepare('SELECT data FROM memory_jobs WHERE id=?').get(captured.jobs[0].id)!.data as string);
  const records=store.database.prepare('SELECT data FROM memory_records').all().map(row=>JSON.parse(row.data as string));
  expect(job.error).toBe(expectedError);if(mode==='reject_extract')expect(job.state).toBe('completed');
  if(['reject_scene','correct_await','retract_await','source_await','permission_await'].includes(mode))expect(sceneReviewed).toBe(true);
  expect(records.filter(record=>record.layer==='L2')).toEqual([]);
  if(mode==='reject_extract'||mode==='unexpected_summary')expect(records.some(record=>record.layer==='L1'&&record.evidence.some((ref:{sourceId:string})=>ref.sourceId===targetSourceId))).toBe(false);
  if(unrelated)expect(records.find(record=>record.recordId===unrelated.recordId)).toMatchObject({revision:unrelated.revision,status:'active',text:unrelated.text,contentHash:unrelated.contentHash});
 }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
});
test('revising A with rejected B cannot publish B when unbatched drafts share coarse identity',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-review-cross-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config;
 let reviewed=false;
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:true,generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage==='extract')return JSON.stringify(data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').flatMap((event:any)=>['Use pnpm in project Alpha.','Use yarn in project Beta.'].map(text=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',semanticKey:'project.package-manager',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'})))));
  if(data.stage==='verify'&&data.reviewStage==='extract'){
   expect(data.drafts).toHaveLength(2);reviewed=true;
   return JSON.stringify({decisions:[{...data.reviewCandidates[0],decision:'revise',proposal:data.drafts[1]},{...data.reviewCandidates[1],decision:'reject'}]});
  }
  return '[]';
 }});
 try{
  await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text:'Use pnpm in project Alpha. Use yarn in project Beta.'});store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);
  const captured=await runtime.captureConversation(chat.id);await runtime.drain();
  const facts=runtime.memory.listAll({userId:'local'},{status:'active'}),job=runtime.jobs.list({userId:'local'}).find(item=>item.id===captured.jobs[0].id);
  expect(reviewed).toBe(true);expect(facts.some(fact=>fact.layer==='L1'&&fact.text==='Use yarn in project Beta.')).toBe(false);expect(job?.error).toBe('invalid_memory_generation');
 }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
});
