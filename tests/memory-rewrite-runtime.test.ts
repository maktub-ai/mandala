import {readConfiguredRuntime} from './configured-runtime';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createMemoryRuntime } from '../server/memory-runtime';
import type { SystemGenerator } from '../server/system-tasks';
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const fn of cleanup.splice(0))await fn();});
async function setup(){const home=mkdtempSync(join(tmpdir(),'memory-rewrite-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config,generate=vi.fn<SystemGenerator>(async()=> '[]');const runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home,store,loadConfig:async()=>config,generate});cleanup.push(async()=>{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});return {home,store,config,runtime,generate};}
function turn(s:Awaited<ReturnType<typeof setup>>){const chat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'I work on synthetic billing reports.'});s.store.appendEvent(chat.id,'text',{text:'Understood.'});s.store.appendEvent(chat.id,'status',{status:'idle'});return s.store.getConversation(chat.id)!;}
test('OMP derived generation and verification request low while extraction requests off',async()=>{
 const s=await setup();await s.runtime.close();s.config.system={cli:'omp',tasks:{memory:{cli:'omp',model:'synthetic/model'}}};
 const calls:{stage:string;reviewStage?:string;thinking?:string}[]=[];
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>s.config,schedule:false,generate:async(selected,prompt)=>{
  const d=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);calls.push({stage:d.stage,reviewStage:d.reviewStage,thinking:selected.thinking});if(d.stage==='verify')return JSON.stringify(d.drafts);
  const ref=d.sources[0],event=ref.events?.find((e:any)=>e.kind==='user'),layer=d.stage==='extract'?'L1':d.stage==='scene'?'L2':'L3';
  return JSON.stringify([{collectionId:d.collectionId,layer,contentType:'fact',text:'Synthetic billing reports.',semanticKey:layer==='L1'?'billing.work':layer==='L2'?'scene.billing':'persona.operating-doctrine',operation:'store',replaces:[],evidence:[{sourceId:ref.id,sourceRevision:ref.revision}],support:layer==='L1'?[{sourceId:ref.id,eventId:event.id,quote:event.text}]:[],dependencies:layer==='L1'?[]:d.records.filter((r:any)=>r.layer===(layer==='L2'?'L1':'L2')).map((r:any)=>({recordId:r.recordId,revision:r.revision})),validUntil:null,certainty:'observed'}]);
 }});cleanup.push(()=>runtime.close());const chat=turn(s);await runtime.captureConversation(chat.id);await runtime.drain();
 expect(runtime.jobs.list({userId:'local'})[0].state).toBe('completed');expect(calls.filter(c=>c.stage==='verify'&&c.reviewStage!=='extract').map(c=>c.thinking)).toEqual(['low','low']);expect(calls.filter(c=>['scene','profile','consolidate'].includes(c.stage)).every(c=>c.thinking==='low')).toBe(true);expect(calls.filter(c=>c.stage==='extract'||c.stage==='conflict'||c.stage==='verify'&&c.reviewStage==='extract').every(c=>c.thinking==='off')).toBe(true);
});
test('leases cover model deadline and transient failures retry only once',async()=>{const s=await setup(),chat=turn(s);await s.runtime.captureConversation(chat.id,'completed');const now=Date.now();for(let attempt=0;attempt<2;attempt++){const at=new Date(now+attempt*3600000).toISOString(),job=s.runtime.jobs.claim('worker',at)!;expect(job).toBeTruthy();expect(Date.parse(job.leaseUntil!)-Date.parse(at)).toBeGreaterThanOrEqual(180000);s.runtime.jobs.fail(job.id,job.leaseToken,'quota_exhausted',at);}expect(s.runtime.jobs.list({userId:'local'})[0]).toMatchObject({state:'failed',attempt:2,error:'quota_exhausted'});});
test('defaults enable deep-memory reads and generation; retired summary settings cannot re-enable reads',async()=>{const s=await setup();expect(await s.runtime.getSettings()).toEqual({request:{generate:true,read:true},session:{generate:false,read:false},idleHours:6});s.config.system={cli:'codex',memory:{request:{generate:true,read:false},session:{generate:false,read:true},idleHours:2}};expect(await s.runtime.reading({userId:'local'})).toEqual([]);const chat=turn(s);await s.runtime.scan(Date.parse(chat.updatedAt!)+3*3600000);expect(s.runtime.jobs.list({userId:'local'}).map(j=>j.kind)).toEqual(['request']);});
test('shared project memory requires current configured membership and revocation takes effect',async()=>{const s=await setup();s.config.projects=[{id:'project',name:'Project',agentIds:['author','reader'],cwd:'.',resources:[],mcp:[],skills:[]}];const chat=s.store.createConversation({projectId:'project',agentId:'author',cli:'codex',model:null});const event=s.store.appendEvent(chat.id,'user',{text:'Synthetic project reports use daily aggregates.'});s.store.appendEvent(chat.id,'status',{status:'idle'});const capture=await s.runtime.captureConversation(chat.id),source=capture.sources[0],collection=s.runtime.memory.collection({userId:'local'},source.collectionId);const record=s.runtime.memory.applyProposal({userId:'local'},{collectionId:collection.id,layer:'L1',contentType:'fact',text:'Synthetic project reports use daily aggregates.',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:'Synthetic project reports use daily aggregates.'}],validUntil:null,certainty:'user_asserted',pipeline:'request'},collection.generation,'evidence_extract')!;expect(s.runtime.memory.read({userId:'local',agentId:'reader'},record.recordId,'project').text).toContain('daily aggregates');expect(()=>s.runtime.memory.read({userId:'local',agentId:'outsider'},record.recordId,'project')).toThrow('Project membership required');s.config.projects[0].agentIds=['author'];await s.runtime.getSettings();expect(()=>s.runtime.memory.read({userId:'local',agentId:'reader'},record.recordId,'project')).toThrow('Project membership required');});
test('turning generation off while native extraction runs discards the returned result',async()=>{
 const s=await setup(),chat=turn(s);s.config.system={cli:'codex',memory:{request:{generate:true,read:true},session:{generate:false,read:true}}};
 let release!:(value:string)=>void;s.generate.mockImplementation(()=>new Promise<string>(resolve=>{release=resolve;}));
 await s.runtime.captureConversation(chat.id);const pending=s.runtime.drain();await vi.waitFor(()=>expect(s.generate).toHaveBeenCalledOnce());
 s.config.system.memory!.request!.generate=false;release('[]');await pending;
 expect(s.runtime.jobs.list({userId:'local'})[0]).toMatchObject({stage:'extract',state:'queued',error:'memory_generation_disabled'});
 expect(s.runtime.memory.listAll({userId:'local'})).toEqual([]);
});
test('quota backoff avoids repeated model calls until the retry time and permits recovery',async()=>{
 const s=await setup(),chat=turn(s);await s.runtime.captureConversation(chat.id);const at=new Date().toISOString(),job=s.runtime.jobs.claim('worker',at)!;
 s.runtime.jobs.fail(job.id,job.leaseToken,'System task failed: quota-exhausted (response)',at);
 const failed=s.runtime.jobs.list({userId:'local'})[0];expect(Date.parse(failed.availableAt)-Date.parse(at)).toBe(15*60000);
 expect(s.runtime.jobs.claim('worker',new Date(Date.parse(at)+60000).toISOString())).toBeNull();
 expect(s.runtime.jobs.claim('worker',failed.availableAt)).toMatchObject({id:job.id,state:'running'});
});


test('production request scheduling survives restart, batches warmup and honors idle deadline',async()=>{
 const s=await setup();await s.runtime.close();vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
 let runtime=createMemoryRuntime({verifyOutput:false,home:s.home,store:s.store,loadConfig:async()=>s.config,generate:async()=>JSON.stringify([])});cleanup.push(async()=>{await runtime.close();});
 const chat=turn(s);await runtime.captureConversation(chat.id);await runtime.drain();
 const first=runtime.jobs.list({userId:'local'})[0];expect(first).toMatchObject({stage:'scene',state:'queued'});expect(Date.parse(first.availableAt)-Date.now()).toBe(10000);
 await vi.advanceTimersByTimeAsync(10001);await runtime.drain();expect(runtime.jobs.list({userId:'local'})[0].state).toBe('completed');
 s.store.appendEvent(chat.id,'user',{text:'项目版本为2。'});s.store.appendEvent(chat.id,'status',{status:'idle'});s.store.completeConversation(chat.id,true);await runtime.captureConversation(chat.id);
 const buffered=runtime.jobs.list({userId:'local'}).find(j=>j.state==='queued')!;expect(Date.parse(buffered.availableAt)-Date.now()).toBe(600000);await runtime.close();
 runtime=createMemoryRuntime({verifyOutput:false,home:s.home,store:s.store,loadConfig:async()=>s.config,generate:async()=>JSON.stringify([])});await runtime.scan();expect(runtime.jobs.list({userId:'local'}).find(j=>j.id===buffered.id)!.availableAt).toBe(buffered.availableAt);
 await vi.advanceTimersByTimeAsync(600001);await runtime.drain();expect(runtime.jobs.list({userId:'local'}).find(j=>j.id===buffered.id)!.stage).toBe('scene');await runtime.close();vi.useRealTimers();
});


test('revoked sole source schedules and retracts its stale scene in the new generation',async()=>{
 const s=await setup(),root={userId:'local'};await s.runtime.close();
 const runtime=createMemoryRuntime({verifyOutput:false,home:s.home,store:s.store,loadConfig:async()=>s.config,generate:async(_c,p)=>{const d=JSON.parse(p.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);if(d.stage!=='scene')return '[]';const stale=d.records.find((r:any)=>r.status==='stale');return JSON.stringify([{collectionId:d.collectionId,layer:'L2',contentType:stale.contentType,text:stale.text,semanticKey:stale.semanticKey,operation:'retract',replaces:[{recordId:stale.recordId,revision:stale.revision}],evidence:stale.evidence,support:[],dependencies:[],validUntil:null,certainty:'observed'}]);}});cleanup.push(async()=>runtime.close());
 const chat=turn(s),c=runtime.memory.ensureCollection(root,{projectId:null,agentId:null}),source=runtime.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],event=source.events.find(e=>e.kind==='user')!;
 const proposal={collectionId:c.id,layer:'L1' as const,contentType:'fact' as const,text:event.text,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],validUntil:null,certainty:'user_asserted' as const};const fact=runtime.memory.applyProposal(root,proposal,c.generation,'evidence_extract')!;
 const scene=runtime.memory.applyProposal(root,{...proposal,layer:'L2',text:'合成报表场景',semanticKey:'scene.billing',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary')!;
 runtime.memory.retractSource(root,{sourceId:source.id,expectedRevision:1});await runtime.scan();await runtime.drain();const raw=JSON.parse(String(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(scene.recordId)?.data));expect(raw.status).toBe('retracted');expect(runtime.jobs.list(root).some(j=>j.generation===2&&j.stage==='scene'&&j.state==='completed')).toBe(true);
});
