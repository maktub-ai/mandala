import { createMemoryScenes } from '../server/memory-scenes';
import { afterEach,expect,test } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import { createMemoryPipeline,type MemoryGeneratorInput } from '../server/memory-pipeline';
import type { MemoryProposal } from '../shared/memory';
import { DomainError } from '../shared/workspace-contracts';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(seed=true){
 const home=mkdtempSync(join(tmpdir(),'memory-complete-')),store=openStore(home);cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const assets=createAssets(store,createAssetFiles(home)),memory=createMemoryStore(store,{assets,tasks:createTasks(store,{assets}),localUserId:'local'}),jobs=createMemoryJobs(store,memory),c=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const texts=['数据库 PostgreSQL。','包管理 pnpm。','界面 React。','部署 Docker。'];
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),event=store.appendEvent(chat.id,'user',{text:texts.join('')});store.appendEvent(chat.id,'status',{status:'idle'});
 const source=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const atom=(text:string):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted'});
 const facts=seed?texts.map(text=>memory.applyProposal(root,atom(text),c.generation,'evidence_extract')!):[];
 const scene=(index:number):MemoryProposal=>({...atom(texts[index]),layer:'L2',semanticKey:'scene.'+index,support:[],dependencies:[{recordId:facts[index].recordId,revision:facts[index].revision}]});
 return {store,memory,jobs,c,source,chat,texts,atom,facts,scene};
}
test('derived review batches independent stable IDs and retains valid audits when one item fails',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let reviews=0;
 const batches:string[][]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage!=='verify')return s.texts.map((_,i)=>s.scene(i));
  reviews++;const items=(input as MemoryGeneratorInput & {batchItems?:{id:string;draft:MemoryProposal}[]}).batchItems;batches.push(items?.map(x=>x.id)??[]);
  if(reviews===1){expect(items).toHaveLength(4);return items!.map((item,i)=>({...item.draft!,batchItemId:item.id,...i===1?{semanticKey:'scene.wrong'}:{}}));}
  expect(input.drafts).toHaveLength(1);return input.drafts!;
 }});
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('verification_identity_changed');
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({error:null});
 expect(reviews).toBe(2);expect(batches[0]).toHaveLength(4);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(4);
});
test('a derived dependency replaced by an earlier proposal repairs only its slot before atomic commit',async()=>{
 const s=setup(),job=s.jobs.list(root)[0],old=s.memory.applyProposal(root,s.scene(0),s.c.generation,'layer_summary')!;
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);
 const proposals=[{...s.scene(0),text:'数据库 PostgreSQL，描述一。',operation:'update' as const,replaces:[{recordId:old.recordId,revision:old.revision}]},{...s.scene(0),semanticKey:'scene.second',text:'数据库 PostgreSQL，描述二。',dependencies:[...s.scene(0).dependencies!,{recordId:old.recordId,revision:old.revision}]},s.scene(1),s.scene(2)];let generated=0,repairs=0;const audited:string[][]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.repairDrafts){repairs++;expect(input.repairDrafts).toHaveLength(1);expect(input.repairDrafts![0]).toEqual(proposals[1]);expect(input.job.errorDetail).toContain('dependency_replaced_in_stage');return [{...input.repairDrafts![0],dependencies:s.scene(0).dependencies}];}
  if(input.stage!=='verify'){generated++;return proposals;}
  audited.push(input.drafts!.map(p=>p.semanticKey!));return input.batchItems?input.batchItems.map(item=>({...item.draft!,batchItemId:item.id})):input.drafts!;
 }});
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('invalid_replacement');
 const checkpoint=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(Object.keys(checkpoint.checked)).toEqual(['0','2','3']);expect(checkpoint.repairs).toEqual([1]);
 expect(s.memory.read(root,old.recordId).status).toBe('active');expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(1);
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({error:null});expect(generated).toBe(1);expect(repairs).toBe(1);expect(audited).toEqual([['scene.0','scene.second','scene.1','scene.2'],['scene.second']]);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2').map(r=>r.semanticKey)).toEqual(expect.arrayContaining(['scene.0','scene.second','scene.1','scene.2']));expect(s.memory.read(root,old.recordId).status).toBe('superseded');
 expect(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)).toBeUndefined();
});
test.each(['store','ineffective'] as const)('two audited updates of the same derived target repair only the second slot (%s)',async repair=>{
 const s=setup(),job=s.jobs.list(root)[0],old=s.memory.applyProposal(root,s.scene(0),s.c.generation,'layer_summary')!;
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let generated=0,repairs=0,audits=0;
 const proposals=[{...s.scene(0),text:'数据库 PostgreSQL，描述一。',operation:'update' as const,replaces:[{recordId:old.recordId,revision:old.revision}]},{...s.scene(0),text:'数据库 PostgreSQL，描述二。',operation:'update' as const,replaces:[{recordId:old.recordId,revision:old.revision}]},s.scene(1),s.scene(2)];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.repairDrafts){repairs++;expect(input.repairDrafts).toEqual([proposals[1]]);expect(input.job.errorDetail).toContain('overlapping_replacement');return repair==='store'?[{...input.repairDrafts![0],operation:'store',replaces:[]}]:input.repairDrafts;}
  if(input.stage!=='verify'){generated++;return proposals;}
  audits++;return input.batchItems?input.batchItems.map(item=>({...item.draft!,batchItemId:item.id})):input.drafts!;
 }});
 let result=await pipeline.runNext('w');expect(result?.error).toBe('invalid_replacement');
 const before=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(Object.keys(before.checked)).toEqual(['0','2','3']);expect(before.repairs).toEqual([1]);
 expect(s.memory.read(root,old.recordId).status).toBe('active');expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(1);
 if(repair==='ineffective'){
  result=await pipeline.runNext('w',result!.availableAt);
  expect(result).toMatchObject({state:'failed',error:'invalid_replacement',outputFailures:2});expect(generated).toBe(1);expect(repairs).toBe(1);expect(audits).toBe(3);expect(await pipeline.runNext('w',result!.availableAt)).toBeNull();
  const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(saved.checked).toEqual(before.checked);expect(saved.repairs).toEqual([1]);expect(s.memory.read(root,old.recordId).status).toBe('active');expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(1);return;
 }
 result=await pipeline.runNext('w',result!.availableAt);expect(result).toMatchObject({error:null,state:'queued',stage:'scene'});expect(generated).toBe(1);expect(repairs).toBe(1);expect(audits).toBe(3);
 const active=s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2');expect(active).toHaveLength(4);expect(active.filter(r=>r.semanticKey==='scene.0').map(r=>r.text)).toEqual(expect.arrayContaining(['数据库 PostgreSQL，描述一。','数据库 PostgreSQL，描述二。']));expect(s.memory.read(root,old.recordId).status).toBe('superseded');
 for(const table of ['memory_output_drafts','memory_output_verifications'])expect(s.store.database.prepare(`SELECT data FROM ${table} WHERE job_id=?`).get(job.id)).toBeUndefined();
});
test('a final apply rejection removes only its audited slot before retrying the atomic stage',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let targetApplications=0,repairs=0,audits=0;
 const apply=s.memory.applyProposal;s.memory.applyProposal=(...args)=>{if(args[1].semanticKey==='scene.1'&&++targetApplications===2)throw new DomainError('invalid_proposal',422,'synthetic_final_apply_rejection');return apply(...args);};
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.repairDrafts){repairs++;expect(input.repairDrafts).toEqual([s.scene(1)]);return input.repairDrafts;}
  if(input.stage!=='verify')return s.texts.map((_,i)=>s.scene(i));audits++;return input.batchItems?input.batchItems.map(item=>({...item.draft!,batchItemId:item.id})):input.drafts!;
 }});
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('invalid_proposal');
 const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(Object.keys(saved.checked)).toEqual(['0','2','3']);expect(saved.repairs).toEqual([1]);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toEqual([]);
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({error:null});expect(repairs).toBe(1);expect(audits).toBe(2);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(4);
});
test('a completed verified request L1 is reused by session while own summary and context remain',async()=>{
 const s=setup(false);let extracts=0,summaryOnly=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return {proposals:input.drafts!,summary:input.draftSummary};
  if(input.stage==='extract'){extracts++;if((input as MemoryGeneratorInput & {summaryOnly?:boolean}).summaryOnly){summaryOnly++;return {proposals:[],summary:'独立会话摘要。'};}return {proposals:[s.atom(s.texts[0])],summary:'独立会话摘要。'};}
  if(input.stage==='scene')return [{...s.atom(s.texts[0]),layer:'L2',semanticKey:'scene.0',support:[],dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision}))}];
  if(input.stage==='profile')return [{...s.atom(s.texts[0]),layer:'L3',support:[],dependencies:input.records.filter(r=>r.layer==='L2').map(({recordId,revision})=>({recordId,revision}))}];
  if(input.stage==='consolidate')return [{...s.atom(s.texts[0]),layer:'L2',support:[],semanticKey:'session.context',dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision}))}];
  return [];
 }});
 for(let i=0;i<5&&s.jobs.list(root)[0].state!=='completed';i++)await pipeline.runNext('w');expect(s.jobs.list(root)[0].state).toBe('completed');
 s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});
 for(let i=0;i<5&&s.jobs.list(root).at(-1)!.state!=='completed';i++)await pipeline.runNext('w');
 expect(summaryOnly).toBe(1);expect(extracts).toBe(2);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L1')).toHaveLength(1);
 expect(s.store.database.prepare('SELECT COUNT(*) n FROM memory_session_summaries').get()?.n).toBe(1);expect(s.memory.listAll(root,{status:'active'}).some(r=>r.semanticKey==='session.context')).toBe(true);
});
test('conflict batches bind IDs and isolate one crossed item without replaying valid decisions',async()=>{
 const s=setup(),calls:number[]=[],atoms=s.texts.map(text=>s.atom(text));
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return atoms;
  if(input.stage!=='conflict')return [];
  const items=input.batchItems;calls.push(input.atoms!.length);
  if(calls.length===1){expect(items).toHaveLength(4);return items!.map((item,index)=>({...item.atom!,batchItemId:item.id,...index===1?{support:atoms[0].support}:{}}));}
  expect(input.atoms).toHaveLength(1);return input.atoms!;
 }});
 await pipeline.runNext('w');const failed=await pipeline.runNext('w');expect(failed?.error).toBe('invalid_conflict_decision');
 const checkpoint=JSON.parse(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(failed!.id)!.data as string);expect(checkpoint.completed).toHaveLength(3);
 expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({error:null,stage:'scene'});expect(calls).toEqual([4,1]);
});
test('conflicts that share an old target remain sequential with freshly read revisions',async()=>{
 const s=setup(false),texts=['包管理 pnpm。','包管理 pnpm。','包管理 pnpm。'];s.memory.applyProposal(root,s.atom(s.texts[1]),s.c.generation,'evidence_extract');const revisions:number[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return texts.map(text=>s.atom(text));
  if(input.stage==='conflict'){expect(input.batchItems).toBeUndefined();expect(input.atoms).toHaveLength(1);revisions.push(input.records[0].revision);return input.atoms!;}return [];
 }});await pipeline.runNext('w');expect(await pipeline.runNext('w')).toMatchObject({error:null});expect(revisions).toHaveLength(3);expect(revisions).toEqual([...revisions].sort((a,b)=>a-b));
});
test.each(['failed','partial','version','principal','source','revision','generation','expired'] as const)('verified L1 reuse rejects %s mismatch',async mismatch=>{
 const s=setup();const {createMemoryL1Reuse}=await import('../server/memory-l1-reuse'),reuse=createMemoryL1Reuse(s.memory),job=s.jobs.list(root)[0];reuse.save(job,[s.source]);
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),job.id);
 let candidate={...job,id:'new-session',kind:'session' as const,extractorVersion:'session-v2'},sources=[s.source];
 if(mismatch==='failed'||mismatch==='partial')s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:mismatch==='failed'?'failed':'queued'}),job.id);
 if(mismatch==='version')candidate.extractorVersion='session-v3';
 if(mismatch==='principal')candidate.principal={userId:'local',agentId:'a'};
 if(mismatch==='source')sources=[{...s.source,fingerprint:'changed'}];
 if(mismatch==='revision')sources=[{...s.source,revision:2}];
 if(mismatch==='generation')candidate.generation++;
 if(mismatch==='expired'){const fact=s.facts[0];s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...fact,validUntil:'2000-01-01T00:00:00Z'}),fact.recordId);}
 expect(reuse.find(candidate,sources)).toEqual({sources:[],facts:[]});
});
test('reuse requires original event/source identity rather than matching text',async()=>{
 const s=setup();const {createMemoryL1Reuse}=await import('../server/memory-l1-reuse'),reuse=createMemoryL1Reuse(s.memory),job=s.jobs.list(root)[0];reuse.save(job,[s.source]);s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),job.id);
 expect(reuse.find({...job,id:'session',kind:'session',extractorVersion:'session-v2'},[{...s.source,id:'equivalent-text-different-source'}])).toEqual({sources:[],facts:[]});
 expect(reuse.find({...job,id:'session',kind:'session',extractorVersion:'session-v2'},[s.source]).facts).toHaveLength(4);
});
test('agent authorized reuse works and harmless pipeline provenance append preserves exact source reuse',async()=>{
 const s=setup();const {createMemoryL1Reuse}=await import('../server/memory-l1-reuse'),reuse=createMemoryL1Reuse(s.memory),job={...s.jobs.list(root)[0],principal:{...root,agentId:'a'}};
 reuse.save(job,[s.source]);s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),job.id);
 const before=s.facts[0];s.memory.applyProposal(root,{...s.atom(s.texts[0]),pipeline:'session'},s.c.generation,'evidence_extract');
 const result=reuse.find({...job,id:'session',kind:'session',extractorVersion:'session-v2'},[s.source]);expect(result.sources).toHaveLength(1);expect(result.facts).toHaveLength(4);expect(result.facts.find(r=>r.recordId===before.recordId)!.revision).toBe(before.revision+1);
});
test('completed session facts bypass later request extraction while request scene stays independent',async()=>{
 const s=setup(false);s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});let requestExtracts=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return {proposals:input.drafts!,summary:input.draftSummary};
  if(input.stage==='extract'){if(input.job.kind==='request')requestExtracts++;return {proposals:[s.atom(s.texts[0])],summary:'会话摘要。'};}
  if(input.stage==='scene'||input.stage==='consolidate')return [{...s.atom(s.texts[0]),layer:'L2',semanticKey:input.stage==='scene'?'scene.request':'session.context',support:[],dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision}))}];
  if(input.stage==='profile')return [{...s.atom(s.texts[0]),layer:'L3',support:[],dependencies:input.records.filter(r=>r.layer==='L2').map(({recordId,revision})=>({recordId,revision}))}];return [];
 }});
 for(let i=0;i<4&&s.jobs.list(root).at(-1)!.state!=='completed';i++)await pipeline.runNext('w',undefined,['session']);expect(s.jobs.list(root).at(-1)!.state).toBe('completed');
 for(let i=0;i<4&&s.jobs.list(root)[0].state!=='completed';i++)await pipeline.runNext('w',undefined,['request']);
 expect(requestExtracts).toBe(0);expect(s.jobs.list(root)[0]).toMatchObject({state:'completed',error:null});
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L1')).toEqual([expect.objectContaining({pipelines:expect.arrayContaining(['request','session'])})]);expect(s.memory.listAll(root,{status:'active'}).map(r=>r.semanticKey)).toEqual(expect.arrayContaining(['scene.request','session.context']));
});
test('a batch transport failure splits every pending review into singleton retries',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let reviews=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage!=='verify')return s.texts.map((_,i)=>s.scene(i));reviews++;
  if(reviews===1){expect(input.batchItems).toHaveLength(4);throw new Error('generation_timed_out');}
  expect(input.batchItems).toBeUndefined();expect(input.drafts).toHaveLength(1);return input.drafts!;
 }});
 const failed=await pipeline.runNext('w');expect(failed?.error).toBe('generation_timed_out');expect(await pipeline.runNext('w',failed!.availableAt)).toMatchObject({error:null});expect(reviews).toBe(5);
});
test('an already expired L1 cannot create a successful empty reusable manifest',async()=>{
 const s=setup();const fact=s.facts[0];s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...fact,validUntil:'2000-01-01T00:00:00Z'}),fact.recordId);
 const {createMemoryL1Reuse}=await import('../server/memory-l1-reuse'),reuse=createMemoryL1Reuse(s.memory),job=s.jobs.list(root)[0];reuse.save(job,[s.source]);s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),job.id);
 expect(reuse.find({...job,id:'session',kind:'session',extractorVersion:'session-v2'},[s.source])).toEqual({sources:[],facts:[]});
});
test('mixed reused and fresh session sources keep complete context while extracting only the fresh source',async()=>{
 const s=setup(false);let mixedCalls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return {proposals:input.drafts!,summary:input.draftSummary};
  if(input.stage==='extract'){
   if(input.job.kind==='request')return [s.atom(s.texts[0])];
   mixedCalls++;expect(input.summaryOnly).toBe(false);expect(input.sources).toHaveLength(2);expect(input.context!.requests.join('')).toContain(s.texts[0]);expect(input.context!.requests.join('')).toContain('新增 CI 规则。');expect(input.reusableSourceRefs).toEqual([{sourceId:s.source.id,sourceRevision:1}]);
   const fresh=input.sources.find(source=>source.id!==s.source.id)!,event=fresh.events.find(event=>event.kind==='user')!;
   return {proposals:[{...s.atom('新增 CI 规则。'),evidence:[{sourceId:fresh.id,sourceRevision:fresh.revision}],support:[{sourceId:fresh.id,eventId:event.id,quote:event.text}]}],summary:'原有数据库规则和新增 CI 规则。'};
  }
  if(input.stage==='scene'||input.stage==='consolidate')return [{...s.atom(s.texts[0]),layer:'L2',semanticKey:input.stage==='scene'?'scene.original':'session.context',support:[],dependencies:input.records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision}))}];
  if(input.stage==='profile')return [{...s.atom(s.texts[0]),layer:'L3',support:[],dependencies:input.records.filter(r=>r.layer==='L2').map(({recordId,revision})=>({recordId,revision}))}];return [];
 }});
 for(let i=0;i<5&&s.jobs.list(root)[0].state!=='completed';i++)await pipeline.runNext('w');expect(s.jobs.list(root)[0].state).toBe('completed');
 s.store.appendEvent(s.chat.id,'user',{text:'新增 CI 规则。'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});
 for(let i=0;i<4&&s.jobs.list(root).at(-1)!.state!=='completed';i++)await pipeline.runNext('w');
 expect(s.jobs.list(root).at(-1)).toMatchObject({state:'completed',error:null});expect(mixedCalls).toBe(1);expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L1')).toHaveLength(2);
 const summary=JSON.parse(s.store.database.prepare('SELECT data FROM memory_session_summaries').get()!.data as string);expect(summary.dependencies).toHaveLength(2);expect(summary.text).toContain('原有数据库规则');
});
test('changed parent authority preserves audit checkpoints when the single retry budget is exhausted',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);let audits=0,repairs=0,replacement=s.facts[0];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.repairDrafts){repairs++;expect(input.repairDrafts).toHaveLength(1);expect(input.repairDrafts![0].semanticKey).toBe('scene.0');return [{...input.repairDrafts![0],text:replacement.text,evidence:replacement.evidence,dependencies:[{recordId:replacement.recordId,revision:replacement.revision}]}];}
  if(input.stage!=='verify')return s.texts.map((_,i)=>s.scene(i));
  audits++;if(audits===1)return input.batchItems!.map((item,index)=>({...item.draft!,batchItemId:item.id,...index===1?{semanticKey:'scene.wrong'}:{}}));
  expect(input.drafts).toHaveLength(1);return input.drafts!;
 }});
 const first=await pipeline.runNext('w');expect(first?.error).toBe('verification_identity_changed');
 const before=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(Object.keys(before.checked)).toEqual(['0','2','3']);
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null}),event=s.store.appendEvent(chat.id,'user',{text:'数据库 SQLite。'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const capture=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=capture.sources[0];for(const fresh of capture.jobs)s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...fresh,state:'obsolete',error:'synthetic_fixture'}),fresh.id);
 replacement=s.memory.applyProposal(root,{...s.atom('数据库 SQLite。'),operation:'update',replaces:[{recordId:s.facts[0].recordId,revision:s.facts[0].revision}],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:'数据库 SQLite。'}]},s.c.generation,'evidence_extract',{conflictResolved:true})!;
 expect(s.memory.collection(root,s.c.id).generation).toBe(s.c.generation);
 const invalidated=await pipeline.runNext('w',first!.availableAt);expect(invalidated?.id).toBe(job.id);expect(invalidated?.error).toBe('dependency_not_provided');
 const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_output_verifications WHERE job_id=?').get(job.id)!.data as string);expect(Object.keys(saved.checked)).toEqual(['2','3']);expect(saved.repairs).toEqual([0]);expect(saved.isolated).toContain(0);expect(saved.checked[2]).toEqual(before.checked[2]);expect(saved.checked[3]).toEqual(before.checked[3]);
 expect(invalidated).toMatchObject({state:'failed',failureCount:2});
 expect(await pipeline.runNext('w',invalidated!.availableAt)).toBeNull();expect(repairs).toBe(0);expect(audits).toBe(1);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(0);
});
test.each(['merge','update'] as const)('a legal same-item conflict %s can choose the supported resulting content type',async operation=>{
 const s=setup(),pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return [s.atom(s.texts[0])];
  if(input.stage==='conflict')return [{...input.atoms![0],contentType:'procedure',operation,replaces:input.records.map(({recordId,revision})=>({recordId,revision}))}];return [];
 }});await pipeline.runNext('w');expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});
 expect(s.memory.listAll(root,{status:'active'}).find(r=>r.text===s.texts[0])).toMatchObject({contentType:'procedure'});
});
test('legal reclassified batch merges still reject another source identity and retain valid decisions',async()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});s.store.appendEvent(chat.id,'user',{text:'其他证据。'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const capture=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),other=capture.sources[0];for(const fresh of capture.jobs)s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...fresh,state:'obsolete',error:'synthetic_fixture'}),fresh.id);let calls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return s.texts.map(text=>s.atom(text));if(input.stage!=='conflict')return [];calls++;
  if(calls===1)return input.batchItems!.map((item,index)=>({...item.atom!,batchItemId:item.id,contentType:'procedure' as const,operation:'merge' as const,replaces:item.records.map(({recordId,revision})=>({recordId,revision})),...index===1?{evidence:[{sourceId:other.id,sourceRevision:1}]}:{}}));
  return [{...input.atoms![0],contentType:'procedure',operation:'merge',replaces:input.records.map(({recordId,revision})=>({recordId,revision}))}];
 }});await pipeline.runNext('w');const rejected=await pipeline.runNext('w');expect(rejected?.error).toBe('invalid_conflict_decision');
 const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(rejected!.id)!.data as string);expect(saved.completed).toEqual([0,2,3]);
 expect(await pipeline.runNext('w',rejected!.availableAt)).toMatchObject({error:null,stage:'scene'});expect(calls).toBe(2);
});
test('summary-only reuse preserves bounded evidence ranges and their exact quote proof',async()=>{
 const s=setup(false),eventId=s.atom(s.texts[0]).support![0].eventId,bounded={...s.atom(s.texts[0]),evidence:[{sourceId:s.source.id,sourceRevision:1,startEventId:eventId,endEventId:eventId}]};
 const fact=s.memory.applyProposal(root,bounded,s.c.generation,'evidence_extract')!,job=s.jobs.list(root)[0],{createMemoryL1Reuse}=await import('../server/memory-l1-reuse'),reuse=createMemoryL1Reuse(s.memory);reuse.save(job,[s.source]);s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),job.id);
 s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:s.chat.id,trigger:'explicit',kind:'session'});let summaries=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return {proposals:input.drafts!,summary:input.draftSummary};
  if(input.stage==='extract'){expect(input.summaryOnly).toBe(true);expect(input.reusableFacts).toHaveLength(1);summaries++;return {proposals:[],summary:'带精确事件证据的会话摘要。'};}
  return [];
 }});expect(await pipeline.runNext('w',undefined,['session'])).toMatchObject({stage:'consolidate',error:null});expect(summaries).toBe(1);
 const saved=s.memory.read(root,fact.recordId);expect(saved.pipelines).toContain('session');expect(saved.evidence).toEqual(bounded.evidence);expect(saved.support).toEqual(bounded.support);
 const summary=JSON.parse(s.store.database.prepare('SELECT data FROM memory_session_summaries').get()!.data as string);expect(summary.dependencies).toEqual([{recordId:saved.recordId,revision:saved.revision}]);
});
test('a conflict item cannot attach another batch item dependency while valid siblings checkpoint and retry stays isolated',async()=>{
 const s=setup();let calls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return s.texts.map(text=>s.atom(text));if(input.stage!=='conflict')return [];calls++;
  if(calls===1){const foreign=input.batchItems![1].records[0];return input.batchItems!.map((item,index)=>({...item.atom!,batchItemId:item.id,...index===0?{dependencies:[{recordId:foreign.recordId,revision:foreign.revision}]}:{}}));}
  expect(input.batchItems).toBeUndefined();expect(input.atoms).toHaveLength(1);expect(input.atoms![0].text).toBe(s.texts[0]);return input.atoms!;
 }});
 await pipeline.runNext('w');const rejected=await pipeline.runNext('w');expect(rejected?.error).toBe('invalid_conflict_decision');
 const saved=JSON.parse(s.store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(rejected!.id)!.data as string);expect(saved.completed).toEqual([1,2,3]);expect(saved.isolated).toEqual([0]);expect(s.memory.read(root,s.facts[0].recordId).dependencies).toEqual([]);
 expect(await pipeline.runNext('w',rejected!.availableAt)).toMatchObject({stage:'scene',error:null});expect(calls).toBe(2);expect(s.memory.read(root,s.facts[0].recordId).dependencies).toEqual([]);
});
test('a conflict batch preserves a legal dependency already bound to its original atom',async()=>{
 const s=setup(),dependency={recordId:s.facts[1].recordId,revision:s.facts[1].revision};let calls=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='extract')return s.texts.map((text,index)=>({...s.atom(text),...index===0?{dependencies:[dependency]}:{}}));if(input.stage!=='conflict')return [];calls++;expect(input.batchItems).toHaveLength(4);return input.batchItems!.map(item=>({...item.atom!,batchItemId:item.id}));
 }});
 await pipeline.runNext('w');expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',error:null});expect(calls).toBe(1);expect(s.memory.read(root,s.facts[0].recordId).dependencies).toEqual([dependency]);
});

test('derived review keeps its originally supplied facts when newer facts displace the next candidate page',async()=>{
 const s=setup(),job=s.jobs.list(root)[0];
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,stage:'scene'}),job.id);
 let generations=0,audits=0;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage!=='verify'){generations++;return [s.scene(0),s.scene(1)];}
  audits++;return input.drafts!;
 }});
 const first=await pipeline.runNext('w');expect(first?.error).toBeNull();
 const text=Array.from({length:22},(_,i)=>`新事实${i}。`).join(''),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});
 const event=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const fresh=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=fresh.sources[0];
 for(const captured of fresh.jobs)s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...captured,state:'obsolete'}),captured.id);
 for(let i=0;i<22;i++)s.memory.applyProposal(root,{...s.atom(`新事实${i}。`),evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:`新事实${i}。`}]},s.c.generation,'evidence_extract');
 createMemoryScenes(s.memory).commit(s.c.id,s.facts,new Date().toISOString());
 const second=await pipeline.runNext('w',first!.availableAt);expect(second?.error).toBeNull();
 expect(generations).toBe(1);expect(audits).toBe(2);
 expect(s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L2')).toHaveLength(2);
});
