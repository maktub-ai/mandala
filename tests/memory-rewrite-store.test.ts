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
import type { MemoryProposal } from '../shared/memory';
const root={userId:'local'}, homes:string[]=[], stores:ReturnType<typeof openStore>[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}));});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'rewrite-store-'));homes.push(home);const store=openStore(home);stores.push(store);
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeProject:(p,project)=>{if(!['p','q'].includes(project)||!['a','b'].includes(p.agentId!))throw new Error('forbidden');}}),c=memory.ensureCollection(root,{projectId:'p',agentId:'a'});
 const capture=(text:string,kind:'request'|'session'='request')=>{const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});const e=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});const result=memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind});return {e,...result};};
 const proposal=(captured:ReturnType<typeof capture>,text:string):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:captured.sources[0].id,sourceRevision:1}],support:[{sourceId:captured.sources[0].id,eventId:captured.e.id,quote:text}],semanticKey:'report language',validUntil:null,certainty:'inferred'});
 return {store,memory,tasks,c,capture,proposal};
}
test('ordinary supported facts activate and project members share scope without certainty authority',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文');
 const r=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;expect(r.status).toBe('active');
 expect(s.memory.ensureCollection(root,{projectId:'p',agentId:'b'}).id).toBe(s.c.id);
 expect(s.memory.list({...root,agentId:'b'},{projectId:'p'}).map(r=>r.recordId)).toContain(r.recordId);
 expect(s.memory.list({...root,agentId:'b'},{projectId:'q'})).toEqual([]);
 expect(()=>s.memory.applyProposal(root,{...p,text:'无来源',support:[{...p.support![0],quote:'不存在'}]},s.c.generation,'evidence_extract')).toThrow('unsupported_extract');
});
test('independent chain jobs merge provenance and explicit revision supersedes prior facts',()=>{
 const s=setup(),a=s.capture('报告使用中文'),p=s.proposal(a,'报告使用中文'),r=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const b=s.capture('报告使用中文','session');const same=s.memory.applyProposal(root,s.proposal(b,'报告使用中文'),s.c.generation,'evidence_extract')!;expect(same.recordId).toBe(r.recordId);expect(same.evidence).toHaveLength(2);
 const change=s.capture('报告现在改为英文'),next=s.memory.applyProposal(root,{...s.proposal(change,'报告现在改为英文'),operation:'update',replaces:[{recordId:r.recordId,revision:same.revision}],explicitChange:true},s.c.generation,'evidence_extract')!;
 expect(next.status).toBe('active');expect(s.memory.read(root,r.recordId).status).toBe('superseded');
 expect(s.store.database.prepare('SELECT * FROM memory_record_scope WHERE record_id=?').get(next.recordId)).toMatchObject({project_id:'p',agent_id:null});
 expect(a.jobs[0].extractorVersion).toBe('request-v2');expect(b.jobs[0].extractorVersion).toBe('session-v2');
});
test('capture merges stream evidence, retains hashes and excludes tool arguments and failed outputs',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'user',{text:'查看部署'});s.store.appendEvent(chat.id,'text',{text:'第'});s.store.appendEvent(chat.id,'text',{text:'一段'});
 const first=s.store.appendEvent(chat.id,'tool',{method:'item/commandExecution/outputDelta',params:{itemId:'check',delta:'服务版本 '}});
 s.store.appendEvent(chat.id,'tool',{method:'item/commandExecution/outputDelta',params:{itemId:'check',delta:'v2 token=synthetic-secret'}});
 s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'check',type:'commandExecution',command:'password=argument-secret',status:'completed',exitCode:0}}});
 s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'failed',type:'commandExecution',status:'failed',exitCode:1,aggregatedOutput:'错误不能作为事实'}}});
 s.store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),source=captured.sources[0];
 expect(source.events.find(e=>e.kind==='text')?.text).toBe('第一段');expect(source.events.find(e=>e.id===first.id)?.text).toContain('服务版本 v2');
 expect(source.text).not.toContain('synthetic-secret');expect(source.text).not.toContain('argument-secret');expect(source.text).not.toContain('错误不能作为事实');
 const proposal=s.proposal({...captured,e:first},'服务版本 v2');expect(s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')?.status).toBe('active');
});
test('recalled memory output remains in L0 but cannot become fresh evidence',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote='旧版使用 shadow 提炼。';
 s.store.appendEvent(chat.id,'user',{text:'总结当前记忆模块。'});
 const event=s.store.appendEvent(chat.id,'tool',{method:'item/started',params:{item:{id:'cache',type:'commandExecution',command:'cat /synthetic/.codex/memories/MEMORY.md'}}});
 s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'cache',type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:quote}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(source.text).toContain(quote);expect(source.events.find(e=>e.id===event.id)).toMatchObject({contextOnly:true,text:quote});
 expect(()=>s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'新版使用 shadow 提炼。',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')).toThrow('unsupported_extract');
});
test('verified code containing a question-mark operator is usable tool evidence',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote='const mode = enabled ? "active" : "off";';
 s.store.appendEvent(chat.id,'user',{text:'查看当前模块配置。'});
 const event=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'read',type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:quote}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:'模块通过 enabled 选择 active 或 off 模式。',operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')?.status).toBe('active');
});
test('only source supported user preference can become global, personal experience stays private',()=>{
 const s=setup(),captured=s.capture('我偏好所有项目报告使用中文'),p=s.proposal(captured,'我偏好所有项目报告使用中文');
 const r=s.memory.applyProposal(root,{...p,contentType:'preference',scope:'user'},s.c.generation,'evidence_extract')!;
 expect(s.memory.list({...root,agentId:'b'},{projectId:'q'}).map(r=>r.recordId)).toContain(r.recordId);
 expect(()=>s.memory.source({...root,agentId:'b'},captured.sources[0].id,'q')).toThrow();
 expect(()=>s.memory.applyProposal(root,{...p,scope:'user'},s.c.generation,'evidence_extract')).toThrow('unsupported_user_scope');
 const personal=s.memory.ensureCollection(root,{projectId:null,agentId:'a'});expect(()=>s.memory.collection({...root,agentId:'b'},personal.id,null)).toThrow();
});
test('a semantic key alone cannot silently discard a differing statement; resolved merge shares one active fact',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文');const first=s.memory.applyProposal(root,{...p,pipeline:'request'},s.c.generation,'evidence_extract')!;
 const uncertain=s.memory.applyProposal(root,{...p,text:'报告语言是中文',pipeline:'session'},s.c.generation,'evidence_extract')!;expect(uncertain.status).toBe('proposed');
 const merged=s.memory.applyProposal(root,{...p,text:'报告语言是中文',pipeline:'session',operation:'merge',replaces:[{recordId:first.recordId,revision:first.revision}]},s.c.generation,'evidence_extract',{conflictResolved:true})!;expect(merged.status).toBe('active');expect(merged.pipelines).toEqual(['request','session']);expect(s.memory.listAll(root).filter(r=>r.status==='active')).toEqual([merged]);
 const conflict=s.capture('报告使用英文');expect(s.memory.applyProposal(root,s.proposal(conflict,'报告使用英文'),s.c.generation,'evidence_extract')?.status).toBe('proposed');
});
test('global derived preference references global authoritative facts and corrections generate history notices',()=>{
 const s=setup(),captured=s.capture('我偏好所有项目报告使用中文'),p={...s.proposal(captured,'我偏好所有项目报告使用中文'),contentType:'preference' as const,scope:'user' as const};
 const fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const summary=s.memory.applyProposal(root,{...p,layer:'L2',text:'用户通用偏好：中文报告',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 expect(s.memory.list({...root,agentId:'b'},{projectId:'q'}).map(r=>r.recordId)).toContain(summary.recordId);
 const corrected=s.memory.correct(root,{recordId:fact.recordId,expectedRevision:1,text:'用户通用偏好：英文报告'});
 expect(s.memory.history({...root,agentId:'b'},{projectId:'q',items:[{recordId:fact.recordId,revision:1},{recordId:summary.recordId,revision:1},{recordId:'removed',revision:1}]})).toMatchObject({items:[{recordId:fact.recordId,revision:corrected.revision}],notices:expect.arrayContaining([expect.objectContaining({status:'corrected'}),expect.objectContaining({status:'stale'}),expect.objectContaining({status:'removed'})])});
});
test('evolving derived summaries supersede old revisions with validated active dependencies',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文'),fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const initial={...p,layer:'L2' as const,pipeline:'session' as const,text:'本场景报告语言为中文',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},old=s.memory.applyProposal(root,initial,s.c.generation,'layer_summary')!;
 const next=s.memory.applyProposal(root,{...initial,pipeline:'request',text:'场景使用中文撰写报告',operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}]},s.c.generation,'layer_summary')!;
 expect(next.pipelines).toEqual(['session','request']);expect(next.status).toBe('active');expect(s.memory.read(root,old.recordId).status).toBe('superseded');
 expect(()=>s.memory.applyProposal(root,{...initial,dependencies:[{recordId:next.recordId,revision:next.revision}],text:next.text},s.c.generation,'layer_summary')).toThrow('dependency_cycle');
});
test('project-limited preferences cannot be promoted to global user scope',()=>{
 const s=setup(),captured=s.capture('本项目我偏好 PostgreSQL'),p={...s.proposal(captured,'本项目我偏好 PostgreSQL'),contentType:'preference' as const,scope:'user' as const};
 expect(()=>s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')).toThrow('unsupported_user_scope');
});
test('project handoff can reference global preferences but not private unscoped facts',()=>{
 const s=setup(),captured=s.capture('我偏好所有项目报告使用中文'),p={...s.proposal(captured,'我偏好所有项目报告使用中文'),contentType:'preference' as const,scope:'user' as const},fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 expect(()=>s.memory.validateReferences({...root,agentId:'b'},{projectId:'p',items:[{recordId:fact.recordId,revision:fact.revision}]})).not.toThrow();
 const summary=s.memory.applyProposal(root,{...p,scope:'collection',layer:'L2',text:'本项目报告遵循用户中文偏好',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 expect(s.memory.read({...root,agentId:'b'},summary.recordId,'p').status).toBe('active');
});
test('derived claims use explicit dependencies rather than every inherited recalled summary',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文'),fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const old=s.memory.applyProposal(root,{...p,layer:'L2',text:'场景报告语言为中文',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',invocationId:'round2',items:[{recordId:old.recordId,revision:old.revision}]});const event=s.store.appendEvent(chat.id,'user',{text:'报告使用中文',invocationId:'round2'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const next=s.memory.applyProposal(root,{...p,layer:'L2',text:'场景报告仍使用中文',operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}],dependencies:[{recordId:fact.recordId,revision:fact.revision}],evidence:[{sourceId:source.id,sourceRevision:source.revision,startEventId:event.id,endEventId:event.id}],support:[{sourceId:source.id,eventId:event.id,quote:'报告使用中文'}]},s.c.generation,'layer_summary')!;
 expect(next.dependencies).toEqual([{recordId:fact.recordId,revision:fact.revision}]);expect(s.memory.read(root,next.recordId).status).toBe('active');
});
test('personal experience in project conversation stays private to the source agent',()=>{
 const s=setup(),captured=s.capture('我的个人经验是调试时先检查服务日志'),p=s.proposal(captured,'我的个人经验是调试时先检查服务日志');
 expect(()=>s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')).toThrow('agent_scope_required');
 const r=s.memory.applyProposal(root,{...p,scope:'agent'},s.c.generation,'evidence_extract')!;
 expect(s.memory.read({...root,agentId:'a'},r.recordId,'p').status).toBe('active');expect(()=>s.memory.read({...root,agentId:'b'},r.recordId,'p')).toThrow();
 expect(s.memory.list({...root,agentId:'b'},{projectId:'p'}).some(i=>i.recordId===r.recordId)).toBe(false);expect(s.memory.list({...root,agentId:'a'},{projectId:'p'}).some(i=>i.recordId===r.recordId)).toBe(true);
});
test('truncated model quote cannot convert a question into an asserted fact',()=>{
 const s=setup(),captured=s.capture('这个项目使用 pnpm 吗？'),p=s.proposal(captured,'这个项目使用 pnpm');
 expect(()=>s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')).toThrow('unsupported_extract');
});
test('superseding a recalled old scene does not invalidate independent second-turn facts or new scene',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文'),fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const old=s.memory.applyProposal(root,{...p,layer:'L2',text:'场景报告语言为中文',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',invocationId:'new',items:[{recordId:old.recordId,revision:old.revision}]});const event=s.store.appendEvent(chat.id,'user',{text:'报告需要列出来源',invocationId:'new'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],proposal={...p,text:'报告需要列出来源',semanticKey:'report references',evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:'报告需要列出来源'}]};
 const second=s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:undefined,text:'报告使用中文并列出来源',operation:'update',replaces:[{recordId:old.recordId,revision:old.revision}],dependencies:[{recordId:fact.recordId,revision:fact.revision},{recordId:second.recordId,revision:second.revision}]},s.c.generation,'layer_summary')!;
 expect(s.memory.read({...root,agentId:'b'},second.recordId,'p').status).toBe('active');expect(s.memory.read({...root,agentId:'b'},scene.recordId,'p').status).toBe('active');expect(s.memory.source({...root,agentId:'b'},source.id,'p').status).toBe('ready');
});
test('a modern project source can inherit a global preference originating in another authorized project',()=>{
 const s=setup(),captured=s.capture('我偏好所有项目报告使用中文'),preference=s.memory.applyProposal(root,{...s.proposal(captured,'我偏好所有项目报告使用中文'),contentType:'preference',scope:'user'},s.c.generation,'evidence_extract')!;
 const q=s.memory.ensureCollection(root,{projectId:'q',agentId:'b'}),chat=s.store.createConversation({projectId:'q',agentId:'b',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',invocationId:'q',items:[{recordId:preference.recordId,revision:preference.revision}]});const event=s.store.appendEvent(chat.id,'user',{text:'这里的报告标题为季度回顾',invocationId:'q'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:q.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(s.memory.source({...root,agentId:'b'},source.id,'q').status).toBe('ready');
 const fact=s.memory.applyProposal(root,{...s.proposal({...captured,sources:[source],e:event},'这里的报告标题为季度回顾'),collectionId:q.id},q.generation,'evidence_extract')!;expect(s.memory.read({...root,agentId:'b'},fact.recordId,'q').status).toBe('active');
});
test('private experience is recalled across its agent contexts without widening project summaries',()=>{
 const s=setup(),captured=s.capture('我的个人经验是调试时先检查服务日志'),p=s.proposal(captured,'我的个人经验是调试时先检查服务日志'),r=s.memory.applyProposal(root,{...p,scope:'agent'},s.c.generation,'evidence_extract')!;
 for(const projectId of ['p','q',null])expect(s.memory.read({...root,agentId:'a'},r.recordId,projectId).status).toBe('active');
 expect(()=>s.memory.applyProposal(root,{...p,layer:'L2',text:'共享场景经验摘要',support:[],dependencies:[{recordId:r.recordId,revision:r.revision}]},s.c.generation,'layer_summary')).toThrow('memory_dependency_scope');
 expect(()=>s.memory.read({...root,agentId:'b'},r.recordId,'q')).toThrow();
 const other=s.store.createConversation({projectId:'p',agentId:'b',cli:'codex',model:null});const event=s.store.appendEvent(other.id,'user',{text:'我的个人经验是先检查数据库'});s.store.appendEvent(other.id,'status',{status:'idle'});const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:other.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(()=>s.memory.applyProposal(root,{...p,scope:'agent',evidence:[...p.evidence,{sourceId:source.id,sourceRevision:source.revision}],support:[...p.support!,{sourceId:source.id,eventId:event.id,quote:'我的个人经验是先检查数据库'}]},s.c.generation,'evidence_extract')).toThrow('agent_scope_mismatch');
});
test('modern Task capture provides workflow state authority to the request extraction pipeline',async()=>{
 const s=setup(),task=s.tasks.createTask(root,{goal:'检查合成样例',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'state-evidence');
 const run=s.tasks.startTask(root,task.id,task.revision,'task-state-run'),identity={runId:run.id,hostId:'local',nativeSessionId:'task-session',nativeTurnId:'task-turn'};s.tasks.bindRunIdentity(identity);s.tasks.applyRunEvent({...identity,eventKey:'done',outcome:'succeeded',summary:'助手声称业务已经成功',artifactVersions:[]});const finished=s.tasks.getTask(root,task.id),review=s.tasks.userCommand(root,task.id,finished.revision,'complete');s.tasks.userCommand(root,task.id,review.revision,'accept');const current=s.tasks.getTask(root,task.id);
 const captured=s.memory.captureTask(root,{collectionId:s.c.id,taskId:task.id,trigger:'completed',kind:'request'}),source=captured.sources[0],event=source.events[0];
 expect(event).toMatchObject({id:current.revision,kind:'tool'});expect(event.text).toContain(`平台状态 ${current.state}`);expect(event.text).not.toContain('助手摘要');expect(captured.jobs[0].extractorVersion).toBe('request-v2');
 const jobs=createMemoryJobs(s.store,s.memory),pipeline=createMemoryPipeline(s.memory,jobs,{generate:async({job,stage,sources})=>stage==='extract'?[{collectionId:job.collectionId,layer:'L1',contentType:'fact',text:`Task平台状态为 ${current.state}`,operation:'store',replaces:[],evidence:[{sourceId:sources[0].id,sourceRevision:sources[0].revision}],support:[{sourceId:sources[0].id,eventId:event.id,quote:`平台状态 ${current.state}`}],validUntil:null,certainty:'observed'}]:[]});
 for(let i=0;i<4;i++)await pipeline.runNext('task');expect(jobs.list(root)[0]).toMatchObject({state:'queued',stage:'scene',error:'scene_no_result'});
 expect(s.memory.list({...root,agentId:'a'},{projectId:'p',taskId:task.id,status:'active'})).toEqual([expect.objectContaining({verification:'evidence_extract',pipelines:['request'],text:`Task平台状态为 ${current.state}`})]);
});
test('project scene can use exact evidence from a global preference in another project',()=>{
 const s=setup(),captured=s.capture('我偏好所有项目报告使用中文'),preference=s.memory.applyProposal(root,{...s.proposal(captured,'我偏好所有项目报告使用中文'),contentType:'preference',scope:'user'},s.c.generation,'evidence_extract')!;
 const q=s.memory.ensureCollection(root,{projectId:'q',agentId:'b'}),chat=s.store.createConversation({projectId:'q',agentId:'b',cli:'codex',model:null}),event=s.store.appendEvent(chat.id,'user',{text:'季度报告列出来源'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:q.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],proposal={...s.proposal({...captured,sources:[source],e:event},'季度报告列出来源'),collectionId:q.id},fact=s.memory.applyProposal(root,proposal,q.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...proposal,layer:'L2',text:'季度报告使用中文并列出来源',evidence:[...proposal.evidence,...preference.evidence],support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision},{recordId:preference.recordId,revision:preference.revision}]},q.generation,'layer_summary')!;
 expect(s.memory.read({...root,agentId:'b'},scene.recordId,'q').status).toBe('active');
 expect(()=>s.memory.applyProposal(root,{...proposal,layer:'L2',text:'未经依赖许可的跨项目摘要',evidence:preference.evidence,dependencies:[{recordId:fact.recordId,revision:fact.revision}]},q.generation,'layer_summary')).toThrow('scope_mismatch');
});
test('an asserted sentence stays extractable when the user also asks a separate question',()=>{
 const s=setup(),captured=s.capture('本项目使用 pnpm。你明白吗？'),p=s.proposal(captured,'本项目使用 pnpm。');expect(s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')?.status).toBe('active');
 const conditional=s.capture('如果依赖冲突，这个项目使用 npm。');expect(()=>s.memory.applyProposal(root,s.proposal(conditional,'这个项目使用 npm。'),s.c.generation,'evidence_extract')).toThrow('unsupported_extract');
});
test('human source reads infer captured project for modern inherited refs while agent scope remains explicit',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),fact=s.memory.applyProposal(root,s.proposal(captured,'报告使用中文'),s.c.generation,'evidence_extract')!;
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',invocationId:'read',items:[{recordId:fact.recordId,revision:fact.revision}]});s.store.appendEvent(chat.id,'user',{text:'报告需要列来源',invocationId:'read'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(s.memory.source(root,source.id).status).toBe('ready');expect(s.memory.validateSource(root,{sourceId:source.id,sourceRevision:source.revision},true).status).toBe('ready');
 expect(()=>s.memory.source({...root,agentId:'a'},source.id)).toThrow('project_scope_required');
});
test('one synchronous DAG query validates each conversation once and the next query observes source edits and ACL revocation',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),p=s.proposal(captured,'报告使用中文'),fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;let previous=[fact];
 for(let depth=0;depth<6;depth++)previous=[0,1].map(branch=>s.memory.applyProposal(root,{...p,layer:'L2',text:`场景 ${depth} 分支 ${branch}`,semanticKey:undefined,dependencies:previous.map(({recordId,revision})=>({recordId,revision}))},s.c.generation,'layer_summary')!);
 const spy=vi.spyOn(s.store,'listEvents');const output=s.memory.list({...root,agentId:'a'},{projectId:'p',status:'active'});expect(output).toHaveLength(13);expect(spy.mock.calls.length).toBeLessThanOrEqual(1);spy.mockRestore();
 const source=captured.sources[0],event=s.store.database.prepare('SELECT data FROM events WHERE id=?').get(captured.e.id)!,data=JSON.parse(event.data as string);data.text='用户已改写原始事件';s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),captured.e.id);
 expect(s.memory.list({...root,agentId:'a'},{projectId:'p',status:'active'})).toEqual([]);
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(event.data as string,captured.e.id);expect(s.memory.read({...root,agentId:'a'},fact.recordId,'p').status).toBe('active');
 const asset=s.memory.options.assets.getAuthorizedAsset(root,s.c.id);s.memory.options.assets.setAccess(root,asset.id,{mode:'private'},asset.revision);expect(s.memory.list({...root,agentId:'a'},{projectId:'p',status:'active'})).toEqual([]);
 expect(source.id).toBe(fact.evidence[0].sourceId);
});
test('scope candidate query uses indexed scope branches instead of a full records scan',()=>{
 const s=setup(),captured=s.capture('报告使用中文');s.memory.applyProposal(root,s.proposal(captured,'报告使用中文'),s.c.generation,'evidence_extract');
 const spy=vi.spyOn(s.store.database,'prepare');s.memory.list({...root,agentId:'a'},{projectId:'p'});const query=spy.mock.calls.map(([sql])=>sql).find(sql=>sql.startsWith('SELECT r.id FROM memory_records r JOIN memory_record_scope')||sql.includes('memory_record_scope s')&&sql.includes('UNION'));spy.mockRestore();expect(query).toBeDefined();
 const parameters=query!.includes('UNION')?['p','a','a']:['p'];const plan=s.store.database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(row=>String(row.detail));
 expect(plan.some(detail=>/SCAN r\b/.test(detail))).toBe(false);expect(plan.some(detail=>/memory_scope_lookup/.test(detail))).toBe(true);
});
test('SQL excludes another agent private candidates before loading their collection authority',()=>{
 const s=setup(),captured=s.capture('我的个人经验是先检查日志'),record=s.memory.applyProposal(root,{...s.proposal(captured,'我的个人经验是先检查日志'),scope:'agent'},s.c.generation,'evidence_extract')!;
 const spy=vi.spyOn(s.memory.options.assets,'getAuthorizedAsset');expect(s.memory.list({...root,agentId:'b'},{projectId:'p'})).toEqual([]);
 expect(spy.mock.calls.some(([,id])=>id===record.collectionId)).toBe(false);spy.mockRestore();expect(s.memory.read({...root,agentId:'a'},record.recordId,'p').status).toBe('active');
});
test('corroborating a derived summary preserves compatible dependency anchors for earlier handoffs',()=>{
 const s=setup(),first=s.capture('报告使用中文'),p=s.proposal(first,'报告使用中文'),fact=s.memory.applyProposal(root,p,s.c.generation,'evidence_extract')!;
 const summary=s.memory.applyProposal(root,{...p,layer:'L2',semanticKey:undefined,text:'报告语言为中文',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 const second=s.capture('报告使用中文'),corroborated=s.memory.applyProposal(root,s.proposal(second,'报告使用中文'),s.c.generation,'evidence_extract')!;expect(corroborated.revision).toBe(2);
 const repeated=s.memory.applyProposal(root,{...s.proposal(second,'报告使用中文'),layer:'L2',semanticKey:undefined,text:summary.text,dependencies:[{recordId:corroborated.recordId,revision:corroborated.revision}]},s.c.generation,'layer_summary')!;
 expect(repeated.recordId).toBe(summary.recordId);expect(repeated.revisionKind).toBe('evidence_append');expect(repeated.evidence).toHaveLength(2);expect(repeated.dependencies).toEqual(summary.dependencies);
 const actor={...root,agentId:'a'},handoff={projectId:'p',items:[{recordId:summary.recordId,revision:summary.revision}]};expect(()=>s.memory.validateReferences(actor,handoff)).not.toThrow();
 s.memory.correct(root,{recordId:corroborated.recordId,expectedRevision:corroborated.revision,text:'报告使用英文'});expect(()=>s.memory.validateReferences(actor,handoff)).toThrow('stale_memory_dependency');
});
test('global association filters exclude unrelated records before reading their source authority',()=>{
 const s=setup();for(let i=0;i<8;i++){const captured=s.capture(`无关联说明 ${i}`);s.memory.applyProposal(root,{...s.proposal(captured,`无关联说明 ${i}`),semanticKey:undefined},s.c.generation,'evidence_extract');}
 const task=s.tasks.createTask(root,{goal:'关联查询样例',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'indexed-associated'),source=s.memory.captureTask(root,{collectionId:s.c.id,taskId:task.id,trigger:'stable',kind:'request'}).sources[0],quote=`平台状态 ${task.state}`;
 const fact=s.memory.applyProposal(root,{collectionId:s.c.id,layer:'L1',contentType:'fact',text:`Task状态 ${task.state}`,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:task.revision,quote}],validUntil:null,certainty:'observed'},s.c.generation,'evidence_extract')!;
 const spy=vi.spyOn(s.store,'listEvents');expect(s.memory.listAll(root,{taskId:task.id,status:'active'}).map(r=>r.recordId)).toEqual([fact.recordId]);expect(spy).not.toHaveBeenCalled();spy.mockRestore();
});


test('tool evidence preserves file origin and time without persisting executable arguments',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'总结当前记忆模块。'});
 const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'code',command:'sed -n 1,80p server/memory-pipeline.ts --token synthetic-private-argument',cwd:'/synthetic/current-worktree',status:'completed',exitCode:0,aggregatedOutput:'当前采用 L0、L1、L2、L3。'}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(source.events.find(x=>x.id===e.id)).toMatchObject({origin:{files:['server/memory-pipeline.ts'],cwd:'/synthetic/current-worktree'},createdAt:e.createdAt});
 expect(JSON.stringify(source)).not.toContain('synthetic-private-argument');expect(JSON.stringify(source)).not.toContain('sed -n');
});

test('file observations must remain bound to their file and observation date',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote='L1 本轮事实 · L2 项目经验 · L3 Agent 方法 · L4 稳定偏好';
 s.store.appendEvent(chat.id,'user',{text:'总结当前记忆模块。'});
 const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'grep',command:'rg memory src/ManaWorkspace.tsx server/memory-runtime.ts',cwd:'/synthetic/old-worktree',status:'completed',exitCode:0,aggregatedOutput:'src/ManaWorkspace.tsx:121: '+quote}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),proposal={...s.proposal({...captured,e},quote),text:'OpenMana 新版记忆层级定义为 L1、L2、L3、L4。'};
 expect(()=>s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
 expect(()=>s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/old-worktree/server/memory-runtime.ts 的文案为 ${quote}`},s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
 expect(()=>s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/old-worktree/server/memory-runtime.ts 的文案为 ${quote}`,support:[{...proposal.support![0],quote:'src/ManaWorkspace.tsx:121: '+quote}]},s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
 expect(()=>s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/old-worktree/src/ManaWorkspace.tsx.backup 的文案为 ${quote}`},s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
 const saved=s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/old-worktree/src/ManaWorkspace.tsx 的资料库文案为 ${quote}，这是源文件观察，不证明当前运行模块。`},s.c.generation,'evidence_extract')!;
 expect(saved.status).toBe('active');expect(saved.text).toContain('ManaWorkspace.tsx');
});
test('a directory search binds quotes to output filenames absent from explicit command paths',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote='闲置会话默认 6 小时';
 s.store.appendEvent(chat.id,'user',{text:'总结记忆设置。'});
 const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'directory-search',command:'rg memory src; cat server/memory-recall.ts',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:'src/SettingsPage.tsx:229: '+quote}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),proposal=s.proposal({...captured,e},quote);
 expect(()=>s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/worktree/server/memory-recall.ts 文案为 ${quote}`},s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
 expect(s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/worktree/src/SettingsPage.tsx 文案为 ${quote}`},s.c.generation,'evidence_extract')?.status).toBe('active');
});
test('a pure directory search preserves cwd for exact output-file observations',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote='闲置会话默认 6 小时';
 s.store.appendEvent(chat.id,'user',{text:'总结记忆设置。'});
 const line='src/SettingsPage.tsx:229:12: '+quote,e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'directory-only',command:'rg memory src',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:line}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}),proposal=s.proposal({...captured,e},quote);
 expect(captured.sources[0].events.find(x=>x.id===e.id)?.origin).toEqual({files:[],cwd:'/synthetic/worktree'});
 for(const supportQuote of [quote,line])expect(s.memory.applyProposal(root,{...proposal,text:`${e.createdAt.slice(0,10)} /synthetic/worktree/src/SettingsPage.tsx 文案为 ${quote}`,support:[{...proposal.support![0],quote:supportQuote}]},s.c.generation,'evidence_extract')?.status).toBe('active');
});
test('directory inventories without file-line observations keep source metadata unchanged',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'列出记忆文件。'});
 const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'inventory',command:'rg --files src',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:'src/SettingsPage.tsx'}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];expect(source.events.find(x=>x.id===e.id)?.origin).toBeUndefined();
});
test('unlabelled output from multiple files cannot prove a particular file observation',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),quote="33:export function explicitMemoryKind(text:string)";
 s.store.appendEvent(chat.id,'user',{text:'检查记忆函数。'});const e=s.store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'mixed-files',command:'rg -n explicitMemoryKind server/memory-store.ts; cat server/memory-prompts.ts',cwd:'/synthetic/worktree',status:'completed',exitCode:0,aggregatedOutput:quote}}});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:s.c.id,conversationId:chat.id,trigger:'explicit',kind:'request'});
 expect(()=>s.memory.applyProposal(root,{...s.proposal({...captured,e},quote),text:`${e.createdAt.slice(0,10)} /synthetic/worktree/server/memory-prompts.ts 定义 explicitMemoryKind。`},s.c.generation,'evidence_extract')).toThrow('tool_observation_scope_required');
});


test('revoking an L0 source invalidates its scenes and exposes an authorized rebuild target',()=>{
 const s=setup(),captured=s.capture('报告使用中文'),proposal=s.proposal(captured,'报告使用中文'),fact=s.memory.applyProposal(root,proposal,s.c.generation,'evidence_extract')!;
 const scene=s.memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:'scene.report',text:'报告场景采用中文',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 s.memory.retractSource(root,{sourceId:captured.sources[0].id,expectedRevision:1});expect(s.memory.staleScenes(root,'p')).toEqual([expect.objectContaining({recordId:scene.recordId,status:'stale'})]);expect(s.memory.list({...root,agentId:'b'},{projectId:'p',status:'active'})).toEqual([]);
});
