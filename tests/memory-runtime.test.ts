import {readConfiguredRuntime} from './configured-runtime';
import { businessCliContext } from './business-cli-context';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createMemoryRuntime } from '../server/memory-runtime';
import { migrateWorkspace } from '../server/workspace-migrations';
import { readKnowledge, updateKnowledge } from '../server/knowledge';
import { getUsage } from '../server/usage';
import { createTasks } from '../server/tasks';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function generatedMemory(_config:unknown,prompt:string) {
 const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
 if(data.stage==='conflict')return JSON.stringify(data.atoms);
 const layer=data.stage==='extract'?'L1':data.stage==='profile'?'L3':'L2';
 // Derived stages consume published facts, rather than rereading raw transcripts.
 if(layer==='L3'){const scenes=data.records.filter((r:any)=>r.layer==='L2'),old=data.records.find((r:any)=>r.layer==='L3');return JSON.stringify(scenes.length?[{collectionId:data.collectionId,layer,contentType:'procedure',semanticKey:'persona.operating-doctrine',text:scenes.map((r:any)=>r.text).join('\n'),operation:old?'update':'store',replaces:old?[{recordId:old.recordId,revision:old.revision}]:[],evidence:[...new Map(scenes.flatMap((r:any)=>r.evidence).map((e:any)=>[JSON.stringify(e),e])).values()],support:[],dependencies:scenes.map((r:any)=>({recordId:r.recordId,revision:r.revision})),validUntil:null,certainty:'observed'}]:[]);}
 if(layer==='L2')return JSON.stringify(data.records.filter((r:any)=>r.layer==='L1'&&r.collectionId===data.collectionId).slice(0,8).map((r:any)=>({collectionId:data.collectionId,layer,semanticKey:data.stage==='scene'?'scene.synthetic.'+r.recordId:'session.context',contentType:r.contentType,text:r.text,operation:'store',replaces:[],evidence:r.evidence,support:[],dependencies:[{recordId:r.recordId,revision:r.revision}],validUntil:null,certainty:'observed'})));
 const proposals=data.sources.flatMap((source:any)=>source.events.filter((event:any)=>(event.kind==='user'||source.kind==='task'&&event.kind==='tool')&&event.text).map((event:any)=>{
  const dependencies=layer==='L1'?[]:data.records.filter((record:any)=>record.layer==='L1'&&record.text===event.text).map(({recordId,revision}:any)=>({recordId,revision}));
  return {collectionId:data.collectionId,layer,contentType:event.text.includes('中文')?'preference':'fact',text:event.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],dependencies,validUntil:null,certainty:'user_asserted'};
 })).filter((proposal:any)=>layer==='L1'||proposal.dependencies.length).slice(0,8);
 return JSON.stringify(data.kind==='session'&&data.stage==='extract'?{proposals,summary:data.sources.flatMap((source:any)=>source.events.map((event:any)=>event.text)).join('\n')}:proposals);
}
async function setup(embed=(texts:string[])=>Promise.resolve(texts.map(()=>[1,0])),schedule=false) {
 const home=mkdtempSync(join(tmpdir(),'memory-runtime-')),store=openStore(home),config=(await readConfiguredRuntime(home)).config;
 const generate=vi.fn(generatedMemory);
 const runtime=createMemoryRuntime({verifyOutput:false,schedule,home,store,loadConfig:async()=>structuredClone(config),generate,embed});
 cleanups.push(async()=>{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {home,store,config,runtime,generate};
}
function turn(s:Awaited<ReturnType<typeof setup>>,completed=true){const chat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'请记住：以后用中文回答'});s.store.appendEvent(chat.id,'text',{text:'收到'});s.store.appendEvent(chat.id,'status',{status:'idle'});if(completed)s.store.completeConversation(chat.id,true);return chat;}
test('background capture lets pending requests run between conversations',async()=>{
 const s=await setup();for(let i=0;i<3;i++)turn(s);
 const pendingRequest=new Promise<number>(resolve=>setImmediate(()=>resolve(s.runtime.jobs.list({userId:'local'}).length)));
 await s.runtime.scan();
 expect(await pendingRequest).toBe(1);
 expect(s.runtime.jobs.list({userId:'local'})).toHaveLength(3);
});
test('startup scan captures completed personal conversations once, keeps null scope and creates no Tasks',async()=>{
 const s=await setup(),chat=turn(s);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 expect(s.runtime.memory.listAll({userId:'local'}).some(r=>r.conversationId===chat.id&&r.layer==='L3')).toBe(true);
 expect(s.runtime.memory.collections({userId:'local'})[0]).toMatchObject({projectId:null,agentId:null});expect(s.store.database.prepare('SELECT COUNT(*) AS count FROM work_tasks').get()?.count).toBe(0);
 const count=s.generate.mock.calls.length;await s.runtime.scan();await s.runtime.drain();expect(s.generate).toHaveBeenCalledTimes(count);
 const usage=getUsage(s.store,{period:'today',timeZone:'UTC'});expect(usage.coverage.unknown).toBe(count);expect(usage.recent.every(row=>row.category==='memory'&&typeof row.systemJobId==='string')).toBe(true);expect(new Set(usage.recent.map(row=>row.executionId)).size).toBe(count);
});
test('terminal request capture is durable and immediate, disabled capture performs no work',async()=>{
 const s=await setup();turn(s,false);await s.runtime.initialize();await s.runtime.scan();
 expect(s.runtime.jobs.list({userId:'local'})[0]).toMatchObject({state:'queued'});await s.runtime.drain();expect(s.generate).toHaveBeenCalled();
 s.config.system={cli:'codex',memoryCapture:false};turn(s);await s.runtime.scan();expect(s.runtime.jobs.list({userId:'local'})).toHaveLength(1);
});
test('legacy cutover backs up exact bytes and preserves status scope hash; compatibility correction writes only SQLite',async()=>{
 const s=await setup(),entry={id:'old',kind:'memory',title:'Synthetic old',content:'old text',scope:'global',status:'active',level:'L4',access:{mode:'owner'},createdAt:'2020-01-01',updatedAt:'2020-01-01'};
 const bytes=JSON.stringify([entry]);writeFileSync(join(s.home,'knowledge.json'),bytes);
 await s.runtime.initialize();expect(readFileSync(join(s.home,'memory-migration-backup','knowledge.json'),'utf8')).toBe(bytes);
 const record=s.runtime.memory.listAll({userId:'local'})[0];expect(record).toMatchObject({text:'old text',status:'active',legacyLevel:'L4',legacy:{scope:'global',access:{mode:'owner'}}});
 await updateKnowledge(s.home,'old',{content:'corrected text'},s.config,s.store);
 expect((await readKnowledge(s.home,s.store))[0].content).toBe('corrected text');expect(readFileSync(join(s.home,'knowledge.json'),'utf8')).toBe(bytes);
 await s.runtime.initialize();expect(s.runtime.memory.listAll({userId:'local'})).toHaveLength(1);
});

import { createSessionManager } from '../server/sessions';
import type { CodexOptions, CodexClient } from '../server/codex';
test('native personal memory tools bind current turn/project; reject identity spoofing, stale token, and recalled revision reuse',async()=>{
 const s=await setup();turn(s);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 let token='',options!:CodexOptions,turnNumber=0;const instructions:string[]=[];
 const factory=async(o:CodexOptions):Promise<CodexClient>=>{options=o;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{token=businessCliContext(p.instructions).token;expect(p.mcp).toEqual([]);instructions.push(p.instructions??'');return 'native';},resumeThread:async(_id,mcp,text)=>{token=businessCliContext(text).token;expect(mcp).toEqual([]);instructions.push(text??'');},startTurn:async()=>`turn-${++turnNumber}`,interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);
 cleanups.unshift(async()=>{await manager.close();});
 const chat=await manager.create('','',undefined,'codex');await manager.send(chat.id,'中文');
 const oldToken=token;expect(instructions[0]).toContain('中文');
 const result=await manager.callBoundTool(token,'memory_search',{query:'中文'},'search') as {items:{recordId:string;revision:number}[]};expect(result.items.length).toBeGreaterThan(0);
 await expect(manager.callBoundTool(token,'memory_search',{query:'中文',projectId:'other'},'spoof')).rejects.toThrow();
 const other=s.store.createConversation({projectId:'other',agentId:'',cli:'codex',model:null});s.store.appendEvent(other.id,'user',{text:'请记住：secret other project'});s.store.appendEvent(other.id,'text',{text:'ok'});s.store.appendEvent(other.id,'status',{status:'idle'});s.store.completeConversation(other.id,true);await s.runtime.scan();await s.runtime.drain();const forbidden=s.runtime.memory.listAll({userId:'local'}).find(r=>r.conversationId===other.id)!;
 await expect(manager.callBoundTool(token,'memory_read',{recordId:forbidden.recordId},'cross')).rejects.toThrow();
 options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-1',status:'completed'}}});
 await expect(manager.callBoundTool(oldToken,'memory_search',{query:''},'expired')).rejects.toThrow();
 const used=s.store.listEvents(chat.id,0).find(e=>e.kind==='metadata'&&(e.data as any).memoryUse==='acknowledged');expect(used).toBeDefined();
 const record=result.items.map(item=>s.runtime.memory.read({userId:'local'},item.recordId)).find(r=>r.layer==='L1')!;s.runtime.memory.correct({userId:'local'},{recordId:record.recordId,expectedRevision:record.revision,text:'以后用英文回答'});
 await expect(manager.send(chat.id,'继续')).resolves.toBeUndefined();await vi.waitFor(()=>expect(instructions.at(-1)).toContain('memory_changed'));await vi.waitFor(()=>expect(turnNumber).toBe(2));
 options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-2',status:'completed'}}});
 const next=await manager.create('','',undefined,'codex');await manager.send(next.id,'英文');await vi.waitFor(()=>expect(turnNumber).toBe(3));expect(instructions.at(-1)).toContain('英文');expect(instructions.at(-1)).not.toContain('以后用中文');
});

import { createHttpServer } from '../server/http';
test('human HTTP index exposes global records but rejects privilege fields, duplicate queries, bad revision and hostile origins',async()=>{
 const s=await setup(),chat=turn(s);s.store.renameConversation(chat.id,'中文回答偏好');await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 const manager=createSessionManager(s.store,async()=>s.config,undefined,undefined,s.home,undefined,undefined,s.runtime),server=createHttpServer({requireIdentity:false,home:s.home,store:s.store,manager,memoryRuntime:s.runtime});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 cleanups.unshift(async()=>{await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const browse=await fetch(base+'/api/v2/memory/records');expect(browse.status).toBe(200);
 const index=await browse.json();expect(index.sources).toHaveLength(1);
 expect(index.sources[0]).toMatchObject({conversationId:chat.id,title:'中文回答偏好',excerpt:'请记住：以后用中文回答',kind:'conversation'});
 expect(index.sources[0]).not.toHaveProperty('events');expect(index.sources[0]).not.toHaveProperty('text');
 expect((await (await fetch(base+'/api/v2/memory/records?conversationId=missing')).json()).sources).toEqual([]);
 const job=s.runtime.jobs.list({userId:'local'})[0];
 const result=await fetch(base+'/api/v2/memory/jobs/'+job.id+'/result');expect(result.status).toBe(200);expect((await result.json()).records.length).toBeGreaterThan(0);
 expect((await fetch(base+'/api/v2/memory/jobs/missing/result')).status).toBe(404);
 expect((await fetch(base+'/api/v2/memory/jobs/'+job.id+'/result',{headers:{Origin:'https://evil.test'}})).status).toBe(403);
 const globalSearch=await fetch(base+'/api/v2/memory/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'中文'})});expect(globalSearch.status).toBe(200);expect((await globalSearch.json()).items.length).toBeGreaterThan(0);
 expect((await fetch(base+'/api/v2/memory/records?agentId=other')).status).toBe(422);
 expect((await fetch(base+'/api/v2/memory/records?projectId=a&projectId=b')).status).toBe(422);
 expect((await fetch(base+'/api/v2/memory/records',{headers:{Origin:'https://evil.test'}})).status).toBe(403);
 const r=s.runtime.memory.listAll({userId:'local'}).find(r=>r.layer==='L3')!;
 const endpoint=base+'/api/v2/memory/records/'+r.recordId+'/correct';
 expect((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:r.revision,text:'new',agentId:'other'})})).status).toBe(422);
 expect((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:r.revision,text:'以后用英文'})})).status).toBe(200);
 expect((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:r.revision,text:'stale'})})).status).toBe(409);
});

test('a conversation summary derived from an acknowledged memory cannot resurrect its corrected text',async()=>{
 const s=await setup(),source=turn(s);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 const original=s.runtime.memory.listAll({userId:'local'}).find(r=>r.conversationId===source.id&&r.layer==='L1')!;
 const derived=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 s.store.appendEvent(derived.id,'metadata',{memoryUse:'acknowledged',invocationId:'synthetic-handoff',items:[{recordId:original.recordId,revision:original.revision,reason:'summary'}],query:'language',causality:'not_established'});
 s.store.appendEvent(derived.id,'user',{text:'summarize my convention',invocationId:'synthetic-handoff'});s.store.appendEvent(derived.id,'text',{text:'以后用中文回答'});s.store.appendEvent(derived.id,'status',{status:'idle'});s.store.completeConversation(derived.id,true);
 await s.runtime.scan();await s.runtime.drain();expect(s.runtime.recall.search({userId:'local'},{projectId:null,query:'中文'}).items.some(r=>r.conversationId===derived.id)).toBe(false);
 s.runtime.memory.correct({userId:'local'},{recordId:original.recordId,expectedRevision:original.revision,text:'以后用英文回答'});
 expect(s.runtime.recall.search({userId:'local'},{projectId:null,query:'中文'}).items).toEqual([]);
});

test('completed Task capture is restart recoverable and never changes Task state',async()=>{
 const s=await setup();await s.runtime.initialize();const root={userId:'local'},task=s.runtime.tasks.createTask(root,{goal:'Synthetic complete job',criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null},'task');
 const review=s.runtime.tasks.userCommand(root,task.id,task.revision,'complete');s.runtime.tasks.userCommand(root,task.id,review.revision,'accept');await s.runtime.scan();
 expect(s.runtime.jobs.list(root)).toHaveLength(1);
 const restarted=createMemoryRuntime({verifyOutput:false,schedule:false,home:s.home,store:s.store,loadConfig:async()=>s.config,generate:generatedMemory});await restarted.initialize();await restarted.scan();await restarted.drain();await restarted.close();
 expect(s.runtime.jobs.list(root)[0].state).toBe('completed');expect(s.runtime.memory.listAll(root,{taskId:task.id}).some(r=>r.layer==='L1'&&r.text.includes('completed'))).toBe(true);expect(s.runtime.tasks.getTask(root,task.id).state).toBe('completed');
});
test.each([false,true])('background task capture skips unchanged inputs and renews changed inputs (scheduler=%s)',async(schedule)=>{
 const s=await setup(undefined,schedule),root={userId:'local'},tasks=createTasks(s.store,{assets:s.runtime.memory.options.assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const task=tasks.createTask(root,{goal:'Synthetic stable task',criteria:[],acceptance:'human',projectId:null,assigneeAgentId:'a'},'stable');
 const chat=s.store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),prepared=tasks.prepareStart(root,task.id,task.revision,'start');
 const run=s.store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'dedicated',destinationConversationId:chat.id}));
 const identity={runId:run.id,hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'};
 tasks.bindRunIdentity(identity);tasks.applyRunEvent({...identity,eventKey:'done',outcome:'succeeded',summary:'Synthetic result',artifactVersions:[]});
 const capture=vi.spyOn(s.runtime.memory,'captureTask');
 await s.runtime.scan();expect(capture).toHaveBeenCalledTimes(1);capture.mockClear();
 await s.runtime.scan();await s.runtime.scan();expect(capture).not.toHaveBeenCalled();
 const recaptured=async()=>{await s.runtime.scan();expect(capture).toHaveBeenCalledTimes(1);capture.mockClear();await s.runtime.scan();expect(capture).not.toHaveBeenCalled();};
 tasks.updateTask(root,task.id,tasks.getTask(root,task.id).revision,{goal:'Updated stable task'},'update');await recaptured();
 s.store.database.prepare('UPDATE task_runs SET summary=? WHERE id=?').run('Updated execution result',run.id);await recaptured();
 expect(tasks.listReceipts(root,task.id)).toHaveLength(1);
 s.store.database.prepare('UPDATE task_receipts SET summary=? WHERE task_id=?').run('Updated receipt',task.id);await recaptured();
 s.store.database.prepare('UPDATE context_snapshots SET input=? WHERE run_id=?').run('Updated captured input',run.id);await recaptured();
 s.store.database.prepare('INSERT INTO memory_uses(id,run_id,data) VALUES(?,?,?)').run('synthetic-use',run.id,JSON.stringify({actualUse:'provided_to_native',items:[]}));await recaptured();
 s.store.database.prepare("UPDATE memory_collections SET data=json_set(data,'$.generation',json_extract(data,'$.generation')+1)").run();await recaptured();
 s.config.projects.push({id:'new-scope',name:'New scope',cwd:s.home,agentIds:[],resources:[],mcp:[],skills:[]});await recaptured();
 s.store.appendEvent(chat.id,'metadata',{memoryRecall:'request',status:'completed',count:1});await s.runtime.scan();
 expect(capture).not.toHaveBeenCalled();
 expect(s.store.database.prepare("SELECT payload FROM outbox WHERE type='memory.capture_failed' AND aggregate_id=?").get(task.id)?.payload).toContain('legacy_memory_history_unverified');
});
test('runtime shutdown aborts native generation and retains retry diagnostics',async()=>{
 const s=await setup();turn(s);await s.runtime.initialize();let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let aborted=false;
 const runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home:s.home,store:s.store,loadConfig:async()=>s.config,generate:async(_c,_p,signal)=>{entered();return await new Promise((_r,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));}});
 await runtime.scan();const running=runtime.drain();await started;
 expect(runtime.jobs.list({userId:'local'})[0].state).toBe('running');await runtime.close();await running;expect(aborted).toBe(true);expect(runtime.jobs.list({userId:'local'})[0]).toMatchObject({state:'queued',error:'aborted'});
});

test.each(['extract','conflict'] as const)('closing during %s resumes persisted progress after reopening the store without duplicating facts',async pausedStage=>{
 const home=mkdtempSync(join(tmpdir(),'memory-restart-'));let store=openStore(home);
 const config=(await readConfiguredRuntime(home)).config,root={userId:'local'};
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let calls=0;
 const first='项目使用工具乙。',second='项目使用工具丙。';
 const proposal=(data:any,quote:string)=>({collectionId:data.collectionId,layer:'L1',contentType:'fact',text:quote,operation:'store',replaces:[],evidence:[{sourceId:data.sources[0].id,sourceRevision:data.sources[0].revision}],support:[{sourceId:data.sources[0].id,eventId:data.sources[0].events[0].id,quote}],validUntil:null,certainty:'user_asserted'});
 let runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home,store,loadConfig:async()=>config,generate:async(c,prompt,signal)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage===pausedStage&&++calls===2){entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}
  if(data.stage==='extract')return JSON.stringify(pausedStage==='extract'?[proposal(data,first)]:[proposal(data,first),proposal(data,second)]);
  return generatedMemory(c,prompt);
 }});
 cleanups.push(async()=>{vi.useRealTimers();await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 await runtime.initialize();const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 store.appendEvent(chat.id,'user',{text:pausedStage==='extract'?first+'背景资料。'.repeat(8000)+second:'项目使用工具甲。'+first+second});store.appendEvent(chat.id,'text',{text:'收到'});store.appendEvent(chat.id,'status',{status:'idle'});
 await runtime.scan();const job=runtime.jobs.list(root)[0];
 if(pausedStage==='conflict'){
  const source=runtime.memory.source(root,job.sourceRefs[0].sourceId),quote='项目使用工具甲。';
  runtime.memory.applyProposal(root,proposal({collectionId:job.collectionId,sources:[source]},quote) as any,job.generation,'evidence_extract');
 }
 const draining=runtime.drain();await started;
 const saved=runtime.memory.listAll(root,{status:'active'}).find(r=>r.layer==='L1'&&r.text===first)!;expect(saved).toBeDefined();
 const draft=store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(job.id)?.data;
 if(pausedStage==='conflict')expect(JSON.parse(draft as string).nextAtom).toBe(1);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([runtime.close(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Shutdown waited for unfinished memory')),1000);})]);}finally{clearTimeout(timer);}
 await draining;const paused=runtime.jobs.list(root)[0];expect(paused).toMatchObject({id:job.id,state:'queued',stage:pausedStage,sourceRefs:job.sourceRefs});
 if(pausedStage==='extract')expect(paused.extraction?.nextChunk).toBe(1);
 expect(store.database.prepare('SELECT data FROM memory_extraction_drafts WHERE job_id=?').get(job.id)?.data).toBe(draft);
 store.close();store=openStore(home);const seen:string[]=[];
 runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home,store,loadConfig:async()=>config,generate:async(c,prompt)=>{
  const data=JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
  if(data.stage==='extract'){
   const text=data.sources.map((s:any)=>s.events.map((e:any)=>e.text??'').join('')).join('');seen.push(text);expect(text).not.toContain(first);
   return JSON.stringify(text.includes(second)?[proposal(data,second)]:[]);
  }
  if(data.stage==='conflict'){seen.push(data.atoms[0].text);expect(data.atoms[0].text).not.toBe(first);}
  return generatedMemory(c,prompt);
 }});
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(paused.availableAt)+1);
 try{await runtime.initialize();await runtime.scan();await runtime.drain();}finally{vi.useRealTimers();}
 expect(seen.length).toBeGreaterThan(0);expect(runtime.jobs.list(root).find(j=>j.id===job.id)?.state).toBe('completed');
 const facts=runtime.memory.listAll(root,{status:'active'}).filter(r=>r.layer==='L1');
 expect(facts.filter(r=>r.text===first)).toEqual([expect.objectContaining({recordId:saved.recordId,revision:saved.revision})]);
 expect(facts.filter(r=>r.text===second)).toHaveLength(1);
});

test('durable Task native instruction handoff records exact memory revisions against its real Run',async()=>{
 const s=await setup();s.config.projects=[{id:'p',name:'P',agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}];s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];
 const c=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(c.id,'user',{text:'以后用中文回答'});s.store.appendEvent(c.id,'text',{text:'ok'});s.store.appendEvent(c.id,'status',{status:'idle'});s.store.completeConversation(c.id,true);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 expect(s.runtime.jobs.list({userId:'local'}).every(j=>j.state==='completed'),JSON.stringify(s.runtime.jobs.list({userId:'local'}))).toBe(true);
 let handed='';const factory=async():Promise<CodexClient>=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{handed=p.instructions??'';return 'task-native';},resumeThread:async()=>{},startTurn:async()=> 'task-turn',interrupt:async()=>{},replyApproval(){},close(){}});
 const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 const task=manager.taskService.createTask({userId:'local'},{goal:'Synthetic report',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'handoff');const run=await manager.startDurableTask(task.id,task.revision,'start');
 await vi.waitFor(()=>expect(handed).toContain('以后用中文回答'));
 const uses=s.store.database.prepare('SELECT data FROM memory_uses WHERE run_id=?').all(run.id).map(r=>JSON.parse(r.data as string));expect(uses).toHaveLength(1);expect(uses[0]).toMatchObject({query:'Synthetic report',actualUse:'provided_to_native',causality:'not_established'});expect(uses[0].items.every((i:any)=>typeof i.recordId==='string'&&Number.isSafeInteger(i.revision)&&i.revision>=1)).toBe(true);
});

test('disabled automatic capture also pauses durable queued processing',async()=>{
 const s=await setup();turn(s);await s.runtime.initialize();await s.runtime.scan();s.config.system={cli:'codex',memoryCapture:false};await s.runtime.drain();expect(s.runtime.memory.listAll({userId:'local'})).toEqual([]);expect(s.runtime.jobs.list({userId:'local'})[0].state).toBe('queued');
});

test('failed native preparation retains the exact completed timestamp; only a real successful send reactivates',async()=>{
 const s=await setup();const chat=turn(s),completedAt=s.store.getConversation(chat.id)!.completedAt;
 const manager=createSessionManager(s.store,async()=>s.config,async()=>{throw new Error('synthetic preparation failure');},undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 await expect(manager.send(chat.id,'try to continue')).rejects.toThrow('synthetic preparation failure');
 expect(s.store.getConversation(chat.id)!.completedAt).toBe(completedAt);
});

function nativeFixture() {
 const handlers=new Map<string,CodexOptions>(),tokens=new Map<string,string>();let session=0,turn=0;
 const factory=async(o:CodexOptions):Promise<CodexClient>=>({getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async p=>{const id='native-'+ ++session;handlers.set(id,o);tokens.set(id,p.instructions.includes('Mandala CLI command:')?businessCliContext(p.instructions).token:'');return id;},resumeThread:async(id,_mcp,instructions)=>{handlers.set(id,o);tokens.set(id,instructions?.includes('Mandala CLI command:')?businessCliContext(instructions).token:'');},forkThread:async()=> 'fork-'+ ++session,startTurn:async()=> 'turn-'+ ++turn,interrupt:async()=>{},replyApproval(){},close(){}});
 const finish=(s:Awaited<ReturnType<typeof setup>>,id:string)=>{const c=s.store.getConversation(id)!;handlers.get(c.nativeId!)!.onEvent({method:'turn/completed',params:{threadId:c.nativeId,turn:{id:c.turnId,status:'completed'}}});};
 return {factory,finish,tokens};
}
test('native history accepts evidence-only append but retains on-demand references through fork, edit, and recovery',async()=>{
 const s=await setup(),original=turn(s);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 const f=nativeFixture();let manager=createSessionManager(s.store,async()=>s.config,f.factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 const chat=await manager.create('','',undefined,'codex');await manager.send(chat.id,'first');f.finish(s,chat.id);
 // Another exact explicit assertion only appends evidence; an already delivered revision remains compatible.
 turn(s);await s.runtime.scan();await s.runtime.drain();await expect(manager.send(chat.id,'second')).resolves.toBeUndefined();f.finish(s,chat.id);
 // A fact loaded only on demand must survive a subsequent invocation and clone that drops metadata.
 const factChat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});s.store.appendEvent(factChat.id,'user',{text:'记住：报告编号是 synthetic-blue'});s.store.appendEvent(factChat.id,'text',{text:'ok'});s.store.appendEvent(factChat.id,'status',{status:'idle'});s.store.completeConversation(factChat.id,true);await s.runtime.scan();await s.runtime.drain();
 const fact=s.runtime.memory.listAll({userId:'local'}).find(r=>r.conversationId===factChat.id&&r.layer==='L1')!;
 await manager.send(chat.id,'third');const nativeId=s.store.getConversation(chat.id)!.nativeId!;await manager.callBoundTool(f.tokens.get(nativeId)!,'memory_read',{recordId:fact.recordId},'read');f.finish(s,chat.id);
 const secondUser=s.store.listEvents(chat.id,0).filter(e=>e.kind==='user')[1];const branch=await manager.branch(chat.id,secondUser.id,'branched');f.finish(s,branch.id);
 expect(s.store.listEvents(branch.id,0).some(e=>e.kind==='metadata'&&((e.data as any).items??[]).some((i:any)=>i.recordId===fact.recordId))).toBe(true);
 await manager.edit(chat.id,secondUser.id,'edited');f.finish(s,chat.id);await manager.close();manager=createSessionManager(s.store,async()=>s.config,f.factory,undefined,s.home,undefined,undefined,s.runtime);
 s.runtime.memory.retract({userId:'local'},{recordId:fact.recordId,expectedRevision:fact.revision});
 expect(()=>manager.authorizeConversationRead(chat.id)).not.toThrow();expect(()=>manager.authorizeConversationRead(branch.id)).not.toThrow();
 await expect(manager.send(chat.id,'after recovery')).resolves.toBeUndefined();await expect(manager.send(branch.id,'after branch')).resolves.toBeUndefined();
 expect(s.runtime.memory.listAll({userId:'local'}).some(r=>r.conversationIds?.includes(original.id))).toBe(true);
});
test('legacy native memory traces without fixed revisions block execution and capture, while plain old history remains usable',async()=>{
 const s=await setup();await s.runtime.initialize();const f=nativeFixture(),manager=createSessionManager(s.store,async()=>s.config,f.factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 const old=turn(s);s.store.updateConversation(old.id,{nativeId:'legacy-native'});s.store.appendEvent(old.id,'metadata',{memoryRecall:'old',status:'completed',count:1,entryIds:['old-id'],entries:[{title:'legacy',kind:'memory'}]});
 expect(()=>manager.authorizeConversationRead(old.id)).not.toThrow();await expect(async()=>manager.send(old.id,'resume')).rejects.toThrow('legacy_memory_history_unverified');
 await s.runtime.scan();await s.runtime.drain();expect(s.runtime.memory.listAll({userId:'local'},{conversationId:old.id})).toEqual([]);
 const plain=turn(s);s.store.updateConversation(plain.id,{nativeId:'plain-native'});await expect(manager.send(plain.id,'plain resume')).resolves.toBeUndefined();f.finish(s,plain.id);
});

test('SessionManager close is idempotent and waits for the collected native clients after abort clears state',async()=>{
 const s=await setup();const f=nativeFixture();let release!:()=>void,closedClient=0;
 const manager=createSessionManager(s.store,async()=>s.config,async o=>({...await f.factory(o),close:()=>{closedClient++;return new Promise<void>(r=>release=r);}}),undefined,s.home);
 const chat=await manager.create('','',undefined,'codex');await manager.send(chat.id,'hold');
 let settled=false;const closing=manager.close();Promise.resolve(closing).then(()=>settled=true);await Promise.resolve();expect(settled).toBe(false);expect(manager.close()).toBe(closing);expect(closedClient).toBe(1);release();await closing;expect(settled).toBe(true);
});

test('durable existing-conversation handoff refreshes compatible revisions and preserves earlier use records',async()=>{
 const s=await setup(),root={userId:'local'};s.config.projects=[{id:'p',name:'P',agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}];s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];
 const source=()=>{const c=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(c.id,'user',{text:'以后用中文回答'});s.store.appendEvent(c.id,'text',{text:'ok'});s.store.appendEvent(c.id,'status',{status:'idle'});s.store.completeConversation(c.id,true);return c;};
 const seed=source();await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();const record=s.runtime.memory.listAll(root).find(r=>r.layer==='L1')!;const deliveredRevision=record.revision;
 let o!:CodexOptions,turn=0;const factory=async(options:CodexOptions):Promise<CodexClient>=>{o=options;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'native-retry',resumeThread:async()=>{},startTurn:async()=> 'turn-'+ ++turn,interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 const task=manager.taskService.createTask(root,{goal:'中文 Synthetic retry',criteria:[],acceptance:'human',projectId:'p',assigneeAgentId:'a'},'retry');const first=await manager.startDurableTask(task.id,task.revision,'start');
 await vi.waitFor(()=>expect(manager.taskService.getRun(root,first.id).state).toBe('running'));
 const used=JSON.parse(s.store.database.prepare('SELECT data FROM memory_uses WHERE run_id=?').get(first.id)!.data as string);expect(used.items).toContainEqual(expect.objectContaining({recordId:record.recordId,revision:deliveredRevision}));
 o.onEvent({method:'turn/completed',params:{threadId:'native-retry',turn:{id:'turn-1',status:'completed'}}});
 source();await s.runtime.scan();await s.runtime.drain();expect(s.runtime.memory.read(root,record.recordId)).toMatchObject({revision:deliveredRevision+1,revisionKind:'evidence_append'});
 s.runtime.memory.validateReferences({...root,agentId:'a'},{projectId:'p',items:[{recordId:record.recordId,revision:deliveredRevision}]});
 const handoff=vi.spyOn(s.runtime.recall,'recordUse');const requester=await manager.create('p','a');const delegated=await manager.createTask(requester.id,'a','Synthetic follow-up',first.routing!.executionConversationId,{policy:'notify',commandKey:'follow-up'});const retry=manager.taskService.listRuns(root,delegated.id).at(-1)!;
 expect(retry.routing?.executionConversationId).toBe(first.routing?.executionConversationId);
 await vi.waitFor(()=>expect(manager.taskService.getRun(root,retry.id).state,JSON.stringify({handoffs:handoff.mock.calls,errors:s.store.listEvents(first.routing!.executionConversationId,0).filter(e=>e.kind==='error')})).toBe('running'));
 const inherited=JSON.parse(s.store.database.prepare('SELECT data FROM memory_uses WHERE run_id=?').get(retry.id)!.data as string);expect(inherited.items).toContainEqual(expect.objectContaining({recordId:record.recordId,revision:deliveredRevision+1}));expect(used.items).toContainEqual(expect.objectContaining({recordId:record.recordId,revision:deliveredRevision}));
});


test('startup captures finished error and interrupted rounds with bounded diagnostics',async()=>{
 const s=await setup();const chats=['error','interrupted'].map(status=>{const c=turn(s,false);s.store.appendEvent(c.id,'status',{status});s.store.updateConversation(c.id,{status:status as 'error'|'interrupted'});return c;});
 const legacy=turn(s);s.store.appendEvent(legacy.id,'metadata',{memoryRecall:'old',status:'completed',count:1,entryIds:['missing']});
 await s.runtime.initialize();await s.runtime.scan();await s.runtime.scan();await s.runtime.scan();
 expect(s.runtime.jobs.list({userId:'local'})).toHaveLength(2);
 expect(s.store.listEvents(legacy.id,0).filter(e=>(e.data as any).memoryCapture==='failed')).toHaveLength(1);
 expect(chats.map(c=>s.store.getConversation(c.id)!.status)).toEqual(['error','interrupted']);
});
test('after both cutovers malformed legacy JSON cannot override authoritative SQLite memory',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-cutover-')),entry={id:'canonical-old',kind:'memory',title:'Synthetic',content:'durable canonical',scope:'global',status:'active',level:'L2',createdAt:'2020-01-01',updatedAt:'2020-01-01'};
 writeFileSync(join(home,'knowledge.json'),JSON.stringify([entry]));await migrateWorkspace(home,'apply');const store=openStore(home),config=(await readConfiguredRuntime(home)).config,runtime=createMemoryRuntime({verifyOutput:false,schedule:false,home,store,loadConfig:async()=>config,generate:generatedMemory});cleanups.push(async()=>{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});await runtime.initialize();writeFileSync(join(home,'knowledge.json'),'{malformed');
 await runtime.initialize();expect((await readKnowledge(home,store)).find(e=>e.id==='canonical-old')?.content).toBe('durable canonical');
});
test('same Agent native tools cannot read another project even through an explicit record ID',async()=>{
 const s=await setup();s.config.projects=['p','q'].map(id=>({id,name:id,agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}));s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];
 const c=s.store.createConversation({projectId:'q',agentId:'a',cli:'codex',model:null});s.store.appendEvent(c.id,'user',{text:'请记住：报告编号是 synthetic-q-secret'});s.store.appendEvent(c.id,'text',{text:'ok'});s.store.appendEvent(c.id,'status',{status:'idle'});s.store.completeConversation(c.id,true);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();const record=s.runtime.memory.listAll({userId:'local'}).find(r=>r.conversationId===c.id)!;
 const f=nativeFixture(),manager=createSessionManager(s.store,async()=>s.config,f.factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());const chat=await manager.create('p','a');await manager.send(chat.id,'search');const token=f.tokens.get(s.store.getConversation(chat.id)!.nativeId!)!;
 expect((await manager.callBoundTool(token,'memory_search',{query:'synthetic-q-secret'},'search') as any).items).toEqual([]);await expect(manager.callBoundTool(token,'memory_read',{recordId:record.recordId},'read')).rejects.toThrow();await manager.stop(chat.id);await expect(manager.callBoundTool(token,'memory_search',{query:''},'stopped')).rejects.toThrow();
});

test.each(['rejected','timeout','observed'] as const)('completed timestamp follows native acceptance when startTurn is %s',async mode=>{
 const s=await setup(),chat=turn(s),completedAt=s.store.getConversation(chat.id)!.completedAt;
 let options!:CodexOptions;
 const f=nativeFixture();const factory=async(o:CodexOptions)=>{options=o;const client=await f.factory(o);return {...client,startTurn:async()=>{if(mode==='observed')options.onEvent({method:'turn/started',params:{threadId:s.store.getConversation(chat.id)!.nativeId,turn:{id:'observed-turn'}}});const error=new Error('synthetic rejection');if(mode==='timeout')error.name='RpcTimeoutError';throw error;}};};
 const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 await expect(manager.send(chat.id,'attempt')).rejects.toThrow('synthetic rejection');
 expect(s.store.getConversation(chat.id)!.completedAt).toBe(mode==='rejected'?completedAt:null);
});
test.each(['send','status','models'] as const)('close waits for pending native initialization and late client cleanup: %s',async operation=>{
 const s=await setup();let entered!:()=>void,provide!:(c:CodexClient)=>void,release!:()=>void,cleanupEntered!:()=>void;
 const started=new Promise<void>(r=>entered=r),pending=new Promise<CodexClient>(r=>provide=r),cleanup=new Promise<void>(r=>release=r),cleaning=new Promise<void>(r=>cleanupEntered=r);
 const manager=createSessionManager(s.store,async()=>s.config,async()=>{entered();return pending;},undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
 const chat=await manager.create('','',undefined,'codex'),sending=(operation==='send'?manager.send(chat.id,'pending'):operation==='status'?manager.getCliStatus():manager.listModels()).catch(e=>e.message);await started;
 let closed=false;const closing=manager.close();void closing.then(()=>closed=true);await Promise.resolve();const returnedBeforeFactory=closed;
 let cleanupDone=false;const f=nativeFixture(),client=await f.factory({} as CodexOptions);provide({...client,close:async()=>{cleanupEntered();await cleanup;cleanupDone=true;}});await cleaning;await Promise.resolve();const returnedBeforeCleanup=closed;release();await closing;await sending;
 expect(returnedBeforeFactory).toBe(false);expect(returnedBeforeCleanup).toBe(false);expect(cleanupDone).toBe(true);expect(manager.close()).toBe(closing);
});
test('a reused native client clears completion on a terminal turn before the start response',async()=>{
 const s=await setup(),f=nativeFixture();let options!:CodexOptions,count=0;
 const factory=async(o:CodexOptions)=>{options=o;const client=await f.factory(o);return {...client,startTurn:async(id:string)=>{const turnId='fast-'+ ++count;if(count>1){options.onEvent({method:'turn/started',params:{threadId:id,turn:{id:turnId}}});options.onEvent({method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'completed'}}});}return turnId;}};};
 const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());const chat=await manager.create('','',undefined,'codex');await manager.send(chat.id,'first');f.finish(s,chat.id);s.store.completeConversation(chat.id,true);
 await manager.send(chat.id,'second');expect(s.store.getConversation(chat.id)).toMatchObject({completedAt:null,status:'idle'});
});


test.each((['new','recovered','reused'] as const).flatMap(mode=>(['withdraw','correct','acl'] as const).map(change=>({mode,change}))))('selected memory is fenced after delayed $mode Codex preparation: $change',async({mode,change})=>{
  const s=await setup();s.config.projects=[{id:'p',name:'P',agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}];s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];await s.runtime.initialize();
  let entered!:()=>void,release!:()=>void,block=mode!=='reused';const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),handoffs:string[]=[];let options!:CodexOptions;
  const pause=async()=>{entered();await gate;};
  const factory=async(o:CodexOptions):Promise<CodexClient>=>{options=o;if(block)await pause();return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],setSkillRoots:async()=>{if(block)await pause();},startThread:async value=>{handoffs.push(value.instructions??'');return 'fenced-native';},resumeThread:async(_id,_mcp,instructions)=>{handoffs.push(instructions??'');},startTurn:async()=> 'fenced-turn',interrupt:async()=>{},replyApproval(){},close(){}};};
  const manager=createSessionManager(s.store,async()=>s.config,factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());
  const chat=await manager.create('p','a',undefined,'codex');
  if(mode==='reused'){await manager.send(chat.id,'first without memory');options.onEvent({method:'turn/completed',params:{threadId:'fenced-native',turn:{id:'fenced-turn',status:'completed'}}});handoffs.length=0;const skill=join(s.home,'skill');mkdirSync(skill);writeFileSync(join(skill,'SKILL.md'),'Synthetic skill');s.config.agents[0].skills=[{name:'synthetic',path:skill}];block=true;}
  if(mode==='recovered')s.store.updateConversation(chat.id,{nativeId:'existing-native'});
  const source=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(source.id,'user',{text:'以后采用 synthetic-fenced-convention'});s.store.appendEvent(source.id,'status',{status:'idle'});s.store.completeConversation(source.id,true);await s.runtime.scan();await s.runtime.drain();
  const record=s.runtime.memory.listAll({userId:'local'}).find(r=>r.conversationId===source.id&&r.layer==='L2')!;
  const sending=manager.send(chat.id,'Use convention').then(()=>null,error=>error);await started;
  if(change==='withdraw')s.runtime.memory.retract({userId:'local'},{recordId:record.recordId,expectedRevision:record.revision});
  else if(change==='correct')s.runtime.memory.correct({userId:'local'},{recordId:record.recordId,expectedRevision:record.revision,text:'以后采用 corrected-convention'});
  else {const asset=s.runtime.memory.options.assets.getAuthorizedAsset({userId:'local'},record.collectionId);s.runtime.memory.options.assets.setAccess({userId:'local'},asset.id,{mode:'private'},asset.revision);}
  release();expect(await sending).toBeInstanceOf(Error);expect(handoffs).toEqual([]);expect(s.store.listEvents(chat.id,0).filter(e=>e.kind==='metadata'&&(e.data as any).memoryUse==='acknowledged')).toEqual([]);
  await manager.close();
});


test.each(['withdraw','correct','acl'] as const)('OMP delayed factory validates exact selected revisions before consuming its instruction file: %s',async change=>{
 const s=await setup();s.config.projects=[{id:'p',name:'P',agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}];s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'omp',models:{},mcp:[],skills:[]}];
 const source=s.store.createConversation({projectId:'p',agentId:'a',cli:'omp',model:null});s.store.appendEvent(source.id,'user',{text:'以后采用 synthetic-omp-convention'});s.store.appendEvent(source.id,'status',{status:'idle'});s.store.completeConversation(source.id,true);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 const record=s.runtime.memory.listAll({userId:'local'}).find(r=>r.layer==='L3')!;let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),consumed:string[]=[];
 const factory=async(options:import('../server/omp').OmpOptions):Promise<CodexClient>=>{entered();await gate;await options.validateHandoff?.();consumed.push(readFileSync(options.instructions!,'utf8'));return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'omp-native',resumeThread:async()=>{},startTurn:async()=> 'omp-turn',interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(s.store,async()=>s.config,undefined,factory,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());const chat=await manager.create('p','a',undefined,'omp'),sending=manager.send(chat.id,'convention').then(()=>null,error=>error);await started;
 if(change==='withdraw')s.runtime.memory.retract({userId:'local'},{recordId:record.recordId,expectedRevision:record.revision});
 else if(change==='correct')s.runtime.memory.correct({userId:'local'},{recordId:record.recordId,expectedRevision:record.revision,text:'以后采用 corrected-omp'});
 else {const asset=s.runtime.memory.options.assets.getAuthorizedAsset({userId:'local'},record.collectionId);s.runtime.memory.options.assets.setAccess({userId:'local'},asset.id,{mode:'private'},asset.revision);}
 release();expect(await sending).toBeInstanceOf(Error);expect(consumed).toEqual([]);expect(s.store.listEvents(chat.id,0).filter(e=>e.kind==='metadata'&&(e.data as any).memoryUse==='acknowledged')).toEqual([]);
});

// No real model or native generation: exercise current reading policy at both handoff boundaries.
test.each(['combined','native-preparation','stopped-reading'] as const)('request reading fenced during $0 cannot inject selected facts',async mode=>{
 let queryCount=0,s!:Awaited<ReturnType<typeof setup>>;
 s=await setup(async texts=>{if(texts.some(t=>t.startsWith('task:'))&&++queryCount===2&&mode==='combined')s.config.system!.memory!.request!.read=false;return texts.map(()=>[1,0]);});
 s.config.system={cli:'codex',memory:{request:{generate:false,read:true},session:{generate:false,read:false},idleHours:6}};await s.runtime.initialize();
 const root={userId:'local'},collection=s.runtime.memory.ensureCollection(root,{projectId:null,agentId:null}),source=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),text='Synthetic current request uses pnpm.';
 const event=s.store.appendEvent(source.id,'user',{text});s.store.appendEvent(source.id,'status',{status:'idle'});
 const captured=s.runtime.memory.captureConversation(root,{collectionId:collection.id,conversationId:source.id,trigger:'explicit',kind:'request'}).sources[0];
 const common={collectionId:collection.id,contentType:'fact' as const,text,operation:'store' as const,replaces:[],evidence:[{sourceId:captured.id,sourceRevision:captured.revision}],support:[{sourceId:captured.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted' as const,pipeline:'request' as const};
 const fact=s.runtime.memory.applyProposal(root,{...common,layer:'L1'},collection.generation,'evidence_extract')!;
 s.runtime.memory.applyProposal(root,{...common,layer:'L2',semanticKey:'scene.synthetic',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},collection.generation,'layer_summary');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),handoffs:string[]=[];
 const reading=s.runtime.reading;let readingCount=0;if(mode==='stopped-reading')vi.spyOn(s.runtime,'reading').mockImplementation(async p=>{if(++readingCount===3){entered();await gate;}return reading(p);});
 const factory=async():Promise<CodexClient>=>{if(mode==='native-preparation'){entered();await gate;}return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async value=>{handoffs.push(value.instructions??'');return 'policy-native';},resumeThread:async()=>{},startTurn:async()=> 'policy-turn',interrupt:async()=>{},replyApproval(){},close(){}};};
 const manager=createSessionManager(s.store,async()=>structuredClone(s.config),factory,undefined,s.home,undefined,undefined,s.runtime);cleanups.unshift(async()=>manager.close());const chat=await manager.create('','',undefined,'codex');
 const sending=manager.send(chat.id,'pnpm').then(()=>null,error=>error);
 if(mode==='native-preparation'){await started;s.config.system.memory!.request!.read=false;release();expect(await sending).toBeInstanceOf(Error);expect(handoffs).toEqual([]);}
 else if(mode==='stopped-reading'){await started;const stopping=manager.stop(chat.id);release();await stopping;await sending;expect(handoffs).toEqual([]);}
 else {expect(await sending).toBeNull();expect(handoffs).toHaveLength(1);expect(handoffs[0]).not.toContain(text);expect(queryCount).toBe(2);}
 expect(s.generate).not.toHaveBeenCalled();expect(s.store.listEvents(chat.id,0).filter(e=>e.kind==='metadata'&&(e.data as any).memoryUse==='acknowledged')).toEqual([]);
});

test('generation switches exclude disabled turns durably and retired organization cannot recover history',async()=>{
 const s=await setup();await s.runtime.getSettings();
 s.config.system={...s.config.system,cli:s.config.system?.cli??'codex',memory:{request:{generate:false,read:true},session:{generate:true,read:true},idleHours:0}};
 await s.runtime.getSettings();const disabled=turn(s);await s.runtime.scan();
 expect(s.runtime.jobs.list({userId:'local'}).filter(j=>j.kind==='session')).toHaveLength(0);
 expect(s.runtime.jobs.list({userId:'local'}).filter(j=>j.kind==='request')).toHaveLength(0);
 s.config.system!.memory!.request!.generate=true;await s.runtime.getSettings();await s.runtime.scan();
 expect(s.runtime.jobs.list({userId:'local'}).filter(j=>j.kind==='request')).toHaveLength(0);
 await s.runtime.close();
 const restarted=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>s.config,schedule:false,verifyOutput:false,generate:generatedMemory});
 cleanups.unshift(()=>restarted.close());await restarted.scan();
 expect(restarted.jobs.list({userId:'local'}).filter(j=>j.kind==='request')).toHaveLength(0);
 const future=turn(s);await restarted.scan();expect(restarted.jobs.list({userId:'local'}).some(j=>j.kind==='request'&&j.conversationId===future.id)).toBe(true);
 s.config.system!.memory!.session!.generate=false;await restarted.getSettings();const historical=turn(s);await restarted.scan();s.config.system!.memory!.session!.generate=true;await restarted.getSettings();await restarted.scan();
 expect(restarted.jobs.list({userId:'local'}).some(j=>j.kind==='session'&&j.conversationId===historical.id)).toBe(false);
 await expect(restarted.organize(historical.id)).rejects.toMatchObject({code:'conversation_summary_retired'});
 expect(s.store.getConversation(disabled.id)).toBeDefined();
});

test('automatic capture excludes an entire turn crossing a disabled boundary and resumes pre-disable queued jobs',async()=>{
 const s=await setup();s.config.runtimes=['codex','omp'];s.config.system={...s.config.system,cli:'codex',tasks:{memory:{cli:'codex'}}};await s.runtime.getSettings();const queued=turn(s);await s.runtime.scan();
 const chat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'private disabled context'});
 s.config.system={...s.config.system,cli:s.config.system?.cli??'codex',memory:{request:{generate:false,read:true},session:{generate:false,read:true},idleHours:0}};await s.runtime.getSettings();
 s.store.appendEvent(chat.id,'text',{text:'disabled answer'});await s.runtime.drain();expect(s.generate).not.toHaveBeenCalled();
 s.config.system!.memory!.request!.generate=true;await s.runtime.getSettings();s.store.appendEvent(chat.id,'status',{status:'idle'});await s.runtime.scan();
 expect(s.runtime.jobs.list({userId:'local'}).some(j=>j.conversationId===chat.id)).toBe(false);
 await s.runtime.drain();expect(s.runtime.jobs.list({userId:'local'}).filter(j=>j.conversationId===queued.id).map(j=>({state:j.state,error:j.error}))).toEqual([{state:'completed',error:null}]);
 s.store.appendEvent(chat.id,'user',{text:'future safe turn'});s.store.appendEvent(chat.id,'status',{status:'idle'});await s.runtime.scan();
 const c=s.runtime.memory.collections({userId:'local'}).find(c=>c.projectId===null)!;
 const captured=s.runtime.memory.captureConversation({userId:'local'},{collectionId:c.id,conversationId:chat.id,trigger:'completed',kind:'request'});
 expect(captured.sources.map(source=>source.text).join('\n')).not.toContain('disabled answer');
});

test('initially disabled generation preserves its exclusion boundary across a restart',async()=>{
 const s=await setup();s.config.system={cli:'codex',...s.config.system,memoryCapture:false};await s.runtime.getSettings();const old=turn(s);await s.runtime.close();
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>s.config,schedule:false,generate:generatedMemory});cleanups.unshift(()=>runtime.close());
 s.config.system!.memoryCapture=true;await runtime.scan();expect(runtime.jobs.list({userId:'local'})).toEqual([]);
 await expect(runtime.organize(old.id)).rejects.toMatchObject({code:'conversation_summary_retired'});
});

test('retired organization cannot replace or reprioritize queued deep-memory work',async()=>{
 const s=await setup(),automatic=turn(s);await s.runtime.scan();const before=s.runtime.jobs.list({userId:'local'});
 await expect(s.runtime.organize(automatic.id)).rejects.toMatchObject({code:'conversation_summary_retired',status:410});
 expect(s.runtime.jobs.list({userId:'local'})).toEqual(before);
});

test('disabled task revisions are not automatically backfilled after enable',async()=>{
 const s=await setup(),root={userId:'local'};await s.runtime.getSettings();s.config.system={...s.config.system,cli:'codex',memoryCapture:false};await s.runtime.getSettings();
 const task=s.runtime.tasks.createTask(root,{goal:'Task created during disabled generation',criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null},'disabled-task');
 const review=s.runtime.tasks.userCommand(root,task.id,task.revision,'complete');s.runtime.tasks.userCommand(root,task.id,review.revision,'accept');
 s.config.system.memoryCapture=true;await s.runtime.scan();expect(s.runtime.jobs.list(root)).toHaveLength(0);
 const future=s.runtime.tasks.createTask(root,{goal:'Future task',criteria:[],acceptance:'delivery',projectId:null,assigneeAgentId:null},'future-task');const next=s.runtime.tasks.userCommand(root,future.id,future.revision,'complete');s.runtime.tasks.userCommand(root,future.id,next.revision,'accept');await s.runtime.scan();
 expect(s.runtime.jobs.list(root)).toHaveLength(1);
});

test('real config saves persist toggle boundaries even without an intervening scan and across restart',async()=>{
 const s=await setup();await s.runtime.close();
 const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>(await readConfiguredRuntime(s.home)).config,schedule:false,generate:generatedMemory});
 const manager=createSessionManager(s.store,async()=>(await readConfiguredRuntime(s.home)).config,undefined,undefined,s.home,undefined,undefined,runtime),server=createHttpServer({requireIdentity:false,home:s.home,store:s.store,manager,memoryRuntime:runtime});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 cleanups.unshift(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await manager.close();await runtime.close();});
 const save=async(generate:boolean)=>{const value=await readConfiguredRuntime(s.home);const response=await fetch(base+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:value.revision,config:{...value.config,system:{cli:'codex',memory:{request:{generate,read:true},session:{generate:false,read:true},idleHours:6}}}})});expect(response.status).toBe(200);};
 await save(false);const disabled=turn(s);await save(true);await runtime.close();
 const restarted=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>(await readConfiguredRuntime(s.home)).config,schedule:false,generate:generatedMemory});cleanups.unshift(()=>restarted.close());await restarted.scan();expect(restarted.jobs.list({userId:'local'})).toHaveLength(0);
 const future=turn(s);await restarted.scan();expect(restarted.jobs.list({userId:'local'}).map(job=>job.conversationId)).toEqual([future.id]);
 expect(s.store.getConversation(disabled.id)).toBeDefined();
});

test.each(['zh-CN','en'] as const)('runtime forwards the saved %s output preference through generation stages',async language=>{
 const s=await setup();s.config.system={cli:'codex',memory:{language}};
 turn(s);await s.runtime.initialize();await s.runtime.scan();await s.runtime.drain();
 expect(s.generate).toHaveBeenCalled();
 for(const call of s.generate.mock.calls)expect(call[1]).toContain(language==='en'?'Output language: English':'Output language: Simplified Chinese');
});

test.each([false,true])('startup queues a private profile unless generation is disabled while yielding (%s)',async disable=>{
 const s=await setup(),root={userId:'local'};
 s.config.projects=[{id:'p',name:'P',agentIds:['a'],cwd:s.home,resources:[],mcp:[],skills:[]}];s.config.agents=[{id:'a',name:'A',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}];await s.runtime.initialize();await s.runtime.getSettings();
 const c=s.runtime.memory.ensureCollection(root,{projectId:'p',agentId:'a'}),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),text='My personal experience: compare local delivery samples first.',e=s.store.appendEvent(chat.id,'user',{text});
 s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.runtime.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const atom={collectionId:c.id,scope:'agent' as const,layer:'L1' as const,contentType:'procedure' as const,text,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:e.id,quote:text}],validUntil:null,certainty:'user_asserted' as const};
 const fact=s.runtime.memory.applyProposal(root,atom,c.generation,'evidence_extract')!;
 s.runtime.memory.applyProposal(root,{...atom,layer:'L2',semanticKey:'scene.private',support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary');
 s.store.updateConversation(chat.id,{status:'running'});s.store.database.prepare('DELETE FROM memory_jobs').run();
 await s.runtime.initialize();
 const transition=disable?new Promise<void>(resolve=>setImmediate(()=>{s.config.system={cli:'codex',memoryCapture:false};s.runtime.settingsChanged(s.config);resolve();})):Promise.resolve();
 await s.runtime.scan();await transition;
 expect(s.runtime.jobs.list(root)).toEqual(disable?[]:[expect.objectContaining({stage:'profile',state:'queued',profileScope:{projectId:null,agentId:'a'}})]);
});
