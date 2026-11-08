import {readConfiguredRuntime} from './configured-runtime';
import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {memoryServices,createMemoryRuntime} from '../server/memory-runtime';

import {createMemoryPipeline,type MemoryGeneratorInput} from '../server/memory-pipeline';
import {createMemoryScenes} from '../server/memory-scenes';
import {memoryHash} from '../server/memory-store';
import {buildMemoryRequest,memoryReviewCandidates} from '../server/memory-prompts';
import type {MemoryProposal,MemoryRevision} from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(authorize?:()=>void){
 const home=mkdtempSync(join(tmpdir(),'memory-semantic-')),store=openStore(home),{memory,jobs}=memoryServices(home,store,authorize),c=memory.ensureCollection(root,{projectId:null,agentId:null});cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const capture=(text:string,tool?:{path:string;quote:string})=>{const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});const user=store.appendEvent(chat.id,'user',{text});const event=tool?store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'read',command:`cat ${tool.path}`,cwd:'/synthetic/project',status:'completed',exitCode:0,aggregatedOutput:tool.quote}}}):user;store.appendEvent(chat.id,'status',{status:'idle'});return {...memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),event};};
 const atom=(source:ReturnType<typeof capture>,text:string,quote=source.event.kind==='user'?text:source.sources[0].events.find(e=>e.id===source.event.id)!.text):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.sources[0].id,sourceRevision:source.sources[0].revision}],support:[{sourceId:source.sources[0].id,eventId:source.event.id,quote}],dependencies:[],validUntil:null,certainty:'observed'});
 const seed=(p:MemoryProposal)=>memory.applyProposal(root,p,memory.collection(root,c.id).generation,p.layer==='L1'?'evidence_extract':'layer_summary')!;
 const only=(jobId:string,stage:string)=>{for(const j of jobs.list(root))store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...j,state:j.id===jobId?'queued':'obsolete',stage:j.id===jobId?stage:j.stage,extractorVersion:'semantic-test'}),j.id);};
 return {home,store,memory,jobs,c,capture,atom,seed,only};
}
const body=(input:MemoryGeneratorInput)=>{const request=buildMemoryRequest(input),data=JSON.parse(request.prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);return {request,data:data.referenceDictionary?request.restoreSource(data) as any:data};};
test.each([false,true])('runtime retains complete old body on same-observation narrowing, explicitChange=%s',async explicitChange=>{
 const s=setup(),full='Requests cannot be forwarded to existing or newly opened conversations.',source=s.capture(full),old=s.seed({...s.atom(source,full),semanticKey:'request.forward'}),config=(await readConfiguredRuntime(s.home)).config;
 const narrowed='Requests cannot be forwarded to newly opened conversations.';let conflicts=0;
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,generate:async(_config,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]),wrap=(result:unknown)=>JSON.stringify(data.referenceDictionary?{referenceReceipt:data.referenceDictionary.receipt,result}:result);
  if(data.stage==='extract')return wrap([{...s.atom(source,narrowed,full),semanticKey:'request.forward'}]);
  if(data.stage==='verify')return wrap({decisions:data.reviewCandidates.map((c:any)=>({...c,decision:'accept'}))});
  if(data.stage==='conflict'){conflicts++;return wrap(data.atoms.map((a:any)=>({...a,operation:'update',replaces:[{recordId:data.records[0].recordId,revision:data.records[0].revision}],explicitChange})));}
  return '[]';
 }});
 try{await runtime.initialize();await runtime.drain();expect(conflicts).toBe(1);const current=runtime.memory.listAll(root).find(r=>r.recordId===old.recordId)!;expect(current).toMatchObject({status:'active',revision:old.revision,text:full});const job=runtime.jobs.list(root).find(j=>j.id===source.jobs[0].id)!;expect(job).toMatchObject({stage:'conflict',state:'queued',error:'memory_rewrite_requires_new_proof'});expect(s.store.database.prepare("SELECT * FROM memory_scene_cursors WHERE kind='scene'").all()).toEqual([]);}
 finally{await runtime.close();}
});
test.each(['accept','violating-revise'] as const)('actual Scene proof wiring; known semantic limitation when response is %s',async mode=>{
 const s=setup(),quote='export const panel = "r:0 {r:0} observation";',source=s.capture('Read panel source.',{path:'/synthetic/project/panel.ts',quote}),historical=s.seed(s.atom(source,`${source.event.createdAt.slice(0,10)} /synthetic/project/panel.ts defines the observed panel value.`,quote));
 const invalidSource=s.capture('Old invalid claim.'),invalid=s.seed(s.atom(invalidSource,'Old invalid claim.')),unrelatedSource=s.capture('Unrelated retained claim.'),unrelated=s.seed(s.atom(unrelatedSource,'Unrelated retained claim.'));
 const scene=(text:string,deps:MemoryRevision[],key:string)=>s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text,semanticKey:key,operation:'store',replaces:[],evidence:deps.flatMap(d=>d.evidence),dependencies:deps.map(({recordId,revision})=>({recordId,revision})),support:[],validUntil:null,certainty:'observed'});
 const old=scene('Historical panel observations.',[historical,invalid],'scene.panel');scene('Unrelated scene.',[unrelated],'scene.unrelated');s.memory.correct(root,{recordId:invalid.recordId,expectedRevision:invalid.revision,text:'Corrected observation.'});
 const fresh=s.capture('The panel needs a new icon.'),fact=s.seed(s.atom(fresh,'The panel needs a new icon.'));s.only(fresh.jobs[0].id,'scene');createMemoryScenes(s.memory).commit(s.c.id,[historical,unrelated],new Date().toISOString());
 let audited=false;const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='scene'){const current=input.records.find(r=>r.recordId===old.recordId)!;return [{collectionId:s.c.id,layer:'L2',contentType:'fact',text:historical.text+' '+fact.text,semanticKey:'scene.panel',operation:'update',replaces:[{recordId:current.recordId,revision:current.revision}],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}];}
  const {request,data}=body(input);audited=true;
  expect(data.records.find((r:any)=>r.recordId===historical.recordId)).toMatchObject({text:historical.text,revision:historical.revision});
  expect(data.recordEvidence.find((r:any)=>r.recordId===historical.recordId).support).toEqual([expect.objectContaining({quote,createdAt:source.event.createdAt,files:['/synthetic/project/panel.ts']})]);
  expect(data.records.some((r:any)=>r.layer==='L1'&&[invalid.recordId,unrelated.recordId].includes(r.recordId))).toBe(false);
  return request.decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:mode==='accept'?'accept':'revise',...mode==='violating-revise'?{proposal:{...input.drafts![0],text:fact.text}}:{}}))}) as any;
 }});
 const result=await pipeline.runNext('worker');expect(audited).toBe(true);expect(result?.error).toBeNull();
 const active=s.memory.listAll(root,{status:'active'}).find(r=>r.semanticKey==='scene.panel')!;expect(active.text).toBe(mode==='accept'?historical.text+' '+fact.text:fact.text);
});
test.each(['subquote','paraphrase','new_source','new_quote','duplicate','multi_target'] as const)('conflict proof guard handles %s without inventing body changes',async mode=>{
 const s=setup(),full='Requests support existing or newly opened conversations; now use approved routes.',source=s.capture(full),old=s.seed(s.atom(source,full,mode==='new_quote'?'Requests support existing or newly opened conversations':full)),otherSource=mode==='new_source'||mode==='multi_target'?s.capture('Requests now use only approved routes.'):undefined;
 const other=mode==='multi_target'?s.seed(s.atom(otherSource!,'Requests use approved routes.','Requests now use only approved routes.')):undefined;

 const incomingSource=mode==='new_source'?otherSource!:source,quote=mode==='subquote'?'existing or newly opened conversations':mode==='new_quote'?'now use approved routes':incomingSource.event.kind==='user'?incomingSource.sources[0].events[0].text:full;
 const text=mode==='paraphrase'?'Existing and newly opened conversations both support requests.':'Requests now use approved routes.',atom=s.atom(incomingSource,text,quote);s.only(incomingSource.jobs[0].id,'conflict');
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  expect(input.stage).toBe('conflict');const targets=other?[other,old]:[old];expect(targets.every(t=>input.records.some(r=>r.recordId===t.recordId))).toBe(true);
  return [{...atom,operation:mode==='duplicate'?'skip':other?'merge':'update',replaces:targets.map(({recordId,revision})=>({recordId,revision})),...mode==='duplicate'?{skipReason:'duplicate' as const}:{}}];
 }});
 s.store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(incomingSource.jobs[0].id,JSON.stringify({atoms:[atom],nextAtom:0}));
 const result=await pipeline.runNext('worker'),blocked=['subquote','paraphrase','multi_target'].includes(mode);
 expect(result?.error).toBe(blocked?'memory_rewrite_requires_new_proof':null);
 if(blocked||mode==='duplicate')expect(s.memory.listAll(root).find(r=>r.recordId===old.recordId)).toMatchObject({text:full,status:'active',...blocked?{revision:old.revision}:{}});
 else expect(s.memory.listAll(root).find(r=>r.recordId===old.recordId)?.status).toBe('superseded');
 if(other)expect(s.memory.listAll(root).find(r=>r.recordId===other.recordId)).toMatchObject({revision:other.revision,status:'active'});
 if(blocked){const cp=JSON.parse(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(incomingSource.jobs[0].id)!.data as string);expect(cp.completed).toEqual([]);expect(cp.nextAtom).toBe(0);}
});
test.each(['correction','retraction','source','permission','lease','generation'] as const)('conflict guard cannot reuse authority after %s across await',async mode=>{
 let denied=false;const s=setup(()=>{if(denied)throw Error('synthetic_forbidden');}),source=s.capture('Requests support old routes.'),old=s.seed(s.atom(source,'Requests support old routes.')),fresh=s.capture('Requests now use new routes.'),atom=s.atom(fresh,'Requests now use new routes.');s.only(fresh.jobs[0].id,'conflict');
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async()=>{
  await Promise.resolve();if(mode==='correction')s.memory.correct(root,{recordId:old.recordId,expectedRevision:old.revision,text:'Human corrected routes.'});
  if(mode==='retraction')s.memory.retract(root,{recordId:old.recordId,expectedRevision:old.revision});
  if(mode==='source')s.memory.retractSource(root,{sourceId:source.sources[0].id,expectedRevision:source.sources[0].revision});if(mode==='permission')denied=true;
  if(mode==='lease'){const job=s.jobs.list(root).find(j=>j.id===fresh.jobs[0].id)!;s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,leaseToken:job.leaseToken+1}),job.id);}
  if(mode==='generation'){const c=s.memory.collection(root,s.c.id);s.store.database.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify({...c,generation:c.generation+1}),c.id);}
  return [{...atom,operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}],explicitChange:true}];
 }});
 s.store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(fresh.jobs[0].id,JSON.stringify({atoms:[atom],nextAtom:0}));await pipeline.runNext('worker');denied=false;
 expect(s.memory.listAll(root).some(r=>r.text===atom.text)).toBe(false);const current=s.memory.listAll(root).find(r=>r.recordId===old.recordId)!;
 if(mode==='correction')expect(current).toMatchObject({status:'active',text:'Human corrected routes.',verification:'user_correction'});
 else if(mode==='retraction')expect(current.status).toBe('retracted');else if(mode!=='source')expect(current).toMatchObject({status:'active',text:old.text});
});
test('explicit management correction and retraction retain revision and invalidation behavior',()=>{
 const s=setup(),source=s.capture('Requests support old routes.'),old=s.seed(s.atom(source,'Requests support old routes.'));
 const scene=s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text:old.text,semanticKey:'scene.routes',operation:'store',replaces:[],evidence:old.evidence,dependencies:[{recordId:old.recordId,revision:old.revision}],support:[],validUntil:null,certainty:'observed'});
 const corrected=s.memory.correct(root,{recordId:old.recordId,expectedRevision:old.revision,text:'Requests support corrected routes.'});expect(corrected.verification).toBe('user_correction');expect(s.memory.staleScenes(root,null).find(r=>r.recordId===scene.recordId)?.status).toBe('stale');s.memory.retract(root,{recordId:corrected.recordId,expectedRevision:corrected.revision});expect(s.memory.listAll(root).find(r=>r.recordId===corrected.recordId)?.status).toBe('retracted');
});
test('batched independent audits expose retained proofs only through their own candidate recordRefs',async()=>{
 const s=setup(),pairs=Array.from({length:3},(_,i)=>{const source=s.capture(`Historical panel ${i} observation.`),fact=s.seed(s.atom(source,`Historical panel ${i} observation.`)),scene=s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text:fact.text,semanticKey:`scene.panel-${i}`,operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'});return {fact,scene};});
 createMemoryScenes(s.memory).commit(s.c.id,pairs.map(p=>p.fact),new Date().toISOString());const source=s.capture('Historical panel needs new icons.'),fresh=s.seed(s.atom(source,'Historical panel needs new icons.'));s.only(source.jobs[0].id,'scene');let audited=false;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='scene')return pairs.map(({scene})=>({collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:scene.semanticKey,text:scene.text+' '+fresh.text,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}],evidence:fresh.evidence,dependencies:[{recordId:fresh.recordId,revision:fresh.revision}],support:[],validUntil:null,certainty:'observed'}));
  audited=true;const {request,data}=body(input);expect(data.batchItems).toHaveLength(3);
  for(const [index,item] of data.batchItems.entries()){expect(item.recordRefs).toContainEqual({recordId:pairs[index].fact.recordId,revision:1});expect(item.recordRefs.some((r:any)=>pairs.some((p,i)=>i!==index&&p.fact.recordId===r.recordId))).toBe(false);}
  return request.decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}))}) as any;
 }});
 expect((await pipeline.runNext('worker'))?.error).toBeNull();expect(audited).toBe(true);
});
test('known limitation: a fixed violating Profile plus accept can still promote an observation despite visible claim-local guidance',async()=>{
 const s=setup(),tool=s.capture('Inspect scheduling source.',{path:'/synthetic/project/scheduler.ts',quote:'const priority = 3;'}),observation=s.seed(s.atom(tool,`${tool.event.createdAt.slice(0,10)} /synthetic/project/scheduler.ts defines priority 3; this is a tool observation, not a current-runtime or adopted rule.`, 'const priority = 3;')),user=s.capture('For this project, I prefer clear status labels.'),preference=s.seed({...s.atom(user,'For this project, I prefer clear status labels.'),contentType:'preference'});
 const scenes=[observation,preference].map((fact,i)=>s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text:fact.text,semanticKey:`scene.profile-${i}`,operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}));s.only(user.jobs[0].id,'profile');
 const violating='## Core Principles\nAgents must enforce platform priority 3.',pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  const {request,data}=body(input);expect(request.prompt).toContain('dates elsewhere or a blanket disclaimer do not authorize normative statements');expect(data.records.some((r:any)=>r.text===observation.text)).toBe(true);
  if(input.stage==='profile')return [{collectionId:s.c.id,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',text:violating,operation:'store',replaces:[],evidence:scenes.flatMap(s=>s.evidence),dependencies:scenes.map(({recordId,revision})=>({recordId,revision})),support:[],validUntil:null,certainty:'observed'}];
  return request.decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}))}) as any;
 }});
 expect((await pipeline.runNext('worker'))?.error).toBeNull();expect(s.memory.listAll(root,{status:'active'}).find(r=>r.layer==='L3')?.text).toBe(violating);
});
test.each(['append','correction','retraction','source','permission'] as const)('retained full proof remains fresh and handles %s at the audit boundary',async mode=>{
 let denied=false;const s=setup(()=>{if(denied)throw Error('synthetic_forbidden');}),source=s.capture('Historical panel supports old routes.'),original=s.seed(s.atom(source,'Historical panel supports old routes.'));
 const scene=s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text:original.text,semanticKey:'scene.history',operation:'store',replaces:[],evidence:original.evidence,dependencies:[{recordId:original.recordId,revision:original.revision}],support:[],validUntil:null,certainty:'observed'});
 let retained=original;if(mode==='append'){const extra=s.capture(original.text);retained=s.seed(s.atom(extra,original.text));expect(retained.revision).toBe(original.revision+1);}
 createMemoryScenes(s.memory).commit(s.c.id,[retained],new Date().toISOString());const fresh=s.capture('Historical panel needs an icon.'),fact=s.seed(s.atom(fresh,'Historical panel needs an icon.'));s.only(fresh.jobs[0].id,'scene');let audited=false;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='scene')return [{collectionId:s.c.id,layer:'L2',contentType:'fact',text:original.text+' '+fact.text,semanticKey:scene.semanticKey,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'}];
  const {request,data}=body(input);expect(data.records.find((r:any)=>r.recordId===retained.recordId)).toMatchObject({revision:retained.revision,text:retained.text});audited=true;await Promise.resolve();
  if(mode==='correction')s.memory.correct(root,{recordId:original.recordId,expectedRevision:original.revision,text:'Human corrected historical observation.'});
  if(mode==='retraction')s.memory.retract(root,{recordId:original.recordId,expectedRevision:original.revision});
  if(mode==='source')s.memory.retractSource(root,{sourceId:source.sources[0].id,expectedRevision:source.sources[0].revision});if(mode==='permission')denied=true;
  return request.decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}))}) as any;
 }});
 const result=await pipeline.runNext('worker');denied=false;expect(audited).toBe(true);
 if(mode==='append'){expect(result?.error).toBeNull();expect(s.memory.listAll(root,{status:'active'}).find(r=>r.semanticKey===scene.semanticKey)?.dependencies).toContainEqual({recordId:retained.recordId,revision:retained.revision});}
 else {expect(result?.error).not.toBeNull();expect(s.memory.listAll(root,{status:'active'}).some(r=>r.text===original.text+' '+fact.text)).toBe(false);expect(s.store.database.prepare("SELECT record_id FROM memory_scene_cursors WHERE kind='scene' AND record_id=?").get(fact.recordId)).toBeUndefined();}
});

test.each([2,3])('old derived audit checkpoint must re-review every checked candidate with current proof policy, count=%s',async count=>{
 const s=setup(),pairs=Array.from({length:count},(_,i)=>{const source=s.capture(`Historical panel ${i} observation.`),fact=s.seed(s.atom(source,`Historical panel ${i} observation.`)),scene=s.seed({collectionId:s.c.id,layer:'L2',contentType:'fact',text:fact.text,semanticKey:`scene.checkpoint-${i}`,operation:'store',replaces:[],evidence:fact.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}],support:[],validUntil:null,certainty:'observed'});return {fact,scene};});
 createMemoryScenes(s.memory).commit(s.c.id,pairs.map(p=>p.fact),new Date().toISOString());const source=s.capture('Historical panel needs new icons.'),fresh=s.seed(s.atom(source,'Historical panel needs new icons.'));s.only(source.jobs[0].id,'scene');const jobId=source.jobs[0].id;
 const proposals:MemoryProposal[]=pairs.map(({scene})=>({collectionId:s.c.id,layer:'L2',contentType:'fact',semanticKey:scene.semanticKey,text:scene.text+' '+fresh.text,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}],evidence:fresh.evidence,dependencies:[{recordId:fresh.recordId,revision:fresh.revision}],support:[],validUntil:null,certainty:'observed'}));
 const audited:string[]=[],pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  expect(input.stage).toBe('verify');const {request,data}=body(input);
  for(const draft of input.drafts!){audited.push(draft.semanticKey!);const pair=pairs.find(p=>p.scene.semanticKey===draft.semanticKey)!;expect(data.records.find((r:any)=>r.recordId===pair.fact.recordId)?.text).toBe(pair.fact.text);}
  return request.decode(input,{decisions:memoryReviewCandidates(input).map(c=>({...c,decision:'accept'}))}) as any;
 }});
 const checked={...proposals[0],text:fresh.text},hash=memoryHash(JSON.stringify(proposals));
 s.store.database.prepare('INSERT INTO memory_output_drafts VALUES(?,?)').run(jobId,JSON.stringify(proposals));
 s.store.database.prepare('INSERT INTO memory_output_verifications VALUES(?,?)').run(jobId,JSON.stringify(count===3?{hash,checked:{0:checked},isolated:[],repairs:[]}:{hash,checked:[checked],next:1,reviewError:null}));
 for(let i=0;i<count;i++){const result=await pipeline.runNext('worker');expect(result?.error).toBeNull();if(result?.stage!=='scene')break;}
 expect(audited).toEqual(expect.arrayContaining(pairs.map(p=>p.scene.semanticKey!)));
 for(const {scene} of pairs)expect(s.memory.listAll(root,{status:'active'}).find(r=>r.semanticKey===scene.semanticKey)?.text).toBe(scene.text+' '+fresh.text);
});
