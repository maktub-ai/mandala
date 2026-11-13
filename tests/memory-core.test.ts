import { evidenceFixture } from './memory-evidence-fixture';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore, memoryStageSummary } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import { createMemoryPipeline as nativeMemoryPipeline } from '../server/memory-pipeline';
import { createMemoryRecall } from '../server/memory-recall';
const createMemoryPipeline=(...args:Parameters<typeof nativeMemoryPipeline>)=>{const pipeline=nativeMemoryPipeline(...args);return {...pipeline,async runNext(worker:string,now?:string){let job=await pipeline.runNext(worker,now);while(job?.state==='queued'&&job.attempt===0)job=await pipeline.runNext(worker,now);return job;}};};
const p={userId:'local'}, agent={...p,agentId:'a'};
const homes:string[]=[], stores:ReturnType<typeof openStore>[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function setup(home=mkdtempSync(join(tmpdir(),'memory-core-')), sourceVersions:{assetId:string;versionId:string}[]=[]) {
 if(!homes.includes(home))homes.push(home);
 const store=openStore(home);stores.push(store);const files=createAssetFiles(home),assets=createAssets(store,files),tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions,requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local'}), jobs=createMemoryJobs(store,memory),rawPipeline=createMemoryPipeline(memory,jobs,{generate:evidenceFixture}),pipeline={async runNext(worker:string,now?:string){let result=await rawPipeline.runNext(worker,now);while(result?.state==='queued'&&result.attempt===0)result=await rawPipeline.runNext(worker,now);return result;}},recall=createMemoryRecall(memory);
 const collection=memory.ensureCollection(p,{projectId:'p',agentId:'a'});
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 return {home,store,files,assets,tasks,memory,jobs,pipeline,recall,collection,chat};
}
function snapshot(s:ReturnType<typeof setup>,source:import('../shared/memory').MemorySource){return s.memory.applyProposal(p,{collectionId:source.collectionId,layer:'L2',contentType:'fact',text:memoryStageSummary(source),operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:null,certainty:'inferred'},s.memory.collection(p,source.collectionId).generation,'stage_summary');}
function turn(s:ReturnType<typeof setup>,text='请记住：以后用中文回答') {
 const event=s.store.appendEvent(s.chat.id,'user',{text},'2026-10-04T00:00:00Z');
 s.store.appendEvent(s.chat.id,'text',{text:'已完成（尚未验证）'},'2026-10-04T00:00:00Z');
 s.store.appendEvent(s.chat.id,'status',{status:'idle'},'2026-10-04T00:00:00Z');return event;
}
function capture(s:ReturnType<typeof setup>,trigger:'idle'|'completed'|'explicit'='completed') {return s.memory.captureConversation(p,{collectionId:s.collection.id,conversationId:s.chat.id,trigger});}
test('server captured same-millisecond complete turns persist and deduplicate; preference is searchable in Chinese',async()=>{
 const s=setup();turn(s);turn(s,'请记住：报告需要列出来源');const first=capture(s);expect(first.sources).toHaveLength(2);expect(capture(s).jobs.map(j=>j.id)).toEqual(first.jobs.map(j=>j.id));
 await s.pipeline.runNext('worker');expect(s.recall.search(agent,{projectId:'p',query:'中文回答'}).items.some(i=>i.text.includes('中文回答'))).toBe(true);
 expect(s.recall.search({...p,agentId:'b'},{projectId:'p',query:'中文'}).items).toEqual([]);
 expect(s.recall.search(agent,{projectId:'other',query:'中文'}).items).toEqual([]);
 expect(()=>s.recall.search({userId:''},{projectId:'p',query:''})).toThrow();
 const next=setup(s.home);expect(next.memory.list(p,{projectId:'p'}).length).toBeGreaterThan(0);
});
test('new progress retains historical evidence; editing source invalidates records and a pending lease',async()=>{
 const s=setup(),e=turn(s);capture(s);await s.pipeline.runNext('w');turn(s,'继续下一阶段');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items.length).toBeGreaterThan(0);
 capture(s);const leased=s.jobs.claim('old')!;s.store.replaceHistory(s.chat.id,e.id,'fork');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);expect(()=>s.jobs.validateLease(leased)).toThrow();
});
test('lease fencing, idle merge delay, restart and finite retry backoff',()=>{
 const s=setup();turn(s);const result=capture(s,'idle');const base=Date.parse(result.jobs[0].availableAt);expect(s.jobs.claim('early',new Date(base-1).toISOString())).toBeNull();
 const one=s.jobs.claim('w1',new Date(base).toISOString())!;const two=s.jobs.claim('w2',new Date(base+600001).toISOString())!;expect(two.leaseToken).toBeGreaterThan(one.leaseToken);expect(()=>s.jobs.validateLease(one,new Date(base+600001).toISOString())).toThrow();
 s.jobs.fail(two.id,two.leaseToken,'offline',new Date(base+600001).toISOString());expect(s.jobs.list(p,{collectionId:s.collection.id})[0]).toMatchObject({state:'failed',failureCount:2});
});
test('retraction and correction are immediate and old jobs cannot resurrect suppressed text',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];expect(record).toBeDefined();
 const updated=s.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'以后使用英文回答'});expect(updated.revision).toBe(record.revision+1);
 expect(()=>s.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'stale'})).toThrow();
 s.memory.retract(p,{recordId:updated.recordId,expectedRevision:updated.revision});expect(s.recall.search(agent,{projectId:'p',query:'英文'}).items).toEqual([]);
});
test('untrusted generator certainty cannot turn assistant claims or fabricated evidence into facts',async()=>{
 const s=setup();turn(s,'分析一个问题');capture(s);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({sources})=>[{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'系统已验证成功',operation:'store',replaces:[],evidence:[{sourceId:sources[0].id,sourceRevision:1}],validUntil:null,certainty:'observed'}]});
 const job=await pipeline.runNext('w');expect(job?.state).toBe('failed');expect(job?.error).toBe('unsupported_extract');expect(s.memory.list(p,{projectId:'p',status:'proposed'})).toHaveLength(0);expect(s.recall.search(agent,{projectId:'p',query:'验证成功',layers:['L1','L3']}).items).toEqual([]);
});
test('oversize single turn stays explicitly pending and 21 complete turns form two jobs',()=>{
 const s=setup();turn(s,'大'.repeat(24001));const result=capture(s);expect(result.pendingReason).toBe('needs_chunking');expect(result.jobs[0].state).toBe('pending');
 const other=setup();for(let i=0;i<21;i++)turn(other,`记住：条目 ${i}`);expect(capture(other).jobs).toHaveLength(2);
});
test('legacy import preserves active/candidate, scope, hash and never upgrades layers',()=>{
 const s=setup();const entries=[{id:'legacy',kind:'memory' as const,title:'old',content:'旧偏好',scope:'agent' as const,agentId:'a',level:'L4' as const,status:'active' as const,access:{mode:'owner' as const},createdAt:'2020-01-01',updatedAt:'2020-01-01'}];
 expect(s.memory.importLegacy(p,entries).imported).toBe(1);expect(s.memory.importLegacy(p,entries).imported).toBe(0);
 const item=s.memory.list(p,{projectId:null})[0];expect(item).toMatchObject({layer:'L1',legacyLevel:'L4',verification:'legacy_user_managed',text:'旧偏好',status:'active'});
});
test('retracting a preference also removes stage excerpts containing it from default recall and blocks old workers',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];
 turn(s,'新回合');capture(s);const job=s.jobs.claim('old')!;s.memory.retract(p,{recordId:record.recordId,expectedRevision:1});
 expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);expect(()=>s.jobs.validateLease(job)).toThrow();
 capture(s);await s.pipeline.runNext('new');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);
});
test('idle captures coalesce unprocessed complete turns and reset the 30 second deadline',()=>{
 const s=setup();turn(s);capture(s,'idle');turn(s,'记住：来源可点击');capture(s,'idle');const pending=s.jobs.list(p,{collectionId:s.collection.id}).filter(j=>j.state==='queued');expect(pending).toHaveLength(1);expect(pending[0].sourceRefs).toHaveLength(2);
});
test('malformed shadow evidence is rejected atomically while durable jobs retain finite retries',async()=>{
 const s=setup();turn(s);capture(s);const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>[{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'bad',operation:'store',replaces:[],evidence:[],validUntil:null,certainty:'observed'}]});
 const first=await pipeline.runNext('w');expect(first?.state).toBe('queued');expect(first?.error).toBe('invalid_proposal');expect(s.memory.list(p,{projectId:'p',status:'proposed'})).toEqual([]);
 const retry=setup();turn(retry);capture(retry);let now=new Date().toISOString();
 for(let i=0;i<2;i++){const leased=retry.jobs.claim('w',now)!;retry.jobs.fail(leased.id,leased.leaseToken,'offline',now);now=retry.jobs.list(p,{collectionId:retry.collection.id})[0].availableAt;}
 expect(retry.jobs.list(p,{collectionId:retry.collection.id})[0]).toMatchObject({state:'failed',attempt:2,error:'offline'});expect(capture(retry).sources).toHaveLength(1);
});
test('task phase retains history after reopen but pending completion jobs cannot publish; related conversation is indexed',async()=>{
 const s=setup();const task=s.tasks.createTask(p,{goal:'写报告',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'t');
 const run=s.tasks.startTask(p,task.id,task.revision,'start');s.tasks.bindRunIdentity({runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'});
 s.tasks.applyRunEvent({runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn',eventKey:'done',outcome:'succeeded',summary:'模型声称通过',artifactVersions:[]});
 const current=s.tasks.getTask(p,task.id),review=s.tasks.userCommand(p,task.id,current.revision,'complete');s.tasks.userCommand(p,task.id,review.revision,'accept');
 const result=s.memory.captureTask(p,{collectionId:s.collection.id,taskId:task.id,trigger:'completed'});expect(result.sources[0].text).toContain('未验证');snapshot(s,result.sources[0]);await s.pipeline.runNext('w');
 const complete=s.tasks.getTask(p,task.id);s.tasks.userCommand(p,task.id,complete.revision,'reopen','继续');expect(s.memory.list(p,{projectId:'p',taskId:task.id}).length).toBeGreaterThan(0);
 const pending=s.memory.captureTask(p,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'});expect(pending.jobs).toHaveLength(1);const job=s.jobs.claim('old')!;
 const now=s.tasks.getTask(p,task.id);s.tasks.startTask(p,task.id,now.revision,'again');expect(()=>s.jobs.validateLease(job)).toThrow();
});
test('source excerpt utility clips raw history while automatic extraction emits supported L1',async()=>{
 const s=setup();turn(s,'记住：项目使用 pnpm。'+'背景说明。'.repeat(600));const source=capture(s).sources[0];await s.pipeline.runNext('w');
 expect(s.memory.list(p,{projectId:'p'}).some(r=>r.layer==='L1'&&r.status==='active')).toBe(true);expect(s.memory.list(p,{projectId:'p'}).some(r=>r.layer==='L2')).toBe(false);
 const excerpt=memoryStageSummary(source);expect(Array.from(excerpt).length).toBeLessThanOrEqual(2000);expect(excerpt).toContain('摘录缩略');
});

test('generation cannot publish evidence from another job scope even for authorized root',async()=>{
 const s=setup();turn(s);capture(s);const c=s.memory.ensureCollection(p,{projectId:'q',agentId:'a'}),chat=s.store.createConversation({projectId:'q',agentId:'a',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'user',{text:'记住 q'});s.store.appendEvent(chat.id,'status',{status:'idle'});const other=s.memory.captureConversation(p,{collectionId:c.id,conversationId:chat.id,trigger:'completed'});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>[{collectionId:c.id,layer:'L1',contentType:'fact',text:'other',operation:'store',replaces:[],evidence:[{sourceId:other.sources[0].id,sourceRevision:1}],validUntil:null,certainty:'observed'}]});
 const job=await pipeline.runNext('w');expect(job?.state).toBe('queued');expect(job?.error).toBe('job_evidence_mismatch');expect(s.memory.list(p,{projectId:'q'})).toEqual([]);
});
test('source access revocation applies recursively to task read/list/search/source; personal task remains root-only',async()=>{
 const s=setup();const personal=s.tasks.createTask(p,{goal:'个人待办',criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null},'personal');
 const collection=s.memory.ensureCollection(p,{projectId:null,agentId:null}),review=s.tasks.userCommand(p,personal.id,personal.revision,'complete');s.tasks.userCommand(p,personal.id,review.revision,'accept');
 snapshot(s,s.memory.captureTask(p,{collectionId:collection.id,taskId:personal.id,trigger:'completed'}).sources[0]);await s.pipeline.runNext('w');expect(s.memory.list(p,{projectId:null,taskId:personal.id})).toHaveLength(1);expect(s.recall.search(agent,{projectId:null,query:'个人'}).items).toEqual([]);
 const asset=s.assets.getAuthorizedAsset(p,collection.id);s.assets.setLifecycle(p,collection.id,'retracted',asset.revision);
 expect(s.memory.list(p,{projectId:null})).toEqual([]);
});
test('Unicode budgets, expiry, index rebuild and explicit use validation',async()=>{
 const s=setup();for(let i=0;i<10;i++)turn(s,`记住：${i} 事实`);capture(s);await s.pipeline.runNext('w');
 const all=s.recall.search(agent,{projectId:'p',query:''});expect(all.items).toHaveLength(8);
 s.store.database.exec('DELETE FROM memory_index');expect(s.recall.search(agent,{projectId:'p',query:''}).items).toHaveLength(8);s.recall.rebuildIndex();
 const isolated=setup();turn(isolated,'记住：期限事实');const source=capture(isolated).sources[0];
 const proposal={collectionId:isolated.collection.id,layer:'L1' as const,contentType:'fact' as const,text:'记住：期限事实',operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:'2000-01-01T00:00:00Z',certainty:'user_asserted' as const};
 const expired=isolated.memory.applyProposal(p,proposal,1,'source_extract');expect(expired?.validUntil).toBe('2000-01-01T00:00:00Z');expect(isolated.recall.search(agent,{projectId:'p',query:'期限',layers:['L1']}).items).toEqual([]);
});
test('fixed task outputs and recursively revoked source permissions gate every memory body access',async()=>{
 const refs:{assetId:string;versionId:string}[]=[];const s=setup(undefined,refs);
 async function publish(title:string,sourceVersions:typeof refs=[]){writeFileSync(join(s.home,'input.txt'),title);const staging=await s.files.stageFiles(p,null,[{allowedRoot:s.home,relativePath:'input.txt',manifestPath:'input.txt'}]);const a=s.assets.createAsset(p,{kind:'document',title,owner:{userId:'local',agentId:'a'}});const v=s.assets.publishAssetVersion(p,{assetId:a.id,expectedHeadVersionId:null,submissionId:staging.submissionId,files:staging.files,provenance:{sourceVersions}},title);return {assetId:a.id,versionId:v.id};}
 const base=await publish('底层资料');const derived=await publish('派生资料',[base]);refs.push(derived);
 const t=s.tasks.createTask(p,{goal:'检查资料',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'secure');
 const prepared=s.tasks.prepareStart(p,t.id,t.revision,'start');const run=s.store.transaction(()=>prepared.commit({executionConversationId:s.chat.id,mode:'existing',destinationConversationId:s.chat.id}));
 const identity={runId:run.id,hostId:'local',nativeSessionId:'s',nativeTurnId:'t'};s.tasks.bindRunIdentity(identity);s.tasks.applyRunEvent({...identity,eventKey:'terminal',outcome:'succeeded',summary:'已完成资料检查',artifactVersions:[derived]});
 const review=s.tasks.userCommand(p,t.id,s.tasks.getTask(p,t.id).revision,'complete');s.tasks.userCommand(p,t.id,review.revision,'accept');
 const result=s.memory.captureTask(p,{collectionId:s.collection.id,taskId:t.id,trigger:'completed'});snapshot(s,result.sources[0]);await s.pipeline.runNext('w');const r=s.memory.list(agent,{projectId:'p',conversationId:s.chat.id})[0];expect(r).toBeDefined();expect(result.sources[0].versions).toContainEqual(derived);
 const acl=s.assets.getAuthorizedAsset(p,base.assetId);s.assets.setAccess(p,base.assetId,{mode:'private'},acl.revision);
 expect(s.memory.list(agent,{projectId:'p'})).toEqual([]);expect(s.recall.search(agent,{projectId:'p',query:'资料'}).items).toEqual([]);expect(()=>s.memory.read(agent,r.recordId)).toThrow();expect(()=>s.memory.source(agent,result.sources[0].id)).toThrow();
});
test('completion capture fences pending workers after new progress without invalidating committed old turns',async()=>{
 const s=setup();turn(s);capture(s,'idle');s.store.completeConversation(s.chat.id,true);capture(s,'completed');const old=s.jobs.claim('old')!;turn(s,'重新打开');expect(()=>s.jobs.validateLease(old)).toThrow();
});
test('unattributed tool text and credential-like strings are not durable evidence',()=>{
 const s=setup();s.store.appendEvent(s.chat.id,'user',{text:'请记住：token=very-secret-value'});s.store.appendEvent(s.chat.id,'tool',{text:'unattributed tool claim',reasoning:'private chain'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});const result=capture(s);
 expect(JSON.stringify(result.sources)).not.toContain('very-secret-value');expect(JSON.stringify(result.sources)).not.toContain('unattributed');expect(JSON.stringify(result.sources)).not.toContain('private chain');
});
test('legacy scope/owner and selected project policies keep original effective access without collection flooding',()=>{
 const s=setup();const entry={kind:'memory' as const,title:'旧记录',content:'全局习惯',scope:'global' as const,status:'active' as const,access:{mode:'owner' as const},createdAt:'2020',updatedAt:'2020'};
 s.memory.importLegacy(p,[{...entry,id:'g1'},{...entry,id:'g2',content:'另一习惯'},{...entry,id:'candidate',status:'candidate'},{...entry,id:'project',scope:'project',projectId:'p',content:'项目事实'}]);
 expect(s.memory.collections(p).filter(c=>c.legacy)).toHaveLength(2);
 expect(s.recall.search(agent,{projectId:'p',query:'全局'}).items).toHaveLength(1);expect(s.recall.search({...p,agentId:'b'},{projectId:'q',query:'全局'}).items).toHaveLength(1);
 expect(s.recall.search(agent,{projectId:'p',query:'项目'}).items).toHaveLength(1);expect(s.recall.search(agent,{projectId:'q',query:'项目'}).items).toEqual([]);expect(s.memory.listAll(p)).toHaveLength(4);expect(()=>s.memory.listAll(agent)).toThrow();
});
test('ordinary conversations retain actual-use fixed versions even without task Runs',async()=>{
 const s=setup();writeFileSync(join(s.home,'source.txt'),'资料');const stage=await s.files.stageFiles(p,null,[{allowedRoot:s.home,relativePath:'source.txt',manifestPath:'source.txt'}]);const a=s.assets.createAsset(p,{kind:'document',title:'资料',owner:{userId:'local',agentId:'a'}});const v=s.assets.publishAssetVersion(p,{assetId:a.id,expectedHeadVersionId:null,submissionId:stage.submissionId,files:stage.files,provenance:{sourceVersions:[]}},'source');
 s.store.appendEvent(s.chat.id,'metadata',{memoryRecall:'recall',status:'completed',entries:[{assetId:a.id,versionId:v.id}]});turn(s);const sources=capture(s).sources;await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];expect(record).toBeDefined();
 const current=s.assets.getAuthorizedAsset(p,a.id);s.assets.setAccess(p,a.id,{mode:'private'},current.revision);expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);expect(()=>s.memory.source(agent,sources[0].id)).toThrow();
});
test('two workers claim once, stale revisions conflict, and source withdrawal never recaptures withdrawn text',async()=>{
 const s=setup();turn(s);const captured=capture(s);const other=setup(s.home);const a=s.jobs.claim('one')!;expect(other.jobs.claim('two')).toBeNull();s.jobs.fail(a.id,a.leaseToken,'retry',new Date(Date.now()-2000).toISOString());await s.pipeline.runNext('worker');
 const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];s.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'以后英文'});expect(()=>other.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'以后日文'})).toThrow();
 s.memory.retractSource(p,{sourceId:captured.sources[0].id,expectedRevision:1});expect(s.recall.search(agent,{projectId:'p',query:''}).items).toEqual([]);expect(()=>s.memory.source(p,captured.sources[0].id)).toThrow();capture(s);await s.pipeline.runNext('later');expect(s.recall.search(agent,{projectId:'p',query:''}).items).toEqual([]);
});
test('Agent cannot correct/retract, user explicit restoration advances revision and returns next recall',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];expect(()=>s.memory.retract(agent,{recordId:record.recordId,expectedRevision:1})).toThrow();
 s.memory.retract(p,{recordId:record.recordId,expectedRevision:1});const restored=s.memory.restore(p,{recordId:record.recordId,expectedRevision:2});expect(restored.revision).toBe(3);expect(s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items).toHaveLength(1);
});
test('questions about future behavior are not stable preferences, conflicting explicit assertions remain proposed',async()=>{
 const s=setup();turn(s,'请问以后应该用什么语言？');capture(s);await s.pipeline.runNext('w');expect(s.memory.list(p,{projectId:'p'}).filter(r=>r.layer==='L1')).toEqual([]);
 turn(s,'请记住：项目使用 pnpm');capture(s);await s.pipeline.runNext('w');turn(s,'请记住：项目使用 npm');capture(s);await s.pipeline.runNext('w');
 const facts=s.memory.list(p,{projectId:'p'}).filter(r=>r.layer==='L1');expect(facts.find(r=>r.text.endsWith('pnpm'))?.status).toBe('active');expect(facts.find(r=>r.text.endsWith(' npm'))?.status).toBe('proposed');
});
test('completed conversation can process a later new turn while preserving its published historical phase',async()=>{
 const s=setup();turn(s);s.store.completeConversation(s.chat.id,true);capture(s);await s.pipeline.runNext('first');turn(s,'记住：新阶段使用 bun');capture(s,'explicit');const job=await s.pipeline.runNext('next');expect(job?.state).toBe('completed');expect(s.recall.search(agent,{projectId:'p',query:'bun',layers:['L1']}).items).toHaveLength(1);expect(s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items).toHaveLength(1);
});
test('direct Agent memory/source reads require the same explicit project as search',async()=>{
 const s=setup();turn(s);const result=capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];
 expect(()=>s.memory.read(agent,record.recordId)).toThrow();expect(()=>s.memory.source(agent,result.sources[0].id)).toThrow();expect(()=>s.memory.read(agent,record.recordId,'other')).toThrow();expect(()=>s.memory.source(agent,result.sources[0].id,'other')).toThrow();expect(s.memory.read(agent,record.recordId,'p').recordId).toBe(record.recordId);
});
test('generator failure preserves source and a diagnosable retry without fabricated success',async()=>{
 const s=setup();turn(s);const captured=capture(s);const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async()=>{throw new Error('generator unavailable');}});const job=await pipeline.runNext('w');
 expect(job).toMatchObject({state:'queued',error:'generator unavailable'});expect(s.memory.source(p,captured.sources[0].id).status).toBe('ready');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);
});

test('background title and recall metadata do not obsolete a completed conversation job',async()=>{
 const s=setup();turn(s);s.store.completeConversation(s.chat.id,true);capture(s);const old=s.jobs.claim('w')!;s.store.appendEvent(s.chat.id,'metadata',{automaticTitle:'done'});s.store.appendEvent(s.chat.id,'metadata',{memoryRecall:'background',status:'completed',entries:[]});expect(()=>s.jobs.validateLease(old)).not.toThrow();
});
test('retracting same-text memory suppresses all evidence sources, dependent summaries and recapture',async()=>{
 const s=setup();turn(s);turn(s);capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];expect(record.evidence).toHaveLength(2);
 s.memory.retract(p,{recordId:record.recordId,expectedRevision:record.revision});expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);
 capture(s);await s.pipeline.runNext('recapture');turn(s);capture(s);await s.pipeline.runNext('new-source');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);
});
test('Run-only and mismatched Run principals never inherit human authority',async()=>{
 const s=setup();turn(s,'请记住：项目私有机密');capture(s);await s.pipeline.runNext('w');const record=s.memory.list(p,{projectId:'p'})[0];
 const task=s.tasks.createTask(p,{goal:'other',criteria:[],acceptance:'human',projectId:'q',assigneeAgentId:'b'},'other');const run=s.tasks.startTask(p,task.id,task.revision,'start');
 expect(()=>s.recall.search({...p,runId:run.id},{projectId:'p',query:'私有机密'})).toThrow();expect(()=>s.memory.read({...p,runId:run.id},record.recordId)).toThrow();expect(()=>s.memory.read({...p,runId:run.id,agentId:'a'},record.recordId,'p')).toThrow();
});
test('generation cannot publish after its worker lease expires',async()=>{
 vi.useFakeTimers();try{const s=setup();turn(s);capture(s);const pipeline=createMemoryPipeline(s.memory,s.jobs,{timeoutMs:900000,generate:async(input)=>{vi.advanceTimersByTime(600001);return evidenceFixture(input);}});
 expect(await pipeline.runNext('slow')).toMatchObject({state:'queued',error:'stale_lease'});expect(s.memory.list(p,{projectId:'p'})).toEqual([]);
 }finally{vi.useRealTimers();}
});

test('never-resolving generation aborts at configured timeout and remains retryable',async()=>{
 vi.useFakeTimers();try{const s=setup();turn(s);capture(s);let signal:AbortSignal|undefined;
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{timeoutMs:180000,generate:async(input)=>{signal=input.signal;return new Promise(()=>{});}}),pending=pipeline.runNext('never');
 expect(s.memory.list(p,{projectId:'p'})).toEqual([]);expect(s.jobs.list(p,{collectionId:s.collection.id})[0].state).toBe('running');await vi.advanceTimersByTimeAsync(180000);
 expect(await pending).toMatchObject({state:'queued',error:'generation_timed_out'});expect(signal?.aborted).toBe(true);
 }finally{vi.useRealTimers();}
});

test('late generation after source withdrawal cannot publish',async()=>{
 const s=setup();turn(s);const captured=capture(s);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{await gate;return evidenceFixture(input);}}),pending=pipeline.runNext('delayed');
 s.memory.retractSource(p,{sourceId:captured.sources[0].id,expectedRevision:1});release();expect(await pending).toMatchObject({state:'obsolete',error:'generation_changed'});expect(s.memory.list(p,{projectId:'p'})).toEqual([]);
});

test('duplicate correction suppresses every old source and explicit restore alone permits withdrawn reuse',async()=>{
 const s=setup();turn(s);turn(s);capture(s);await s.pipeline.runNext('w');let record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];
 s.memory.retract(p,{recordId:record.recordId,expectedRevision:record.revision});capture(s);await s.pipeline.runNext('again');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);
 const restored=s.memory.restore(p,{recordId:record.recordId,expectedRevision:record.revision+1});expect(s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items).toHaveLength(1);
 s.memory.correct(p,{recordId:restored.recordId,expectedRevision:restored.revision,text:'以后用英文回答'});capture(s);await s.pipeline.runNext('corrected');expect(s.recall.search(agent,{projectId:'p',query:'中文'}).items).toEqual([]);expect(s.recall.search(agent,{projectId:'p',query:'英文',layers:['L1']}).items).toHaveLength(1);
});
test('recordUse validates real Run assignee, project and revision and records use without success causality',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('w');const record=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];
 const task=s.tasks.createTask(p,{goal:'handoff',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'handoff');const run=s.tasks.startTask(p,task.id,task.revision,'start');const actor={...agent,runId:run.id};
 const use=s.recall.recordUse(actor,{runId:run.id,query:'中文',items:[{recordId:record.recordId,revision:record.revision}]});const row=s.store.database.prepare('SELECT data FROM memory_uses WHERE id=?').get(use)!;expect(JSON.parse(row.data as string)).toMatchObject({actualUse:'provided_to_native',causality:'not_established',items:[{recordId:record.recordId,revision:record.revision}]});
 const otherTask=s.tasks.createTask(p,{goal:'other',criteria:[],acceptance:'human',projectId:'q',assigneeAgentId:'b'},'other');const otherRun=s.tasks.startTask(p,otherTask.id,otherTask.revision,'other-start');
 expect(()=>s.recall.recordUse({...p,runId:otherRun.id},{runId:otherRun.id,query:'中文',items:[{recordId:record.recordId,revision:record.revision}]})).toThrow();
 expect(()=>s.recall.recordUse({...p,agentId:'b',runId:otherRun.id},{runId:otherRun.id,query:'中文',items:[{recordId:record.recordId,revision:record.revision}]})).toThrow();
 s.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'以后用英文'});expect(()=>s.recall.recordUse(actor,{runId:run.id,query:'中文',items:[{recordId:record.recordId,revision:record.revision}]})).toThrow();
});
test('corrected memory retains new identical verified sources through correction, withdrawal and recapture',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('first');const original=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];
 let corrected=s.memory.correct(p,{recordId:original.recordId,expectedRevision:original.revision,text:'请记住：以后用英文回答'});
 turn(s,'请记住：以后用英文回答');capture(s);await s.pipeline.runNext('duplicate');corrected=s.memory.read(p,corrected.recordId);expect(corrected.verification).toBe('user_correction');expect(corrected.evidence).toHaveLength(2);
 s.memory.retract(p,{recordId:corrected.recordId,expectedRevision:corrected.revision});expect(s.recall.search(agent,{projectId:'p',query:'英文'}).items).toEqual([]);capture(s);await s.pipeline.runNext('recapture');expect(s.recall.search(agent,{projectId:'p',query:'英文'}).items).toEqual([]);
 const restored=s.memory.restore(p,{recordId:corrected.recordId,expectedRevision:corrected.revision+1});s.memory.correct(p,{recordId:restored.recordId,expectedRevision:restored.revision,text:'请记住：以后用日文回答'});capture(s);await s.pipeline.runNext('correct-again');expect(s.recall.search(agent,{projectId:'p',query:'英文'}).items).toEqual([]);expect(s.recall.search(agent,{projectId:'p',query:'日文',layers:['L1']}).items).toHaveLength(1);
});
test('legacy active memory can associate identical verified evidence without upgrading its legacy authority',async()=>{
 const s=setup();s.memory.importLegacy(p,[{id:'legacy-verified',kind:'memory',title:'旧事实',content:'请记住：项目使用 pnpm',scope:'agent',agentId:'a',projectId:'p',level:'L1',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'}]);
 const legacy=s.memory.list(p,{projectId:'p'}).find(r=>r.legacyId==='legacy-verified')!;turn(s,'请记住：项目使用 pnpm');s.memory.captureConversation(p,{collectionId:legacy.collectionId,conversationId:s.chat.id,trigger:'explicit'});await s.pipeline.runNext('legacy');const linked=s.memory.read(p,legacy.recordId);expect(linked.verification).toBe('legacy_user_managed');expect(linked.contentHash).toBe(legacy.contentHash);expect(linked.evidence).toHaveLength(1);
 s.memory.retract(p,{recordId:linked.recordId,expectedRevision:linked.revision});expect(s.recall.search(agent,{projectId:'p',query:'pnpm'}).items).toEqual([]);s.memory.captureConversation(p,{collectionId:legacy.collectionId,conversationId:s.chat.id,trigger:'explicit'});await s.pipeline.runNext('legacy-recapture');expect(s.recall.search(agent,{projectId:'p',query:'pnpm'}).items).toEqual([]);
});
test('shadow duplicate suggestions cannot attach unverified provenance to user-corrected active memory',async()=>{
 const s=setup();turn(s);capture(s);await s.pipeline.runNext('first');const original=s.recall.search(agent,{projectId:'p',query:'中文',layers:['L1']}).items[0];const corrected=s.memory.correct(p,{recordId:original.recordId,expectedRevision:original.revision,text:'请记住：以后用英文回答'});turn(s,'普通问题');capture(s);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async({sources})=>[{collectionId:s.collection.id,layer:'L3',contentType:'preference',text:corrected.text,operation:'store',replaces:[],evidence:[{sourceId:sources.at(-1)!.id,sourceRevision:sources.at(-1)!.revision}],validUntil:null,certainty:'observed'}]});await pipeline.runNext('shadow');const after=s.memory.read(p,corrected.recordId);expect(after.evidence).toEqual(corrected.evidence);expect(after.revision).toBe(corrected.revision);expect(after.verification).toBe('user_correction');
});


test.each([
 ['Chinese labelled codes', '我的验证码是 123456，密钥为 synthetic-cn-key；密码 synthetic-password', ['123456','synthetic-cn-key','synthetic-password']],
 ['English labelled credentials', 'verification code is 654321, API key is synthetic-api-key-value; credentials synthetic-credential; token=synthetic-token Bearer synthetic-bearer', ['654321','synthetic-api-key-value','synthetic-credential','synthetic-token','synthetic-bearer']],
] as const)('routine credentials are redacted before conversation and Task memory persistence: %s',async(_label,input,secrets)=>{
 const s=setup();turn(s,input);const captured=capture(s);await s.pipeline.runNext('conversation');
 const task=s.tasks.createTask(p,{goal:input,criteria:[{id:'sensitive',text:input,checkRef:null}],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'credentials');
 const taskCapture=s.memory.captureTask(p,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'});await s.pipeline.runNext('task');
 const durable=JSON.stringify({sources:[...captured.sources,...taskCapture.sources],sourceRows:s.store.database.prepare('SELECT data FROM memory_source_revisions').all(),records:s.memory.list(p,{projectId:'p'}),summary:s.recall.summary(agent,{projectId:'p'})});
 for(const secret of secrets)expect(durable).not.toContain(secret);
 expect(durable).toContain('[REDACTED]');expect(s.store.listEvents(s.chat.id,0)[0].data).toMatchObject({text:input});expect(s.tasks.getTask(p,task.id).goal).toBe(input);
});

test('published source units are incremental across idle, completion, reopen and restart',async()=>{
 const s=setup(),batches:string[][]=[];
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{if(input.stage==='extract')batches.push(input.sources.map(v=>v.id+'@'+v.revision));return evidenceFixture(input);}});
 turn(s);const first=capture(s,'idle');await pipeline.runNext('first',first.jobs[0].availableAt);
 turn(s,'Second independent round');const second=capture(s,'idle');expect(second.sources).toHaveLength(2);await pipeline.runNext('second',second.jobs.at(-1)!.availableAt);
 expect(batches).toEqual([[first.sources[0].id+'@1'],[second.sources[1].id+'@1']]);
 s.store.completeConversation(s.chat.id,true);capture(s,'completed');await pipeline.runNext('closure');expect(batches).toHaveLength(2);
 s.store.completeConversation(s.chat.id,false);capture(s,'idle');s.store.completeConversation(s.chat.id,true);capture(s,'completed');await pipeline.runNext('reclose');expect(batches).toHaveLength(2);
 s.store.close();stores.splice(stores.indexOf(s.store),1);
 const restarted=setup(s.home),afterRestart=createMemoryPipeline(restarted.memory,restarted.jobs,{generate:async(input)=>{if(input.stage==='extract')batches.push(input.sources.map(v=>v.id+'@'+v.revision));return evidenceFixture(input);}});
 const reloaded=restarted.memory.captureConversation(p,{collectionId:s.collection.id,conversationId:s.chat.id,trigger:'completed'});expect(reloaded.sources).toHaveLength(2);await afterRestart.runNext('restart');expect(batches).toHaveLength(2);
});

test('source revisions and collection generations create genuine new processing units',async()=>{
 const s=setup(),batches:string[][]=[],pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{if(input.stage==='extract')batches.push(input.sources.map(v=>v.id+'@'+v.revision));return evidenceFixture(input);}});
 const event=turn(s);capture(s,'explicit');await pipeline.runNext('first');
 const row=s.store.database.prepare('SELECT data FROM events WHERE id=?').get(event.id);
 // Preserve the complete round while changing its exact source event.
 const data=JSON.parse(row!.data as string);data.text='请记住：以后用英文回答';s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),event.id);
 const changed=capture(s,'explicit');await pipeline.runNext('revision');expect(changed.sources[0].revision).toBe(2);expect(batches.map(b=>b[0])).toEqual([changed.sources[0].id+'@1',changed.sources[0].id+'@2']);
 const record=s.memory.list(p,{projectId:'p',status:'active'}).find(r=>r.layer==='L1')!;s.memory.correct(p,{recordId:record.recordId,expectedRevision:record.revision,text:'以后用日文回答'});capture(s,'explicit');await pipeline.runNext('generation');expect(batches).toHaveLength(3);
});


test('labelled credentials in unverified candidate bodies are redacted before persistence',()=>{
 const s=setup();turn(s,'ordinary source');const source=capture(s).sources[0];
 const proposed=s.memory.applyProposal(p,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'API key is synthetic-generated-key',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:null,certainty:'inferred'},1)!;
 expect(proposed.status).toBe('proposed');expect(proposed.text).toContain('[REDACTED]');expect(JSON.stringify(s.store.database.prepare('SELECT data FROM memory_revisions').all())).not.toContain('synthetic-generated-key');
});

test('a pending aggregate excludes a source published by an earlier leased worker',async()=>{
 const s=setup();turn(s);const first=capture(s,'explicit'),leased=s.jobs.claim('earlier')!;turn(s,'Later independent round');const aggregate=capture(s,'explicit');expect(aggregate.jobs[0].sourceRefs).toHaveLength(2);
 s.store.transaction(()=>{s.memory.applyProposal(p,{collectionId:s.collection.id,layer:'L2',contentType:'fact',text:memoryStageSummary(first.sources[0]),operation:'store',replaces:[],evidence:leased.sourceRefs,validUntil:null,certainty:'inferred'},leased.generation,'stage_summary');s.jobs.complete(leased.id,leased.leaseToken);});
 const batches:string[][]=[],pipeline=createMemoryPipeline(s.memory,s.jobs,{generate:async(input)=>{if(input.stage==='extract')batches.push(input.sources.map(s=>s.id));return evidenceFixture(input);}});await pipeline.runNext('later');expect(batches).toEqual([[aggregate.sources[1].id]]);
});


test('redaction precedes suppression so withdrawn candidate credentials cannot reappear',()=>{
 const s=setup();turn(s,'First generation source');const first=capture(s).sources[0];
 const proposal=(source:typeof first)=>({collectionId:s.collection.id,layer:'L1' as const,contentType:'fact' as const,text:'API key is synthetic-withdrawn-key',operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:null,certainty:'inferred' as const});
 const r=s.memory.applyProposal(p,proposal(first),1)!;s.memory.retract(p,{recordId:r.recordId,expectedRevision:r.revision});turn(s,'Second generation source');const second=capture(s).sources.at(-1)!;expect(s.memory.applyProposal(p,proposal(second),2)).toBeNull();
});
test('repeated immediate Task capture keeps its due position ahead of later jobs',()=>{
 vi.useFakeTimers({toFake:['Date']});
 try{
  vi.setSystemTime('2026-10-12T00:00:00Z');const s=setup(),task=s.tasks.createTask(p,{goal:'Older task',criteria:[],acceptance:'delivery',projectId:'p',assigneeAgentId:'a'},'fair-task');
  const captureTask=()=>s.memory.captureTask(p,{collectionId:s.collection.id,taskId:task.id,trigger:'stable',kind:'request'}).jobs[0],first=captureTask();
  vi.setSystemTime('2026-10-12T00:00:01Z');turn(s,'Later conversation');const later=capture(s,'explicit').jobs[0];
  vi.setSystemTime('2026-10-12T00:00:02Z');const repeated=captureTask();
  expect(repeated.id).toBe(first.id);expect(s.jobs.claim('worker')?.id).toBe(first.id);expect(repeated.availableAt).toBe(first.availableAt);expect(later.id).not.toBe(first.id);
 }finally{vi.useRealTimers();}
});
test('immediate duplicate capture still accelerates a future debounced job',()=>{
 vi.useFakeTimers({toFake:['Date']});
 try{vi.setSystemTime('2026-10-12T00:00:00Z');const s=setup();turn(s,'Debounced fact.');const future=capture(s,'idle').jobs[0];expect(Date.parse(future.availableAt)).toBeGreaterThan(Date.now());vi.setSystemTime('2026-10-12T00:00:01Z');const flushed=capture(s,'explicit').jobs[0];expect(flushed.id).toBe(future.id);expect(Date.parse(flushed.availableAt)).toBe(Date.now());expect(s.jobs.claim('worker')?.id).toBe(future.id);}finally{vi.useRealTimers();}
});

test('task capture shares evidence reads within one inherited-permission traversal',()=>{
 const s=setup(),facts=Array.from({length:8},(_,i)=>`Synthetic fact ${i}.`),event=turn(s,facts.join(' '));
 const source=capture(s).sources[0];
 const records=facts.map(text=>s.memory.applyProposal(p,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'observed'},s.collection.generation,'evidence_extract')!);
 const task=s.tasks.createTask(p,{goal:'Capture shared evidence',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'capture-shared');
 const run=s.tasks.startTask(p,task.id,task.revision,'capture-shared-start');
 s.recall.recordUse({...agent,runId:run.id},{runId:run.id,query:'facts',items:records.map(r=>({recordId:r.recordId,revision:r.revision}))});
 const payload=s.store.database.prepare('SELECT data FROM memory_sources WHERE id=?').get(source.id)!.data,parse=vi.spyOn(JSON,'parse');
 try{const result=s.memory.captureTask(p,{collectionId:s.collection.id,taskId:task.id,trigger:'stable',kind:'request'});expect(result.sources[0].memoryRefs).toHaveLength(facts.length);expect(parse.mock.calls.filter(([value])=>value===payload).length).toBeLessThanOrEqual(2);}finally{parse.mockRestore();}
});
