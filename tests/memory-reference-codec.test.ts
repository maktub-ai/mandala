import {expect,test} from 'vitest';
import * as prompts from '../server/memory-prompts';
import {memoryReferenceCodec} from '../server/memory-reference-codec';
import type {MemoryGeneratorInput} from '../server/memory-pipeline';
import type {MemoryProposal,MemorySource,MemoryRevision} from '../shared/memory';

const id='same-source-and-record-identity-000000000000000000000000000000';
const literal=`Literal ${id} {"s":0} {"r":0}`;
const draft:MemoryProposal={collectionId:'collection',layer:'L1',contentType:'fact',text:literal,operation:'store',replaces:[{recordId:id,revision:2},{recordId:id,revision:1},{recordId:id,revision:2}],evidence:[{sourceId:id,sourceRevision:3,startEventId:1,endEventId:8},{sourceId:id,sourceRevision:3}],support:[{sourceId:id,eventId:1,quote:literal},{sourceId:id,eventId:1,quote:literal}],dependencies:[{recordId:id,revision:2}],validUntil:null,certainty:'observed'};
function input():MemoryGeneratorInput {
 const source:MemorySource={id,revision:3,collectionId:'collection',kind:'conversation',conversationId:'chat',taskId:null,taskRevision:null,runIds:[],versions:[],events:[{id:1,kind:'user',text:literal,hash:'synthetic',createdAt:'2026-10-12',origin:{files:[id],cwd:literal}}],text:literal,observedAt:null,capturedAt:'2026-10-12',status:'ready',fingerprint:'synthetic',eventIds:[1],completionMarker:null};
 const record:MemoryRevision={...draft,recordId:id,revision:2,status:'active',dependencies:draft.dependencies!,observedAt:null,effectiveFrom:'2026-10-12',extractedAt:'2026-10-12',verification:'evidence_extract',taskId:null,conversationId:'chat',contentHash:'synthetic'};
 return {stage:'verify',reviewStage:'extract',job:{id:'job',collectionId:'collection',principal:{userId:'local'},sourceRefs:[{sourceId:id,sourceRevision:3}],generation:7,state:'running',attempt:1,leaseToken:3,leaseUntil:null,workerId:'test',availableAt:'',createdAt:'',error:null,extractorVersion:'test'},sources:[source],records:[record],drafts:Array.from({length:9},()=>structuredClone(draft)),signal:new AbortController().signal,context:{projectId:'p',requests:[literal],assistantReplies:[]}};
}
const sourceJSON=(prompt:string)=>JSON.parse(prompt.slice(prompt.indexOf('SOURCE_JSON:\n')+13,prompt.lastIndexOf('\nEND_SOURCE_JSON')));
test('typed references roundtrip all known roles without changing duplicate order, revision types or literals',()=>{
 const request=input(),canonical=sourceJSON(prompts.buildMemoryPrompt(request));
 const built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt);
 expect(encoded.referenceDictionary).toBeDefined();
 expect(encoded.drafts[0].evidence[0].sourceId).toEqual({s:0});
 expect(encoded.drafts[0].replaces[0].recordId).toEqual({r:0});
 expect(encoded.drafts[0].text).toBe(literal);expect(encoded.drafts[0].support[0].quote).toBe(literal);
 expect(encoded.sources[0].events).toEqual(canonical.sources[0].events);
 expect(built.restoreSource(encoded)).toEqual(canonical);
 expect(built.expand(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:encoded.drafts})).toEqual(request.drafts);
 expect(Buffer.byteLength(built.prompt)).toBeLessThan(Buffer.byteLength(prompts.buildMemoryPrompt(request)));
});
test('aliases require exact receipt and reject unknown, cross-type and conflicting identity objects',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),receipt=encoded.referenceDictionary.receipt;
 for(const reference of [{s:99},{r:0},{s:0,sourceId:id},{s:'0'},null]){
  const proposals=structuredClone(encoded.drafts);proposals[0].evidence[0].sourceId=reference;
  expect(()=>built.expand(request,{referenceReceipt:receipt,result:proposals})).toThrow('invalid_memory_generation');
 }
 expect(()=>built.expand(request,encoded.drafts)).toThrow('invalid_memory_generation');
 expect(()=>built.expand(request,{referenceReceipt:'wrong',result:encoded.drafts})).toThrow('invalid_memory_generation');
 expect(()=>built.expand(request,{referenceReceipt:receipt,result:encoded.drafts,proposals:[]})).toThrow('invalid_memory_generation');
 expect(built.expand(request,request.drafts)).toEqual(request.drafts);
});
test('reference failures identify the violated boundary without echoing model content',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),receipt=encoded.referenceDictionary.receipt;
 const cases:[unknown,string][]=[
  [{referenceReceipt:'private-value',result:[]},'reference_receipt_mismatch'],
  [{referenceReceipt:receipt,result:[],extra:'private-value'},'reference_envelope_shape'],
  [[{...draft,evidence:[{sourceId:{s:0},sourceRevision:3}]}],'reference_receipt_required'],
  [{referenceReceipt:receipt,result:[{...draft,evidence:[{sourceId:{s:99},sourceRevision:3}]}]},'reference_alias_range'],
  [{referenceReceipt:receipt,result:[{...draft,evidence:[{sourceId:{s:0},sourceRevision:99}]}]},'reference_revision_not_provided'],
 ];
 for(const [response,reason] of cases){
  expect(()=>built.expand(request,response)).toThrow(`invalid_memory_generation:${reason}`);
 }
});
test('receipt binds current source/record revision, job, principal, collection, generation, lease and candidates',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),response={referenceReceipt:encoded.referenceDictionary.receipt,result:encoded.drafts};
 const changes:((i:MemoryGeneratorInput)=>void)[]=[i=>i.sources[0].revision++,i=>i.records[0].revision++,i=>i.job.sourceRefs[0].sourceRevision++,i=>i.job.id='other',i=>i.job.principal.userId='other',i=>i.job.collectionId='other',i=>i.job.generation++,i=>i.job.leaseToken++,i=>i.drafts![0].text='changed'];
 for(const change of changes){const current=input();change(current);expect(()=>built.expand(current,response)).toThrow('invalid_memory_generation');}
});
test('review accept/revise/reject decode only after expansion and retain original digest/identity fences',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),candidates=prompts.memoryReviewCandidates(request);
 const decisions=candidates.map((candidate,i)=>({...candidate,decision:i===0?'revise':i===1?'reject':'accept',...i===0?{proposal:{...encoded.drafts[i],text:'Revised literal.'}}:{}}));
 const packet={decisions},expanded=built.expand(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:packet});
 const decoded=prompts.decodeMemoryReview(request,expanded) as MemoryProposal[];
 expect(decoded).toEqual([{...draft,text:'Revised literal.'},...request.drafts!.slice(2)]);
 expect(prompts.decodeMemoryReview(request,built.expand(request,{decisions:candidates.map(candidate=>({...candidate,decision:'accept'}))}))).toEqual(request.drafts);
 decisions[0].proposal={...encoded.drafts[0],operation:'merge'};
 expect(()=>prompts.decodeMemoryReview(request,built.expand(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:packet}))).toThrow();
});
test('tiny input retains canonical prompt when dictionary and instructions would grow the whole request',()=>{
 const request=input();request.drafts=[];request.sources=[];request.records=[];delete request.context;
 const built=prompts.buildMemoryRequest(request);
 expect(built.prompt).toBe(prompts.buildMemoryPrompt(request));
 expect(built.expand(request,[])).toEqual([]);
 expect(()=>built.expand(request,[{...draft,evidence:[{sourceId:{s:0},sourceRevision:3}]}])).toThrow();
});
test('aliased revisions must be supplied tuples while canonical legacy keeps existing validation',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),receipt=encoded.referenceDictionary.receipt;
 for(const [role,key] of [['evidence','sourceRevision'],['replaces','revision'],['dependencies','revision']] as const){
  const proposals=structuredClone(encoded.drafts);proposals[0][role][0][key]=999;
  expect(()=>built.expand(request,{referenceReceipt:receipt,result:proposals})).toThrow('invalid_memory_generation');
 }
 const legacy=structuredClone(request.drafts!);legacy[0].evidence[0].sourceRevision=999;
 expect(built.expand(request,legacy)).toEqual(legacy);
});

test('explicit source paths roundtrip summaries, atom/batch/repair, retained/reusable/context and arbitrary objects',()=>{
 const request=input(),canonical={sources:[{...request.sources[0],taskSnapshot:{sourceId:id,recordId:id,nested:{sourceId:{s:0}}},events:[{id:'1',text:literal,origin:{sourceId:id,recordId:id,evidence:[{sourceId:id}],nested:{recordId:{r:0}}}}]}],records:request.records,atoms:[draft],drafts:[draft],repairDrafts:[draft],reusableFacts:request.records,reusableSourceRefs:[{sourceId:id,sourceRevision:3}],retainedDependencies:[{recordId:id,revision:1}],verifiedDependencies:[{recordId:id,revision:2}],sceneContext:{index:literal,navigation:literal,newFactRefs:[{recordId:id,revision:2}]},context:{requests:[literal],requestRefs:[{sourceId:id,eventId:'1'}],assistantReplyRefs:[{sourceId:id,eventId:1}]},summaries:[{conversationId:id,text:literal,evidence:draft.evidence,dependencies:draft.dependencies}],batchItems:[{id,atom:draft,draft,recordRefs:[{recordId:id,revision:2}]}],recordEvidence:[{recordId:id,support:draft.support}],draftIssues:[{index:0,reason:literal}]};
 const codec=memoryReferenceCodec(request,canonical),encoded=codec.data as any;
 expect(codec.restoreSource(encoded)).toEqual(canonical);
 for(const refs of [encoded.summaries[0].evidence,encoded.batchItems[0].draft.evidence,encoded.repairDrafts[0].evidence,encoded.reusableSourceRefs,encoded.context.requestRefs,encoded.context.assistantReplyRefs])expect(refs[0].sourceId).toEqual({s:0});
 for(const refs of [encoded.summaries[0].dependencies,encoded.sceneContext.newFactRefs,encoded.verifiedDependencies,encoded.retainedDependencies,encoded.batchItems[0].recordRefs])expect(refs[0].recordId).toEqual({r:0});
 expect(encoded.sources[0].taskSnapshot).toEqual(canonical.sources[0].taskSnapshot);
 expect(encoded.sources[0].events).toEqual(canonical.sources[0].events);
 expect(encoded.context.requestRefs[0].eventId).toBe('1');expect(encoded.context.assistantReplyRefs[0].eventId).toBe(1);
 expect(encoded.sceneContext.index).toBe(literal);expect(encoded.sceneContext.navigation).toBe(literal);
 expect(encoded.batchItems[0].id).toBe(id);
});
test('validated envelope seam only expands supplied candidate and never manufactures an audited status',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),proposal=encoded.drafts[0];
 const envelope=built.validateEnvelope(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:{decisions:[]}});
 expect(envelope.value).toEqual({decisions:[]});expect(envelope.expandProposal(proposal)).toEqual(draft);
 expect(()=>built.validateEnvelope(request,{referenceReceipt:'wrong',result:{decisions:[]}})).toThrow();
 expect(()=>built.validateEnvelope(request,{decisions:[]}).expandProposal(proposal)).toThrow();
 const forged={proposals:[],audited:true,checkpoint:'done'};expect(built.expand(request,forged)).toEqual(forged);
});
test.each([undefined,'zh-CN','en'] as const)('runtime binds language %s through encoded generation, review and fresh authority',async language=>{
 const {createMemoryRuntime}=await import('../server/memory-runtime'),{openStore}=await import('../server/store'),{readConfig}=await import('../server/config'),{mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 for(const revoke of [false,true]){
  const home=mkdtempSync(join(tmpdir(),'memory-codec-')),store=openStore(home),config=(await readConfig(home)).config,root={userId:'local'};
  config.system={cli:'codex',...config.system,memory:{...config.system?.memory,language}};
  let encodedReviews=0,denied=false;const calls:unknown[]=[];
  const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false,verifyOutput:true,authorizeConversationRead:()=>{if(denied)throw new Error('synthetic_forbidden');},generate:async(_config,prompt)=>{
   const data=sourceJSON(prompt);calls.push({stage:data.stage,drafts:data.drafts?.length,sources:data.sources.length,encoded:!!data.referenceDictionary});const wrap=(result:unknown)=>JSON.stringify(data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result}:result);
   if(data.stage==='extract')return wrap(data.sources.flatMap((source:any)=>source.events.filter((event:any)=>event.kind==='user').flatMap((event:any)=>event.text.split('\n').map((text:string)=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'})))));
   if(data.stage==='verify'){
    if(data.referenceDictionary){encodedReviews++;await Promise.resolve();if(revoke)denied=true;}
    return wrap({decisions:data.reviewCandidates.map((candidate:any,i:number)=>({...candidate,decision:'revise',proposal:data.drafts[i]}))});
   }
   if(data.stage==='conflict')return wrap(data.batchItems?data.batchItems.map((item:any)=>({...item.atom,batchItemId:item.id})):data.atoms);
   if(data.stage==='scene')return wrap([{collectionId:data.collectionId,layer:'L2',contentType:'fact',text:data.records.filter((r:any)=>r.layer==='L1').map((r:any)=>r.text).join('\n'),semanticKey:'scene.synthetic',operation:'store',replaces:[],evidence:data.records.filter((r:any)=>r.layer==='L1').flatMap((r:any)=>r.evidence),support:[],dependencies:data.records.filter((r:any)=>r.layer==='L1').map((r:any)=>({recordId:r.recordId,revision:r.revision})),validUntil:null,certainty:'observed'}]);
   if(data.stage==='profile')return wrap(data.records.filter((r:any)=>r.layer==='L2').map((record:any)=>({collectionId:data.collectionId,layer:'L3',contentType:'procedure',text:record.text,semanticKey:'persona.operating-doctrine',operation:'store',replaces:[],evidence:record.evidence,support:[],dependencies:[{recordId:record.recordId,revision:record.revision}],validUntil:null,certainty:'observed'})));
   return '[]';
  }});
  try{
   await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
   store.appendEvent(chat.id,'user',{text:Array.from({length:20},(_,i)=>`The confirmed project rule ${i} is to retain log category ${i}.`).join('\n')});
   store.appendEvent(chat.id,'status',{status:'idle'});store.completeConversation(chat.id,true);
   const capture=await runtime.captureConversation(chat.id);await runtime.drain();denied=false;
   expect(encodedReviews,JSON.stringify({calls,jobs:runtime.jobs.list(root)})).toBeGreaterThan(0);
   const job=runtime.jobs.list(root).find(job=>job.id===capture.jobs[0].id);
   if(revoke){expect(job?.error).toBe('synthetic_forbidden');expect(runtime.memory.listAll(root,{status:'active'})).toEqual([]);}
   else{
    expect(job?.state,JSON.stringify(job)).toBe('completed');
    const facts=runtime.memory.listAll(root,{status:'active'}).filter(record=>record.layer==='L1');
    expect(facts).toHaveLength(20);
    expect(facts.every(record=>record.evidence.every(ref=>ref.sourceId===capture.sources[0].id&&ref.sourceRevision===capture.sources[0].revision))).toBe(true);
    expect(facts.every(record=>typeof record.recordId==='string'&&record.support?.every(ref=>typeof ref.sourceId==='string'))).toBe(true);
   }
  }finally{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});}
 }
});
test('legacy proposal envelopes retain unrelated extra fields without granting alias authority',()=>{
 const request=input(),built=prompts.buildMemoryRequest(request),legacy={proposals:[draft],result:'legacy extra field',summary:literal};
 expect(built.expand(request,legacy)).toEqual(legacy);
 const encoded=sourceJSON(built.prompt);
 expect(()=>built.expand(request,{proposals:encoded.drafts,result:'legacy extra field'})).toThrow();
});
test('encoded batch revisions cannot borrow another candidate evidence or dependency identity',()=>{
 const request=input(),otherId='other-source-and-record-identity-000000000000000000000000000000';
 const other={...structuredClone(draft),text:'Other fact.',evidence:[{sourceId:otherId,sourceRevision:4}],dependencies:[{recordId:otherId,revision:5}],support:[],replaces:[]};
 request.batchItems=[{id:'first',draft,records:request.records},{id:'second',draft:other,records:[]}];
 const built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),candidates=prompts.memoryReviewCandidates(request);
 expect(encoded.referenceDictionary).toBeDefined();
 const packet={decisions:candidates.map((candidate,i)=>({...candidate,decision:'revise',proposal:{...encoded.batchItems[i].draft,batchItemId:candidate.id}}))};
 expect(prompts.decodeMemoryReview(request,built.expand(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:packet}))).toEqual([{...draft,batchItemId:'first'},{...other,batchItemId:'second'}]);
 packet.decisions[0].proposal.evidence=encoded.batchItems[1].draft.evidence;
 expect(()=>prompts.decodeMemoryReview(request,built.expand(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:packet}))).toThrow('invalid_memory_generation');
});
test('bound extraction decoder isolates a bad alias after the unique known-ID packet gate',()=>{
 const request={...input(),reviewCandidateIds:Array.from({length:9},(_,i)=>`job:extract:${i}`)},built=prompts.buildMemoryRequest(request),encoded=sourceJSON(built.prompt),candidates=prompts.memoryReviewCandidates(request);
 const decisions=candidates.map((candidate,i)=>({...candidate,decision:i===8?'revise':'accept',...i===8?{proposal:{...encoded.drafts[i],evidence:[{sourceId:{s:999},sourceRevision:3}]}}:{}}));
 const result=built.decode(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:{decisions}}) as {decisions:Record<string,MemoryProposal>;proposals:MemoryProposal[]};
 expect(result.proposals).toEqual(request.drafts!.slice(0,8));expect(Object.keys(result.decisions)).toEqual(request.reviewCandidateIds.slice(0,8));
 expect(()=>built.decode(request,{referenceReceipt:'stale',result:{decisions}})).toThrow('invalid_memory_generation');
 expect(()=>built.decode(request,{referenceReceipt:encoded.referenceDictionary.receipt,result:{decisions:[...decisions,{...candidates[0],decision:'reject'}]}})).toThrow('invalid_memory_generation');
});
