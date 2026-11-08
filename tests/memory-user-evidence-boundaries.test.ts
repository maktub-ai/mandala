import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import type {MemoryProposal,MemoryRevision,MemorySource} from '../shared/memory';
import {DomainError} from '../shared/workspace-contracts';
const root={userId:'local'},reader={...root,agentId:'b'},cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-user-bounds-')),store=openStore(home),assets=createAssets(store,createAssetFiles(home));
 const tasks=createTasks(store,{assets,resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeProject:(p,id)=>{if(id!=='p'||p.agentId&&!['a','b'].includes(p.agentId))throw new DomainError('forbidden',403,'Project unavailable');}}),collection=memory.ensureCollection(root,{projectId:'p',agentId:null});
 cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const extract=(source:MemorySource,text:string,eventId=source.events.find(e=>e.kind==='user')!.id,support?:MemoryProposal['support'])=>memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:support??[{sourceId:source.id,eventId,quote:text}],validUntil:null,certainty:'user_asserted'},collection.generation,'evidence_extract')!;
 const task=tasks.createTask(root,{goal:'A private Task',projectId:'p',assigneeAgentId:'a'},'private-task');tasks.startTask(root,task.id,task.revision,'private-run');
 const privateSource=memory.captureTask(root,{collectionId:collection.id,taskId:task.id,trigger:'stable',kind:'request'}).sources[0];
 const hidden=extract(privateSource,privateSource.events[0].text,privateSource.events[0].id);
 const source=(agentId:string,text:string,refs:MemoryRevision[]=[],role:'human'|'agent'|'task'|'tool'='human')=>{
  const chat=store.createConversation({projectId:'p',agentId,cli:'codex',model:null}),invocationId=crypto.randomUUID();
  const user=store.appendEvent(chat.id,'user',{text,invocationId,...role==='agent'?{agentMessage:{id:'platform-reply',direction:'reply'}}:role==='task'?{task:{id:'platform-task'}}:{}});
  if(refs.length)store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',invocationId,items:refs.map(r=>({recordId:r.recordId,revision:r.revision}))});
  let tool:number|undefined;
  if(role==='tool')tool=store.appendEvent(chat.id,'tool',{method:'item/completed',params:{item:{id:'inspect',type:'commandExecution',command:'cat /tmp/config.json',cwd:'/tmp',status:'completed',exitCode:0,aggregatedOutput:'config.json:1: feature=enabled'}}}).id;
  const answer=store.appendEvent(chat.id,'text',{text:'Assistant output'});store.appendEvent(chat.id,'status',{status:'idle'});
  return {chat,user,answer,tool,source:memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0]};
 };
 return {home,store,assets,tasks,memory,collection,source,extract,hidden,privateSource};
}

test('verified identical user fact append preserves a prior shared summary despite unrelated private inherited memory',()=>{
 const s=setup(),first=s.source('b','The package manager is bun.'),fact=s.extract(first.source,(first.user.data as {text:string}).text);
 const summary=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L2',contentType:'fact',text:'Use bun for package work.',operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},s.collection.generation,'layer_summary')!;
 expect(s.memory.read(reader,summary.recordId,'p').status).toBe('active');
 const next=s.source('a','The package manager is bun.',[s.hidden]),appended=s.extract(next.source,(next.user.data as {text:string}).text);
 expect(appended).toMatchObject({recordId:fact.recordId,revision:2,revisionKind:'evidence_append'});
 expect(s.memory.history(reader,{projectId:'p',items:[{recordId:summary.recordId,revision:summary.revision}]}).items).toEqual([{recordId:summary.recordId,revision:summary.revision}]);
 expect(()=>s.memory.read(reader,s.hidden.recordId,'p')).toThrow('forbidden');
 expect(()=>s.tasks.getTask(reader,s.privateSource.taskId!)).toThrow('forbidden');
});

test('existing immutable extracted evidence gets a read projection without rewriting stored provenance',()=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden]),record=s.extract(captured.source,(captured.user.data as {text:string}).text),before=s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(record.recordId)!.data;
 expect(s.memory.read(reader,record.recordId,'p').text).toBe('The formatter is biome.');
 expect(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(record.recordId)!.data).toBe(before);
 expect(s.memory.read(root,record.recordId,'p').evidence).toEqual([{sourceId:captured.source.id,sourceRevision:captured.source.revision}]);
});

test.each(['collection','source','event'] as const)('verified user bounds retain live %s revocation checks',change=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden]),record=s.extract(captured.source,(captured.user.data as {text:string}).text);
 expect(s.memory.read(reader,record.recordId,'p').status).toBe('active');
 if(change==='collection'){const asset=s.assets.getAuthorizedAsset(root,s.collection.id);s.assets.setAccess(root,asset.id,{mode:'private'},asset.revision);}
 else if(change==='source')s.memory.retractSource(root,{sourceId:captured.source.id,expectedRevision:captured.source.revision});
 else s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'The old quotation was changed'}),captured.user.id);
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow();
});

test('mixed user and tool support keeps inherited authority checks',()=>{
 const s=setup(),captured=s.source('a','The feature is enabled.',[s.hidden],'tool'),record=s.extract(captured.source,'The feature is enabled.',captured.user.id,[{sourceId:captured.source.id,eventId:captured.user.id,quote:'The feature is enabled.'},{sourceId:captured.source.id,eventId:captured.tool!,quote:'config.json:1: feature=enabled'}]);
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
});

test.each(['agent','task','assistant','fabricated'] as const)('a %s support cannot manufacture a human-only authority projection',kind=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden],kind==='agent'||kind==='task'?kind:'human'),record=s.extract(captured.source,(captured.user.data as {text:string}).text);
 if(kind!=='agent'&&kind!=='task'){
  const support=[{sourceId:captured.source.id,eventId:kind==='assistant'?captured.answer.id:captured.user.id,quote:kind==='assistant'?'Assistant output':'A fabricated quotation'}];
  s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...record,support}),record.recordId);
 }
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
});


test('a summary retains inherited context authority even when it also quotes a genuine user statement',()=>{
 const s=setup(),publicSource=s.source('b','The package manager is bun.'),fact=s.extract(publicSource.source,(publicSource.user.data as {text:string}).text),privateContext=s.source('a','The package manager is bun.',[s.hidden]);
 const summary=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L2',contentType:'fact',text:'The package setup was reviewed.',operation:'store',replaces:[],evidence:[{sourceId:privateContext.source.id,sourceRevision:privateContext.source.revision}],support:[{sourceId:privateContext.source.id,eventId:privateContext.user.id,quote:'The package manager is bun.'}],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},s.collection.generation,'layer_summary')!;
 expect(()=>s.memory.read(reader,summary.recordId,'p')).toThrow('forbidden');
});

test('a genuine user quote cannot bypass a direct private Task Run in its source',()=>{
 const s=setup(),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 s.store.inheritConversationTaskRuns(chat.id,s.privateSource.runIds);
 const event=s.store.appendEvent(chat.id,'user',{text:'The formatter is biome.',invocationId:crypto.randomUUID()});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],record=s.extract(source,'The formatter is biome.',event.id);
 expect(source.runIds).toEqual(s.privateSource.runIds);expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
});

test('inherited native history honors verified user bounds transitively after evidence append',()=>{
 const s=setup(),first=s.source('b','The package manager is bun.'),fact=s.extract(first.source,(first.user.data as {text:string}).text);
 const handoff=s.source('b','We confirmed the release inputs.',[fact]),answer=s.extract(handoff.source,(handoff.user.data as {text:string}).text);
 const summary=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L2',contentType:'fact',text:'Release inputs use the agreed package manager.',operation:'store',replaces:[],evidence:answer.evidence,support:[],dependencies:[{recordId:answer.recordId,revision:answer.revision}],validUntil:null,certainty:'observed'},s.collection.generation,'layer_summary')!;
 expect(s.memory.read(reader,summary.recordId,'p').status).toBe('active');
 const next=s.source('a','The package manager is bun.',[s.hidden]);s.extract(next.source,(next.user.data as {text:string}).text);
 expect(s.memory.history(reader,{projectId:'p',items:[{recordId:summary.recordId,revision:summary.revision}]}).items).toEqual([{recordId:summary.recordId,revision:summary.revision}]);
 expect(()=>s.memory.read(reader,s.hidden.recordId,'p')).toThrow('forbidden');
});

test.each(['Shared deployment hint: OMEGA_INTERNAL_712.','The formatter is biome. Internal deployment identifier: OMEGA_INTERNAL_712.','The project uses Biome for formatting.'])('a genuine unrelated or partial user quote cannot declassify stored text: %s',text=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden]);
 const record=s.extract(captured.source,text,captured.user.id,[{sourceId:captured.source.id,eventId:captured.user.id,quote:'The formatter is biome.'}]);
 expect(s.memory.read(root,record.recordId,'p').text).toBe(text);
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
 expect(()=>s.memory.read(reader,s.hidden.recordId,'p')).toThrow('forbidden');
});

test('transitive native history cannot declassify private derived text using an unrelated human quote',()=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden]),privateText='Shared deployment hint: OMEGA_INTERNAL_712.';
 const derived=s.extract(captured.source,privateText,captured.user.id,[{sourceId:captured.source.id,eventId:captured.user.id,quote:'The formatter is biome.'}]);
 const next=s.source('a','The release inputs were reviewed.',[derived]),fact=s.extract(next.source,(next.user.data as {text:string}).text);
 const summary=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L2',contentType:'fact',text:privateText,operation:'store',replaces:[],evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}],validUntil:null,certainty:'observed'},s.collection.generation,'layer_summary')!;
 expect(s.memory.read(root,summary.recordId,'p').text).toBe(privateText);
 expect(()=>s.memory.read(reader,summary.recordId,'p')).toThrow('forbidden');
});


test('a fully quoted user fact still respects direct private Asset versions and later revocation',async()=>{
 const s=setup(),owner={...root,agentId:'a',runId:'asset-boundary-run'},files=createAssetFiles(s.home);writeFileSync(join(s.home,'private.txt'),'OMEGA_INTERNAL_712');
 const staged=await files.stageFiles(owner,owner.runId,[{allowedRoot:s.home,relativePath:'private.txt',manifestPath:'private.txt'}]);
 const asset=s.assets.createAsset(owner,{kind:'document',title:'Private deployment details',owner:{userId:'local',agentId:'a'}}),version=s.assets.publishAssetVersion(owner,{assetId:asset.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{runId:owner.runId,sourceVersions:[]}},'private-version');
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(chat.id,'metadata',{actualUse:'acknowledged',sourceVersions:[{assetId:asset.id,versionId:version.id}]});
 const event=s.store.appendEvent(chat.id,'user',{text:'The formatter is biome.',invocationId:crypto.randomUUID()});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:s.collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0],record=s.extract(source,'The formatter is biome.',event.id);
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
 let current=s.assets.getAuthorizedAsset(root,asset.id);s.assets.setAccess(root,asset.id,{mode:'all'},current.revision);expect(s.memory.read(reader,record.recordId,'p').text).toBe('The formatter is biome.');
 current=s.assets.getAuthorizedAsset(root,asset.id);s.assets.setAccess(root,asset.id,{mode:'private'},current.revision);expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
});


test.each([{semanticKey:'private.omega_internal_712'}, {validUntil:'2099-01-01 (OMEGA_INTERNAL_712)'},{validUntil:'2099-01-01T00:00:00.000Z'}])('unquoted model metadata keeps full inherited authority across public read paths: %j',metadata=>{
 const s=setup(),captured=s.source('a','The formatter is biome.',[s.hidden]);
 const record=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'The formatter is biome.',operation:'store',replaces:[],evidence:[{sourceId:captured.source.id,sourceRevision:captured.source.revision}],support:[{sourceId:captured.source.id,eventId:captured.user.id,quote:'The formatter is biome.'}],validUntil:null,certainty:'user_asserted',...metadata},s.collection.generation,'evidence_extract')!;
 expect(s.memory.read(root,record.recordId,'p')).toMatchObject(metadata);
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
 expect(s.memory.list(reader,{projectId:'p'}).some(r=>r.recordId===record.recordId)).toBe(false);
 expect(()=>s.memory.history(reader,{projectId:'p',items:[{recordId:record.recordId,revision:record.revision}]})).toThrow('forbidden');
 const next=s.source('b','The release inputs were reviewed.',[record]);
 expect(()=>s.memory.source(reader,next.source.id,'p')).toThrow('forbidden');
 expect(()=>s.memory.read(reader,s.hidden.recordId,'p')).toThrow('forbidden');
});

test('separate genuine user quotes cannot jointly authorize a generated semantic label',()=>{
 const s=setup(),captured=s.source('a','The formatter is biome. Release label: formatter.biome.',[s.hidden]);
 const record=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text:'The formatter is biome.',semanticKey:'formatter.biome',operation:'store',replaces:[],evidence:[{sourceId:captured.source.id,sourceRevision:captured.source.revision}],support:[{sourceId:captured.source.id,eventId:captured.user.id,quote:'The formatter is biome.'},{sourceId:captured.source.id,eventId:captured.user.id,quote:'Release label: formatter.biome.'}],validUntil:null,certainty:'user_asserted'},s.collection.generation,'evidence_extract')!;
 expect(()=>s.memory.read(reader,record.recordId,'p')).toThrow('forbidden');
});

test.each([{text:'The formatter is biome.',metadata:{semanticKey:'biome',validUntil:null}},{text:'The formatter is biome until 2099-01-01T00:00:00.000Z.',metadata:{validUntil:'2099-01-01T00:00:00.000Z'}}])('fully quoted text and metadata preserve user fact access: %j',({text,metadata})=>{
 const s=setup(),captured=s.source('a',text,[s.hidden]);
 const record=s.memory.applyProposal(root,{collectionId:s.collection.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:captured.source.id,sourceRevision:captured.source.revision}],support:[{sourceId:captured.source.id,eventId:captured.user.id,quote:text}],certainty:'user_asserted',...metadata},s.collection.generation,'evidence_extract')!;
 expect(s.memory.read(reader,record.recordId,'p')).toMatchObject({text,...metadata});
 expect(()=>s.memory.read(reader,s.hidden.recordId,'p')).toThrow('forbidden');
});
