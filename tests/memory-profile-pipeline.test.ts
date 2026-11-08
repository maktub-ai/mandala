import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import {createMemoryJobs} from '../server/memory-jobs';
import {createMemoryProfiles} from '../server/memory-profiles';
import {createMemoryPipeline} from '../server/memory-pipeline';
import type {MemoryProposal} from '../shared/memory';
const root={userId:'local'},cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-profile-pipeline-')),store=openStore(home),assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeProject:(p,id)=>{if(p.agentId&&(id!=='p'||!['a','b'].includes(p.agentId)))throw new Error('forbidden');}}),jobs=createMemoryJobs(store,memory),c=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const scenes=['a','b'].map(agentId=>{
  const chat=store.createConversation({projectId:'p',agentId,cli:'codex',model:null}),text='Verify '+agentId+' deliveries.';
  const e=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
  const capture=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=capture.sources[0];
  const atom:MemoryProposal={collectionId:c.id,layer:'L1',contentType:'procedure',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:e.id,quote:text}],dependencies:[],validUntil:null,certainty:'user_asserted'};
  const fact=memory.applyProposal(root,atom,c.generation,'evidence_extract')!;
  return memory.applyProposal(root,{...atom,layer:'L2',semanticKey:'scene.'+agentId,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary')!;
 });
 const queued=jobs.list(root),job={...queued[0],stage:'scene' as const,sourceRefs:queued.flatMap(j=>j.sourceRefs)};
 store.database.prepare('DELETE FROM memory_jobs').run();store.database.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(job.id,'combined',JSON.stringify(job));
 return {store,memory,jobs,scenes,c,job};
}
const proposal=(input:any):MemoryProposal=>{
 const scenes=input.records.filter((r:any)=>r.layer==='L2'),old=input.records.find((r:any)=>r.layer==='L3');
 return {collectionId:input.job.collectionId,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',text:'Verify project deliveries with evidence.',operation:old?'update':'store',replaces:old?[{recordId:old.recordId,revision:old.revision}]:[],evidence:scenes.flatMap((r:any)=>r.evidence),support:[],dependencies:scenes.map((r:any)=>({recordId:r.recordId,revision:r.revision})),validUntil:null,certainty:'observed'};
};
test('a coalesced project request fans out independent profile jobs for its two agents',async()=>{
 const s=setup(),seen:string[]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>{
  if(input.stage==='profile'){seen.push((input as any).profileScope.agentId);return [proposal(input)];}
  return s.scenes.map(r=>({...proposal({...input,records:[r]}),layer:'L2',semanticKey:r.semanticKey,operation:'skip',text:r.text,replaces:[{recordId:r.recordId,revision:r.revision}],dependencies:r.dependencies,evidence:r.evidence}));
 }});
 let now=new Date().toISOString();
 for(let i=0;i<10;i++){const result=await pipeline.runNext('w',now);if(!result)break;now=new Date(Math.max(Date.parse(now),Date.parse(result.availableAt))).toISOString();}
 expect(seen.sort()).toEqual(['a','b']);
 const profiles=s.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L3');
 expect(profiles).toHaveLength(2);expect(profiles.map(r=>(r as any).profileScope.agentId).sort()).toEqual(['a','b']);
});
test('multiple L3 drafts are rejected atomically before any profile is published',async()=>{
 const s=setup();s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'profile',profileScope:{projectId:'p',agentId:'a'}}),s.job.id);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async input=>[proposal(input),{...proposal(input),text:'Second document.'}]});
 expect(await pipeline.runNext('w')).toMatchObject({error:'profile_multiple_results'});
 expect(s.memory.listAll(root).filter(r=>r.layer==='L3')).toEqual([]);
});

test('profile failures allow only one retry, including progress advances between failures',()=>{
 const s=setup(),now=new Date().toISOString();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'profile',profileScope:{projectId:'p',agentId:'a'}}),s.job.id);
 let job=s.jobs.claim('w',now)!;s.jobs.fail(job.id,job.leaseToken,'network_disconnected',now);
 const retry=s.jobs.list(root)[0];expect(retry).toMatchObject({state:'queued',failureCount:1});
 job=s.jobs.claim('w',retry.availableAt)!;s.jobs.advance(job,'profile',retry.availableAt);
 job=s.jobs.claim('w',retry.availableAt)!;s.jobs.fail(job.id,job.leaseToken,'network_disconnected',retry.availableAt);
 expect(s.jobs.list(root)[0]).toMatchObject({state:'failed',failureCount:2});expect(s.jobs.claim('w','2050-01-01T00:00:00Z')).toBeNull();
});
test('expired profile leases consume the same bounded retry budget',()=>{
 const s=setup();s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'profile',profileScope:{projectId:'p',agentId:'a'}}),s.job.id);
 const first=s.jobs.claim('w')!,second=s.jobs.claim('restarted',first.leaseUntil!)!;
 expect(second.failureCount).toBe(1);expect(s.jobs.claim('restarted-again',second.leaseUntil!)).toBeNull();expect(s.jobs.list(root)[0]).toMatchObject({state:'failed',failureCount:2});
});
test('a paused profile does not consume its retry budget',()=>{
 const s=setup();s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'profile',profileScope:{projectId:'p',agentId:'a'}}),s.job.id);
 const job=s.jobs.claim('w')!;s.jobs.fail(job.id,job.leaseToken,'memory_generation_disabled');
 expect(s.jobs.list(root)[0]).toMatchObject({state:'queued'});expect(s.jobs.list(root)[0].failureCount).toBe(0);
});
test('bootstrap and checkpoints are independent for agents sharing existing scenes',()=>{
 const s=setup(),profiles=createMemoryProfiles(s.memory),a={projectId:'p',agentId:'a'},b={projectId:'p',agentId:'b'};
 const first=profiles.schedule(a)!,other=profiles.schedule(b)!;expect(first.id).not.toBe(other.id);expect(profiles.schedule(a)?.id).toBe(first.id);
 const draft=proposal({job:first,records:profiles.records(a)});s.memory.applyProposal(root,draft,s.c.generation,'layer_summary',{profileScope:a});profiles.committed(a,new Date().toISOString());
 expect(profiles.should(a,profiles.records(a))).toBe(false);expect(profiles.should(b,profiles.records(b))).toBe(true);
});

test('pausing an already claimed legacy profile retry preserves its durable one-failure budget',()=>{
 const s=setup(),job={...s.job,stage:'profile' as const,profileScope:{projectId:'p',agentId:'a'},state:'running',attempt:2,leaseToken:7,leaseUntil:'2050-01-01T00:00:00Z',error:'network_disconnected',profileFailures:1,outputFailures:0};
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(job),job.id);
 s.jobs.fail(job.id,job.leaseToken,'memory_generation_disabled');
 expect(s.jobs.list(root)[0]).toMatchObject({state:'queued',failureCount:1,profileFailures:1});
 const retry=s.jobs.list(root)[0],claimed=s.jobs.claim('w',retry.availableAt)!;s.jobs.fail(claimed.id,claimed.leaseToken,'network_disconnected',retry.availableAt);
 expect(s.jobs.list(root)[0]).toMatchObject({state:'failed',failureCount:2});
});
