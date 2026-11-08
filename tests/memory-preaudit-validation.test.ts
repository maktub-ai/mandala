import {readConfiguredRuntime} from './configured-runtime';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {memoryServices,createMemoryRuntime} from '../server/memory-runtime';

import {createMemoryPipeline,type MemoryGeneratorInput} from '../server/memory-pipeline';
import {memoryHash} from '../server/memory-store';
import {buildMemoryRequest,memoryReviewCandidates} from '../server/memory-prompts';
import type {MemoryProposal,MemorySource} from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-preaudit-')),store=openStore(home),{memory,jobs,tasks}=memoryServices(home,store),c=memory.ensureCollection(root,{projectId:null,agentId:null});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const capture=(text:string)=>{const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});return memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});};
 const atom=(source:MemorySource):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text:source.events[0].text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:source.events[0].id,quote:source.events[0].text}],dependencies:[],validUntil:null,certainty:'observed'});
 const only=(id:string,stage:string)=>{for(const j of jobs.list(root))store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...j,state:j.id===id?'queued':'obsolete',stage:j.id===id?stage:j.stage,extractorVersion:'preaudit-test'}),j.id);};
 return {home,store,memory,jobs,tasks,c,capture,atom,only};
}
function accept(input:MemoryGeneratorInput):any{return buildMemoryRequest(input).decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}))});}
function derived(s:ReturnType<typeof setup>,stage:'scene'|'profile'){
 let capture=s.capture('The project requires explicit review.');
 // Re-capture edited synthetic source text before publishing any dependent records.
 for(let i=0;i<2;i++){s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:`The project requires explicit review. Revision ${i+2} adds context.`}),capture.sources[0].events[0].id);capture=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:capture.sources[0].conversationId!,trigger:'explicit',kind:'request'});}
 const source=capture.sources[0];expect(source.revision).toBe(3);
 const fact=s.memory.applyProposal(root,s.atom(source),s.c.generation,'evidence_extract')!;
 const scene:MemoryProposal={collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'scene.review',text:fact.text,operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'};
 const parent=stage==='profile'?s.memory.applyProposal(root,scene,s.c.generation,'layer_summary')!:fact;
 const proposal:MemoryProposal={...scene,...stage==='profile'?{layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine'}:{},dependencies:[{recordId:parent.recordId,revision:parent.revision}]};
 const jobId=capture.jobs[0].id;s.only(jobId,stage);if(stage==='profile'){const job=s.jobs.list(root).find(j=>j.id===jobId)!;s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,profileScope:{projectId:null,agentId:null}}),jobId);}
 const next=(pipeline:ReturnType<typeof createMemoryPipeline>)=>{const job=s.jobs.list(root).find(j=>j.id===jobId)!;return pipeline.runNext('worker',new Date(Math.max(Date.now(),Date.parse(job.availableAt))).toISOString());};
 return {source,proposal,jobId,next};
}
test('new observation updates a published Task revision 1 fact after the Task advances to revision 2',async()=>{
 const s=setup(),task=s.tasks.createTask(root,{goal:'Review the panel',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null},'create');
 const historical=s.memory.captureTask(root,{collectionId:s.c.id,taskId:task.id,trigger:'stable',kind:'request'}).sources[0];expect(historical.taskRevision).toBe(1);
 const old=s.memory.applyProposal(root,s.atom(historical),s.c.generation,'evidence_extract')!;
 const current=s.tasks.updateTask(root,task.id,task.revision,{goal:'Review the revised panel'},'revise');expect(current.revision).toBe(2);
 const captured=s.memory.captureTask(root,{collectionId:s.c.id,taskId:task.id,trigger:'stable',kind:'request'}),incoming=s.atom(captured.sources[0]);s.only(captured.jobs[0].id,'conflict');
 expect(s.memory.read(root,old.recordId,null)).toMatchObject({status:'active',revision:old.revision});
 expect(()=>s.memory.validateSource(root,old.evidence[0],true,null)).toThrow('source_changed');
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{expect(input.stage).toBe('conflict');return [{...incoming,operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}]}];}});
 s.store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(captured.jobs[0].id,JSON.stringify({atoms:[incoming],nextAtom:0}));
 expect(await pipeline.runNext('worker')).toMatchObject({stage:'scene',error:null});
 expect(s.memory.read(root,old.recordId,null).status).toBe('superseded');expect(s.memory.listAll(root,{status:'active'}).find(r=>r.text===incoming.text)?.evidence).toEqual(incoming.evidence);
});
const invalidCases=['old_revision','quote','job_scope'] as const;
function invalidate(proposal:MemoryProposal,source:MemorySource,mode:typeof invalidCases[number]):MemoryProposal{
 return {...proposal,...mode==='old_revision'?{evidence:[{sourceId:source.id,sourceRevision:1}]}:mode==='job_scope'?{evidence:[{sourceId:'source-not-in-job',sourceRevision:1}]}:{support:[{sourceId:source.id,eventId:source.events[0].id,quote:'A fabricated quotation.'}]}};
}
test.each((['scene','profile'] as const).flatMap(stage=>invalidCases.map(mode=>({stage,mode}))))('invalid $stage $mode originals fail before independent review and repair only their slot',async({stage,mode})=>{
  const s=setup(),d=derived(s,stage),invalid=invalidate(d.proposal,d.source,mode),audit:MemoryProposal[][]=[],repairs:MemoryProposal[][]=[];let initial=0;
  const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
   if(input.stage==='verify'){audit.push(input.drafts!);return accept(input);}
   if(input.repairDrafts){repairs.push(input.repairDrafts);return [d.proposal];}
   initial++;return [invalid];
  }});
  const before=s.memory.listAll(root);expect(await d.next(pipeline)).toMatchObject({state:'queued',error:mode==='quote'?'unsupported_extract':'job_evidence_mismatch'});
  expect(audit).toEqual([]);expect(s.memory.listAll(root)).toEqual(before);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
  expect((await d.next(pipeline))?.error).toBeNull();expect(initial).toBe(1);expect(repairs).toEqual([[invalid]]);expect(audit).toEqual([[d.proposal]]);
});
test.each((['scene','profile'] as const).flatMap(stage=>invalidCases.map(mode=>({stage,mode}))))('runtime provider never receives an audit for invalid $stage $mode originals',async({stage,mode})=>{
  const s=setup(),d=derived(s,stage),config=(await readConfiguredRuntime(s.home)).config,calls:string[]=[];
  const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,embed:async texts=>texts.map(()=>[1,0]),generate:async(_config,prompt)=>{
   const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);calls.push(data.stage);
   const result=data.stage===stage?[invalidate(d.proposal,d.source,mode)]:{decisions:data.reviewCandidates.map((c:any)=>({...c,decision:'accept'}))};
   return JSON.stringify(data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result}:result);
  }});
  try{await runtime.initialize();const before=s.memory.listAll(root);await runtime.drain();expect(calls).toEqual([stage]);expect(s.memory.listAll(root)).toEqual(before);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);expect(runtime.jobs.list(root).find(j=>j.id===d.jobId)?.error).toBe(mode==='quote'?'unsupported_extract':'job_evidence_mismatch');}
  finally{await runtime.close();}
});
test.each([2,3])('preaudit failure preserves valid siblings across repair, slots=%s',async count=>{
 const s=setup(),d=derived(s,'scene'),proposals=Array.from({length:count},(_,i)=>({...d.proposal,semanticKey:`scene.slot-${i}`,text:`Panel ${i}: ${d.proposal.text}`})),invalid=invalidate(proposals[1],d.source,'old_revision'),audited:string[]=[],repaired:string[]=[];let initial=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){audited.push(...input.drafts!.map(p=>p.semanticKey!));return accept(input);}
  if(input.repairDrafts){repaired.push(...input.repairDrafts.map(p=>p.semanticKey!));return [proposals[1]];}
  initial++;return proposals.map((p,i)=>i===1?invalid:p);
 }});
 expect(await d.next(pipeline)).toMatchObject({error:'job_evidence_mismatch'});expect(audited).toEqual([]);
 for(let i=0;i<count;i++){const result=await d.next(pipeline);expect(result?.error).toBeNull();if(result?.stage!=='scene')break;}
 expect(initial).toBe(1);expect(repaired).toEqual(['scene.slot-1']);expect(audited.sort()).toEqual(proposals.map(p=>p.semanticKey!).sort());
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2').map(r=>r.text).sort()).toEqual(proposals.map(p=>p.text).sort());
});
test.each(invalidCases)('persistently invalid derived %s receives exactly two generation attempts and zero audits',async mode=>{
 const s=setup(),d=derived(s,'scene'),invalid=invalidate(d.proposal,d.source,mode);let generated=0,audits=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{if(input.stage==='verify'){audits++;return accept(input);}generated++;return [invalid];}});
 for(let i=1;i<=2;i++)expect(await d.next(pipeline)).toMatchObject({state:i===2?'failed':'queued',error:mode==='quote'?'unsupported_extract':'job_evidence_mismatch',outputFailures:i});
 expect(await d.next(pipeline)).toBeNull();expect(generated).toBe(2);expect(audits).toBe(0);expect(s.memory.listAll(root).some(r=>r.layer==='L2')).toBe(false);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
});
test('published historical Task facts stay readable but cannot authorize a new derived proposal as pending evidence',async()=>{
 const s=setup(),task=s.tasks.createTask(root,{goal:'Review the panel',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:null},'create'),source=s.memory.captureTask(root,{collectionId:s.c.id,taskId:task.id,trigger:'stable',kind:'request'}).sources[0],fact=s.memory.applyProposal(root,s.atom(source),s.c.generation,'evidence_extract')!;
 s.tasks.updateTask(root,task.id,task.revision,{goal:'Review the revised panel'},'revise');
 const fresh=s.capture('The panel needs more review.');s.only(fresh.jobs[0].id,'scene');let audits=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify'){audits++;return accept(input);}
  return [{collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:'scene.panel',text:fact.text,operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'}];
 }});
 expect(s.memory.read(root,fact.recordId,null).status).toBe('active');expect(await pipeline.runNext('worker')).toMatchObject({error:'source_changed'});expect(audits).toBe(0);expect(s.memory.listAll(root,{status:'active'})).toEqual([fact]);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
});
test('a valid derived original still cannot publish without independent review approval',async()=>{
 const s=setup(),d=derived(s,'scene'),before=s.memory.listAll(root);let audits=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage!=='verify')return [d.proposal];
  audits++;return buildMemoryRequest(input).decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'reject'}))}) as any;
 }});
 expect(await d.next(pipeline)).toMatchObject({error:'verification_no_result'});expect(audits).toBe(1);expect(s.memory.listAll(root)).toEqual(before);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
});
test.each([2,3].flatMap(count=>[false,true].map(invalidPending=>({count,invalidPending}))))('checked valid revisions survive preaudit; slots=$count invalidPending=$invalidPending',async({count,invalidPending})=>{
 const s=setup(),d=derived(s,'scene'),valid=Array.from({length:count},(_,i)=>({...d.proposal,semanticKey:`scene.legacy-${i}`,text:`Legacy panel ${i}: ${d.proposal.text}`})),proposals=valid.map((p,i)=>i===0?invalidate(p,d.source,'quote'):i===1&&invalidPending?invalidate(p,d.source,'old_revision'):p),audited:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{audited.push(...input.drafts!.map(p=>p.semanticKey!));return accept(input);}}),hash=memoryHash('retained-proof-review-v1:'+JSON.stringify(proposals));
 // A prior bound revision could drop the bad quote (a permitted reference subset).
 s.store.database.prepare('INSERT INTO memory_output_drafts VALUES(?,?)').run(d.jobId,JSON.stringify(proposals));
 s.store.database.prepare('INSERT INTO memory_output_verifications VALUES(?,?)').run(d.jobId,JSON.stringify(count===3?{hash,checked:{0:valid[0]},isolated:[],repairs:[]}:{hash,next:1,checked:[valid[0]],reviewError:null}));
 const before=s.memory.listAll(root),result=await d.next(pipeline);
 if(invalidPending){
  expect(result?.error).toBe('job_evidence_mismatch');expect(audited).toEqual([]);expect(s.memory.listAll(root)).toEqual(before);expect(s.store.database.prepare('SELECT * FROM memory_scene_cursors').all()).toEqual([]);
  const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(d.jobId)!.data as string);expect(saved.checked[0]).toEqual(valid[0]);
 }else{
  expect(result?.error).toBeNull();expect(audited.sort()).toEqual(valid.slice(1).map(p=>p.semanticKey!).sort());expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2').map(r=>r.text).sort()).toEqual(valid.map(p=>p.text).sort());
 }
});
