import { evidenceFixture } from './memory-evidence-fixture';
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
import { createMemoryRecall } from '../server/memory-recall';
const root={userId:'local'},actor={...root,agentId:'a'};
const cleanup:{home:string;store:ReturnType<typeof openStore>}[]=[];
afterEach(()=>{for(const {store,home} of cleanup.splice(0)){store.close();rmSync(home,{recursive:true,force:true});}});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-deps-')),store=openStore(home);cleanup.push({home,store});
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local'}),jobs=createMemoryJobs(store,memory),rawPipeline=createMemoryPipeline(memory,jobs,{generate:evidenceFixture}),pipeline={async runNext(worker:string,now?:string){let result=await rawPipeline.runNext(worker,now);while(result?.state==='queued'&&result.attempt===0)result=await rawPipeline.runNext(worker,now);return result;}},recall=createMemoryRecall(memory),collection=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const chat=()=>store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const turn=(id:string,invocationId:string,text='请记住：以后用中文回答',reply='收到')=>{store.appendEvent(id,'user',{text,invocationId});store.appendEvent(id,'text',{text:reply});store.appendEvent(id,'status',{status:'idle'});};
 const capture=(id:string)=>memory.captureConversation(root,{collectionId:collection.id,conversationId:id,trigger:'explicit'});
 const ack=(id:string,invocationId:string,parent:{recordId:string;revision:number})=>store.appendEvent(id,'metadata',{memoryUse:'acknowledged',invocationId,items:[{recordId:parent.recordId,revision:parent.revision,reason:'summary'}],query:'中文',causality:'not_established'});
 return {home,store,assets,tasks,memory,jobs,pipeline,recall,collection,chat,turn,capture,ack};
}
async function original(s:ReturnType<typeof setup>){const chat=s.chat();s.turn(chat.id,'original');s.capture(chat.id);await s.pipeline.runNext('original');return {chat,record:s.recall.search(actor,{projectId:'p',query:'中文',layers:['L1']}).items[0]};}
test.each(['before','during'] as const)('ordinary invocation %s-user handoff becomes exact dependencies; correction invalidates derived summary and recapture',async timing=>{
 const s=setup(),{record}=await original(s),derived=s.chat();
 if(timing==='before')s.ack(derived.id,'derived',record);
 s.store.appendEvent(derived.id,'user',{text:'总结语言约定',invocationId:'derived'});if(timing==='during')s.ack(derived.id,'derived',record);s.store.appendEvent(derived.id,'text',{text:'以后用中文回答'});s.store.appendEvent(derived.id,'status',{status:'idle'});
 const captured=s.capture(derived.id);await s.pipeline.runNext('derived');const summary=s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'})[0];expect(summary.dependencies).toEqual([{recordId:record.recordId,revision:record.revision}]);expect(captured.sources[0].memoryRefs).toEqual(summary.dependencies);
 s.memory.correct(root,{recordId:record.recordId,expectedRevision:record.revision,text:'以后用英文回答'});expect(s.recall.search(actor,{projectId:'p',query:'中文'}).items).toEqual([]);expect(()=>s.memory.source(root,captured.sources[0].id)).toThrow();expect(s.capture(derived.id).jobs.every(j=>j.state==='obsolete')).toBe(true);expect(s.recall.search(actor,{projectId:'p',query:'中文'}).items).toEqual([]);
});
test('exact invocation association leaves earlier rounds unchanged, excludes unrelated acks and prevents backward self-dependencies',async()=>{
 const s=setup(),{chat,record}=await original(s);const old=s.capture(chat.id).sources[0];s.ack(chat.id,'later',record);s.turn(chat.id,'later','概括当前偏好','以后用中文回答');
 const result=s.capture(chat.id);expect(result.sources[0].revision).toBe(old.revision);expect(result.sources[0].memoryRefs??[]).toEqual([]);expect(result.sources[1].memoryRefs).toEqual([{recordId:record.recordId,revision:record.revision}]);await s.pipeline.runNext('later');expect(s.memory.read(actor,record.recordId,'p').status).toBe('active');
 const unrelated=s.chat();s.ack(unrelated.id,'different-invocation',record);s.turn(unrelated.id,'actual','独立问题','独立回答');s.capture(unrelated.id);await s.pipeline.runNext('unrelated');expect(s.memory.list(root,{projectId:'p',conversationId:unrelated.id})[0].dependencies).toEqual([]);
 s.memory.retract(root,{recordId:record.recordId,expectedRevision:record.revision});expect(s.recall.search(actor,{projectId:'p',query:'中文'}).items).toEqual([]);expect(s.memory.list(root,{projectId:'p',conversationId:unrelated.id,status:'active'})).toHaveLength(1);
});
test('current parent ACL, expiry and project scope are enforced even for root-driven capture',async()=>{
 const s=setup(),{record}=await original(s),derived=s.chat();s.ack(derived.id,'derived',record);s.turn(derived.id,'derived','总结','以后用中文回答');s.capture(derived.id);await s.pipeline.runNext('derived');
 const parent=s.assets.getAuthorizedAsset(root,record.collectionId);s.assets.setAccess(root,parent.id,{mode:'private'},parent.revision);expect(s.memory.list(root,{projectId:'p',conversationId:derived.id})).toEqual([]);expect(s.capture(derived.id).jobs.every(j=>j.state==='obsolete')).toBe(true);
 const other=s.memory.ensureCollection(root,{projectId:'q',agentId:'a'}),qchat=s.store.createConversation({projectId:'q',agentId:'a',cli:'codex',model:null});s.ack(qchat.id,'cross',record);s.turn(qchat.id,'cross','跨项目','以后用中文回答');expect(s.memory.captureConversation(root,{collectionId:other.id,conversationId:qchat.id,trigger:'explicit'}).jobs.every(j=>j.state==='obsolete')).toBe(true);
});
test('Task stage captures only actual source Run memory_uses and keeps use separate from success causality',async()=>{
 const s=setup(),{record}=await original(s);const task=s.tasks.createTask(root,{goal:'根据语言偏好输出摘要',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'task');const run=s.tasks.startTask(root,task.id,task.revision,'start');
 s.recall.recordUse({...actor,runId:run.id},{runId:run.id,query:'语言',items:[{recordId:record.recordId,revision:record.revision}]});const identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'};s.tasks.bindRunIdentity(identity);s.tasks.applyRunEvent({...identity,eventKey:'done',outcome:'succeeded',summary:'以后用中文回答',artifactVersions:[]});
 const review=s.tasks.userCommand(root,task.id,s.tasks.getTask(root,task.id).revision,'complete'),accepted=s.tasks.userCommand(root,task.id,review.revision,'accept');
 const capture=s.memory.captureTask(root,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'});await s.pipeline.runNext('task');const summary=s.memory.list(root,{projectId:'p',taskId:task.id})[0];expect(summary.dependencies).toEqual([{recordId:record.recordId,revision:record.revision}]);expect(capture.sources[0].memoryRefs).toEqual(summary.dependencies);expect(summary.text).not.toContain('助手摘要');expect(s.tasks.getTask(root,task.id).state).toBe(accepted.state);
 s.memory.retract(root,{recordId:record.recordId,expectedRevision:record.revision});expect(s.memory.list(root,{projectId:'p',taskId:task.id,status:'active'})).toEqual([]);expect(()=>s.memory.captureTask(root,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'})).toThrow();
});
test('independent explicit user declaration is not downgraded into assistant derivation',async()=>{
 const s=setup(),{record}=await original(s),derived=s.chat();s.ack(derived.id,'derived',record);s.turn(derived.id,'derived','请记住：报告必须列来源','遵循中文偏好写报告');s.capture(derived.id);await s.pipeline.runNext('derived');const independent=s.recall.search(actor,{projectId:'p',query:'报告必须列来源',layers:['L1']}).items[0];expect(independent.dependencies).toEqual([]);
 s.memory.retract(root,{recordId:record.recordId,expectedRevision:record.revision});expect(s.recall.search(actor,{projectId:'p',query:'报告必须列来源',layers:['L1']}).items).toHaveLength(1);expect(s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'}).filter(r=>r.layer==='L2')).toEqual([]);
});
test('same-text evidence append preserves the actually delivered old revision without a backward self-cycle',async()=>{
 const s=setup(),{record}=await original(s),derived=s.chat();s.ack(derived.id,'repeat',record);s.turn(derived.id,'repeat','请记住：以后用中文回答','依旧使用中文');s.capture(derived.id);await s.pipeline.runNext('repeat');
 const current=s.memory.read(actor,record.recordId,'p');expect(current.revision).toBeGreaterThan(record.revision);expect(current.contentHash).toBe(record.contentHash);
 const summary=s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'}).find(r=>r.layer==='L2');expect(summary).toBeDefined();expect(summary!.dependencies).toEqual([{recordId:record.recordId,revision:record.revision}]);expect(s.capture(derived.id).sources[0].memoryRefs).toEqual(summary!.dependencies);
 s.memory.correct(root,{recordId:current.recordId,expectedRevision:current.revision,text:'请记住：以后用英文回答'});expect(s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'}).filter(r=>r.layer==='L2')).toEqual([]);expect(s.recall.search(actor,{projectId:'p',query:'中文'}).items).toEqual([]);
});
test('actual acknowledgement revision edits fence old workers; recapture stores the new fixed reference',async()=>{
 const s=setup(),{record}=await original(s),extra=s.chat();s.turn(extra.id,'extra','请记住：报告需要列出来源');s.capture(extra.id);await s.pipeline.runNext('extra');const other=s.recall.search(actor,{projectId:'p',query:'报告',layers:['L1']}).items[0];const derived=s.chat(),ack=s.ack(derived.id,'derived',record);s.turn(derived.id,'derived','总结','引用记忆');const before=s.capture(derived.id),job=s.jobs.claim('old')!;
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({memoryUse:'acknowledged',invocationId:'derived',items:[{recordId:other.recordId,revision:other.revision}],query:'报告',causality:'not_established'}),ack.id);
 expect(()=>s.jobs.validateLease(job)).toThrow();const after=s.capture(derived.id);expect(after.sources[0].revision).toBe(before.sources[0].revision+1);expect(after.sources[0].memoryRefs).toEqual([{recordId:other.recordId,revision:other.revision}]);
});
test('parent expiry makes derived summaries unavailable immediately without requiring a collection generation change',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-04T00:00:00Z');
 try{
  const s=setup(),chat=s.chat();s.turn(chat.id,'expiring','请记住：短期使用中文');const source=s.capture(chat.id).sources[0];const record=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'请记住：短期使用中文',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision,startEventId:source.eventIds[0],endEventId:source.eventIds[0]}],validUntil:'2026-10-04T00:01:00Z',support:[{sourceId:source.id,eventId:source.eventIds[0],quote:'请记住：短期使用中文'}],certainty:'user_asserted'},1,'evidence_extract')!;
  const derived=s.chat();s.ack(derived.id,'derived',record);s.turn(derived.id,'derived','总结','短期使用中文');s.capture(derived.id);await s.pipeline.runNext('first');await s.pipeline.runNext('derived');expect(s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'})).toHaveLength(1);
  vi.setSystemTime('2026-10-04T00:02:00Z');expect(s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'})).toEqual([]);expect(s.capture(derived.id).jobs.every(j=>j.state==='obsolete')).toBe(true);
 }finally{vi.useRealTimers();}
});
test('Task memory-use references exclude unrelated Runs and reject cross-project dependencies at capture',async()=>{
 const s=setup(),{record}=await original(s);const create=(key:string,projectId='p')=>{const task=s.tasks.createTask(root,{goal:key,criteria:[],acceptance:'human',projectId,assigneeAgentId:'a'},key);return {task,run:s.tasks.startTask(root,task.id,task.revision,key+'-start')};};
 const a=create('a'),b=create('b');const use=s.recall.recordUse({...actor,runId:b.run.id},{runId:b.run.id,query:'中文',items:[{recordId:record.recordId,revision:record.revision}]});
 const own=s.memory.captureTask(root,{collectionId:s.collection.id,taskId:a.task.id,trigger:'stable'});expect(own.sources[0].memoryRefs).toEqual([]);const actual=s.memory.captureTask(root,{collectionId:s.collection.id,taskId:b.task.id,trigger:'stable'});expect(actual.sources[0].memoryRefs).toEqual([{recordId:record.recordId,revision:record.revision}]);expect(actual.sources[0].memoryUses?.map(item=>item.id)).toEqual([use]);
 const other=create('q','q'),q=s.memory.ensureCollection(root,{projectId:'q',agentId:'a'});s.store.database.prepare('INSERT INTO memory_uses VALUES (?,?,?)').run('invalid-bound-use',other.run.id,JSON.stringify({actualUse:'provided_to_native',items:[{recordId:record.recordId,revision:record.revision}],causality:'not_established'}));expect(()=>s.memory.captureTask(root,{collectionId:q.id,taskId:other.task.id,trigger:'stable'})).toThrow();
});
test('a parent retracted then restored does not silently revive a derived summary tied to the old handoff',async()=>{
 const s=setup(),{record}=await original(s),derived=s.chat();s.ack(derived.id,'derived',record);s.turn(derived.id,'derived','总结','中文回答');s.capture(derived.id);await s.pipeline.runNext('derived');s.memory.retract(root,{recordId:record.recordId,expectedRevision:record.revision});s.memory.restore(root,{recordId:record.recordId,expectedRevision:record.revision+1});expect(s.memory.list(root,{projectId:'p',conversationId:derived.id,status:'active'})).toEqual([]);expect(s.capture(derived.id).jobs.every(j=>j.state==='obsolete')).toBe(true);
});
test('an obsolete derived round cannot poison later independent rounds in the same conversation',async()=>{
 const s=setup(),{record}=await original(s),chat=s.chat();s.ack(chat.id,'dependent',record);s.turn(chat.id,'dependent','概括偏好','旧中文偏好');s.capture(chat.id);await s.pipeline.runNext('derived');s.memory.retract(root,{recordId:record.recordId,expectedRevision:record.revision});
 s.turn(chat.id,'independent','请记住：部署前执行检查','收到');let result:ReturnType<typeof s.capture>|undefined;expect(()=>{result=s.capture(chat.id);}).not.toThrow();expect(result!.pendingReason).toBeTruthy();expect(result!.jobs.some(j=>j.state==='obsolete')).toBe(true);await s.pipeline.runNext('independent');expect(s.recall.search(actor,{projectId:'p',query:'部署前执行检查',layers:['L1']}).items).toHaveLength(1);expect(s.recall.search(actor,{projectId:'p',query:'旧中文偏好'}).items).toEqual([]);expect(s.jobs.list(root).some(j=>j.state==='obsolete'&&j.error==='stale_memory_dependency')).toBe(true);
});
test('a shared Task summary cannot widen its parent memory ACL to the task creator',async()=>{
 const s=setup();s.memory.importLegacy(root,[{id:'agent-private',kind:'memory',title:'偏好',content:'仅 a 的偏好',scope:'agent',agentId:'a',projectId:'p',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'}]);const record=s.recall.search(actor,{projectId:'p',query:'仅 a'}).items[0];
 const task=s.tasks.createTask({...root,agentId:'b'},{goal:'总结偏好',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'shared-task'),run=s.tasks.startTask(root,task.id,task.revision,'start');s.recall.recordUse({...actor,runId:run.id},{runId:run.id,query:'偏好',items:[{recordId:record.recordId,revision:record.revision}]});
 const asset=s.assets.getAuthorizedAsset(root,s.collection.id);s.assets.setAccess(root,asset.id,{mode:'all'},asset.revision);s.memory.captureTask(root,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'});await s.pipeline.runNext('task');expect(s.memory.list(actor,{projectId:'p',taskId:task.id,status:'active'})).toHaveLength(1);expect(s.memory.list({...root,agentId:'b'},{projectId:'p',taskId:task.id,status:'active'})).toEqual([]);
});
test('public fixed-reference validation accepts only compatible revisions in the explicit trusted scope',async()=>{
 const s=setup(),{record}=await original(s),input={projectId:'p',items:[{recordId:record.recordId,revision:record.revision}]};
 expect(()=>s.memory.validateReferences(actor,input)).not.toThrow();
 const repeat=s.chat();s.ack(repeat.id,'repeat',record);s.turn(repeat.id,'repeat');s.capture(repeat.id);await s.pipeline.runNext('repeat');const appended=s.memory.read(actor,record.recordId,'p');expect(appended.revision).toBeGreaterThan(record.revision);expect(()=>s.memory.validateReferences(actor,input)).not.toThrow();
 expect(()=>s.memory.validateReferences(actor,{...input,projectId:'q'})).toThrow();expect(()=>s.memory.validateReferences(actor,{...input,projectId:undefined as unknown as string})).toThrow();
 const task=s.tasks.createTask(root,{goal:'verify',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'validation-task'),run=s.tasks.startTask(root,task.id,task.revision,'validation-run');expect(()=>s.memory.validateReferences({...root,runId:run.id},input)).toThrow();expect(()=>s.memory.validateReferences({...actor,runId:run.id},input)).not.toThrow();expect(()=>s.memory.validateReferences({...actor,runId:run.id},{...input,projectId:'q'})).toThrow();expect(()=>s.memory.validateReferences({...actor,runId:run.id},{projectId:'q',items:[]})).toThrow();
 const corrected=s.memory.correct(root,{recordId:record.recordId,expectedRevision:appended.revision,text:'请记住：以后用英文回答'});expect(()=>s.memory.validateReferences(actor,input)).toThrow();s.memory.retract(root,{recordId:record.recordId,expectedRevision:corrected.revision});s.memory.restore(root,{recordId:record.recordId,expectedRevision:corrected.revision+1});expect(()=>s.memory.validateReferences(actor,{...input,items:[{recordId:record.recordId,revision:corrected.revision}]})).toThrow();
 const head=s.memory.read(actor,record.recordId,'p'),asset=s.assets.getAuthorizedAsset(root,s.collection.id);s.assets.setAccess(root,asset.id,{mode:'private'},asset.revision);expect(()=>s.memory.validateReferences(actor,{projectId:'p',items:[{recordId:head.recordId,revision:head.revision}]})).toThrow();
});
test('recordUse preserves both actually delivered revisions across an independent evidence append',async()=>{
 const s=setup(),{record}=await original(s),task=s.tasks.createTask(root,{goal:'first use',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'first-use'),run=s.tasks.startTask(root,task.id,task.revision,'first-run');
 const originalItems=[{recordId:record.recordId,revision:1}],first=s.recall.recordUse({...actor,runId:run.id},{runId:run.id,query:'中文',items:originalItems});
 const repeat=s.chat();s.turn(repeat.id,'independent');s.capture(repeat.id);await s.pipeline.runNext('independent');expect(s.memory.read(actor,record.recordId,'p')).toMatchObject({revision:2,revisionKind:'evidence_append'});
 const next=s.tasks.createTask(root,{goal:'follow-up',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'follow-up'),nextRun=s.tasks.startTask(root,next.id,next.revision,'next-run'),items=[...originalItems,{recordId:record.recordId,revision:2}];
 const use=s.recall.recordUse({...actor,runId:nextRun.id},{runId:nextRun.id,query:'中文',items});
 const firstRow=s.store.database.prepare('SELECT run_id,data FROM memory_uses WHERE id=?').get(first)!,nextRow=s.store.database.prepare('SELECT run_id,data FROM memory_uses WHERE id=?').get(use)!;
 expect(firstRow.run_id).toBe(run.id);expect(JSON.parse(firstRow.data as string).items).toEqual(originalItems);expect(nextRow.run_id).toBe(nextRun.id);expect(JSON.parse(nextRow.data as string)).toMatchObject({items,actualUse:'provided_to_native',causality:'not_established'});
 expect(s.memory.captureTask(root,{collectionId:s.collection.id,taskId:next.id,trigger:'stable'}).sources[0].memoryRefs).toEqual(items);expect(s.memory.read(actor,record.recordId,'p').revision).toBeGreaterThan(1);
});
test.each(['correction','retraction','restore','acl','source','source-edit','missing-history'] as const)('recordUse rejects an inherited fixed revision after %s without inserting a use',async change=>{
 const s=setup(),{chat,record}=await original(s),repeat=s.chat();s.turn(repeat.id,'independent');s.capture(repeat.id);await s.pipeline.runNext('independent');
 const task=s.tasks.createTask(root,{goal:'follow-up',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'follow-up'),run=s.tasks.startTask(root,task.id,task.revision,'run');
 if(change==='correction')s.memory.correct(root,{recordId:record.recordId,expectedRevision:2,text:record.text});
 if(change==='retraction'||change==='restore')s.memory.retract(root,{recordId:record.recordId,expectedRevision:2});
 if(change==='restore')s.memory.restore(root,{recordId:record.recordId,expectedRevision:3});
 if(change==='acl'){const asset=s.assets.getAuthorizedAsset(root,s.collection.id);s.assets.setAccess(root,asset.id,{mode:'private'},asset.revision);}
 if(change==='source')s.memory.retractSource(root,{sourceId:record.evidence[0].sourceId,expectedRevision:record.evidence[0].sourceRevision});
 if(change==='source-edit')s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'变更后的来源',invocationId:'original'}),s.store.listEvents(chat.id,0).find(e=>e.kind==='user')!.id);
 if(change==='missing-history')s.store.database.prepare('DELETE FROM memory_revisions WHERE record_id=? AND revision=1').run(record.recordId);
 const input={runId:run.id,query:'中文',items:[{recordId:record.recordId,revision:1}]};expect(()=>s.recall.recordUse({...actor,runId:run.id},input)).toThrow();expect(()=>s.recall.recordUse(root,input)).toThrow();expect(s.store.database.prepare('SELECT id FROM memory_uses').all()).toEqual([]);
});
test('recordUse retains actual Run identity and project checks including empty handoffs and malformed fixed refs',async()=>{
 const s=setup(),{record}=await original(s),task=s.tasks.createTask({...root,agentId:'b'},{goal:'use',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'use'),run=s.tasks.startTask(root,task.id,task.revision,'run');
 const other=s.tasks.createTask(root,{goal:'other project',criteria:[],acceptance:'human',projectId:'q',assigneeAgentId:'a'},'other'),otherRun=s.tasks.startTask(root,other.id,other.revision,'other-run'),input={runId:run.id,query:'中文',items:[{recordId:record.recordId,revision:1}]};
 for(const principal of [{userId:'outsider',agentId:'a',runId:run.id},{...root,runId:run.id},{...root,agentId:'b',runId:run.id},{...actor,runId:otherRun.id}])for(const items of [input.items,[]])expect(()=>s.recall.recordUse(principal,{...input,items})).toThrow();
 for(const principal of [root,{...actor,runId:otherRun.id}])expect(()=>s.recall.recordUse(principal,{...input,runId:otherRun.id})).toThrow();
 for(const revision of [0,1.5,2])expect(()=>s.recall.recordUse({...actor,runId:run.id},{...input,items:[{recordId:record.recordId,revision}]})).toThrow();
 expect(s.store.database.prepare('SELECT id FROM memory_uses').all()).toEqual([]);expect(()=>s.recall.recordUse(root,{...input,items:[]})).not.toThrow();
});
test('recordUse cannot let the Task creator or root bypass a recursive parent ACL for the actual assignee',async()=>{
 const s=setup();s.memory.importLegacy(root,[{id:'agent-private-use',kind:'memory',title:'偏好',content:'仅 a 的偏好',scope:'agent',agentId:'a',projectId:'p',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'}]);const parent=s.recall.search(actor,{projectId:'p',query:'仅 a'}).items[0];
 const task=s.tasks.createTask({...root,agentId:'b'},{goal:'summary',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'summary'),run=s.tasks.startTask(root,task.id,task.revision,'summary-run');s.recall.recordUse({...actor,runId:run.id},{runId:run.id,query:'偏好',items:[{recordId:parent.recordId,revision:1}]});
 const asset=s.assets.getAuthorizedAsset(root,s.collection.id);s.assets.setAccess(root,asset.id,{mode:'all'},asset.revision);s.memory.captureTask(root,{collectionId:s.collection.id,taskId:task.id,trigger:'stable'});await s.pipeline.runNext('summary');const summary=s.memory.list(actor,{projectId:'p',taskId:task.id,status:'active'})[0];
 const next=s.tasks.createTask(root,{goal:'use shared summary',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'b'},'use-summary'),nextRun=s.tasks.startTask(root,next.id,next.revision,'use-summary-run'),input={runId:nextRun.id,query:'偏好',items:[{recordId:summary.recordId,revision:summary.revision}]};
 expect(()=>s.assets.getAuthorizedAsset({...root,agentId:'b'},summary.collectionId)).not.toThrow();expect(()=>s.recall.recordUse({...root,agentId:'b',runId:nextRun.id},input)).toThrow();expect(()=>s.recall.recordUse(root,input)).toThrow();expect(s.store.database.prepare('SELECT id FROM memory_uses WHERE run_id=?').all(nextRun.id)).toEqual([]);
});
test('recordUse rejects a previously compatible fixed revision once its current validity expires',async()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-10-04T00:00:00Z');
 try{
  const s=setup(),chat=s.chat();s.turn(chat.id,'expiring');const source=s.capture(chat.id).sources[0],record=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L1',contentType:'preference',text:'请记住：以后用中文回答',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision,startEventId:source.eventIds[0],endEventId:source.eventIds[0]}],validUntil:'2026-10-04T00:01:00Z',support:[{sourceId:source.id,eventId:source.eventIds[0],quote:'请记住：以后用中文回答'}],certainty:'user_asserted'},1,'evidence_extract')!;await s.pipeline.runNext('expiring');
  const repeat=s.chat();s.turn(repeat.id,'repeat');s.capture(repeat.id);await s.pipeline.runNext('repeat');expect(s.memory.read(actor,record.recordId,'p').revision).toBeGreaterThan(1);
  const task=s.tasks.createTask(root,{goal:'use',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'use'),run=s.tasks.startTask(root,task.id,task.revision,'run'),input={runId:run.id,query:'中文',items:[{recordId:record.recordId,revision:1}]};s.recall.recordUse({...actor,runId:run.id},input);
  vi.setSystemTime('2026-10-04T00:02:00Z');expect(()=>s.recall.recordUse({...actor,runId:run.id},input)).toThrow();expect(()=>s.recall.recordUse(root,input)).toThrow();expect(s.store.database.prepare('SELECT id FROM memory_uses').all()).toHaveLength(1);
 }finally{vi.useRealTimers();}
});
