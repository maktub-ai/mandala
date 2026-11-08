import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryJobs } from '../server/memory-jobs';
import { createMemoryRecall } from '../server/memory-recall';
import { createMemoryRuntime, memoryHistoryReferences } from '../server/memory-runtime';
import { DomainError } from '../shared/workspace-contracts';
import type { MemoryProposal } from '../shared/memory';
import type { KnowledgeEntry } from '../shared/types';
const root={userId:'local'},cleanups:(()=>void)[]=[];
afterEach(()=>{vi.restoreAllMocks();cleanups.splice(0).forEach(cleanup=>cleanup());});
function setup(authorizeConversationRead?:Parameters<typeof createMemoryStore>[1]['authorizeConversationRead']){
 const home=mkdtempSync(join(tmpdir(),'memory-performance-')),store=openStore(home);
 cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeConversationRead});
 const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 return {store,memory,chat};
}
test('repeated legacy import looks up frozen IDs without scanning the entire archive',()=>{
 const s=setup(),entries:KnowledgeEntry[]=Array.from({length:200},(_,i)=>({id:'legacy-'+i,kind:'memory',title:'Synthetic archive',content:'Archive '+i,scope:'agent',agentId:'a',projectId:'p',level:'L1',status:'active',access:{mode:'owner'},createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}));
 expect(s.memory.importLegacy(root,entries).imported).toBe(200);
 expect(s.memory.importLegacy(root,entries).imported).toBe(0);
 expect(()=>s.memory.importLegacy(root,[{...entries[0],content:'Changed archive'}])).toThrow('legacy_content_conflict');
 const plan=s.store.database.prepare("EXPLAIN QUERY PLAN SELECT data FROM memory_records WHERE json_extract(data,'$.legacyId')=?").all(entries[0].id).map(row=>row.detail).join(' ');
 expect(plan).toContain('SEARCH memory_records');
});
test('archive recall validates a shared collection once per synchronous pool and renews its ACL on the next query',()=>{
 const s=setup(),entries:KnowledgeEntry[]=Array.from({length:200},(_,i)=>({id:'archive-'+i,kind:'memory',title:'Synthetic archive',content:'Synthetic archive item '+i,scope:'agent',agentId:'a',projectId:'p',level:'L1',status:'active',access:{mode:'owner'},createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}));
 s.memory.importLegacy(root,entries);
 const assets=s.memory.options.assets,authorize=vi.spyOn(assets,'getAuthorizedAsset'),recall=createMemoryRecall(s.memory),reader={...root,agentId:'a'};
 const before=recall.search(reader,{projectId:'p',query:'archive 42'});
 expect(before.items).toHaveLength(8);
 // The output fence revalidates up to eight selected records after pool enumeration.
 expect(authorize.mock.calls.length).toBeLessThanOrEqual(10);
 const collection=s.memory.collections(root)[0],asset=assets.getAuthorizedAsset(root,collection.id);
 assets.setAccess(root,asset.id,{mode:'private'},asset.revision);
 expect(recall.search(reader,{projectId:'p',query:'archive 42'}).items).toEqual([]);
});
test('project pool enumeration excludes unrelated personal evidence before validation, preserving all authorized scopes and fresh checks',async()=>{
 const privateChats=new Set<string>();let revoked:string|null=null;
 const authorize=vi.fn((_p:unknown,id:string)=>{if(id===revoked)throw new DomainError('forbidden',403,'forbidden');}),s=setup(authorize);
 const create=(projectId:string|null,agentId:string|null,text:string,contentType:'fact'|'preference'='fact',derived=false)=>{
  const c=s.memory.ensureCollection(root,{projectId,agentId}),chat=s.store.createConversation({projectId:projectId??'',agentId:agentId??(projectId?'a':''),cli:'codex',model:null});
  const event=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});
  const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  const proposal:MemoryProposal={collectionId:c.id,layer:'L1',contentType,text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'observed'};
  const records=[s.memory.applyProposal(root,proposal,c.generation,'evidence_extract')!];
  if(derived)for(const layer of ['L2'] as const)records.push(s.memory.applyProposal(root,{...proposal,layer,semanticKey:'scene.synthetic',text:layer+' '+text,dependencies:[{recordId:records.at(-1)!.recordId,revision:1}]},c.generation,'layer_summary')!);
  return {chat,event,records};
 };
 // The late UI suite has many project scopes plus personal facts and derived summaries.
 for(let i=0;i<40;i++)privateChats.add(create(null,null,'Synthetic personal history '+i,'fact',true).chat.id);
 const projects=Array.from({length:70},(_,i)=>create('project-'+i,null,'Synthetic project fact '+i));
 const preference=create(null,null,'I prefer all reports in Chinese','preference'),personal=create(null,'a','Synthetic agent personal fact','fact',true);
 s.memory.importLegacy(root,[
  {id:'legacy-global',kind:'memory',title:'legacy',content:'Synthetic legacy global',scope:'global',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'},
  {id:'legacy-agent',kind:'memory',title:'legacy',content:'Synthetic legacy agent',scope:'agent',agentId:'a',projectId:'project-0',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'},
 ]);
 authorize.mockClear();
 for(let i=0;i<projects.length;i++)expect(s.memory.list(root,{projectId:'project-'+i,status:'active'}).map(r=>r.text).sort()).toEqual(['Synthetic legacy global',...(i===0?['Synthetic legacy agent']:[]),projects[i].records[0].text,preference.records[0].text].sort());
 expect(authorize.mock.calls.filter(([,id])=>privateChats.has(id))).toHaveLength(0);
 expect(s.memory.list(root,{projectId:null,status:'active'}).filter(r=>r.conversationId&&privateChats.has(r.conversationId))).toHaveLength(80);
 const agent={...root,agentId:'a'},other={...root,agentId:'b'};
 expect(s.memory.list(agent,{projectId:'project-0',status:'active'}).map(r=>r.text)).toEqual(expect.arrayContaining([...personal.records.map(r=>r.text),'Synthetic legacy agent',preference.records[0].text,projects[0].records[0].text]));
 expect(s.memory.list(other,{projectId:'project-0',status:'active'}).filter(r=>personal.records.some(personal=>personal.recordId===r.recordId))).toEqual([]);
 expect(s.memory.list(agent,{projectId:'project-1',status:'active'}).map(r=>r.text)).not.toContain('Synthetic legacy agent');
 await Promise.resolve();revoked=personal.chat.id;
 expect(s.memory.list(agent,{projectId:'project-0',status:'active'}).filter(r=>r.conversationId===personal.chat.id)).toEqual([]);
 revoked=null;s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Changed global preference'}),preference.event.id);
 expect(s.memory.list(agent,{projectId:'project-0',status:'active'}).map(r=>r.recordId)).not.toContain(preference.records[0].recordId);
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:preference.records[0].text}),preference.event.id);
 s.memory.retract(root,{recordId:personal.records[0].recordId,expectedRevision:1});
 expect(s.memory.list(agent,{projectId:'project-0',status:'active'}).filter(r=>r.conversationId===personal.chat.id)).toEqual([]);
});
test('source validation reads referenced events without parsing unrelated conversation history, and still detects changes',()=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 const input=s.store.appendEvent(s.chat.id,'user',{text:'Synthetic supported fact'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 for(let i=0;i<1000;i++)s.store.appendEvent(s.chat.id,'text',{text:'Unrelated later streaming output '.repeat(100)});
 const history=vi.spyOn(s.store,'listEvents');
 expect(s.memory.source(root,source.id).id).toBe(source.id);
 expect(history).not.toHaveBeenCalled();
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Changed fact'}),input.id);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Synthetic supported fact'}),input.id);
 s.store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(input.id);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
});
test('unchanged evidence hashes are reused, but own writes and other connections invalidate them before the next read',()=>{
 let revoked=false;
 const authorize=vi.fn(()=>{if(revoked)throw new DomainError('forbidden',403,'forbidden');}),s=setup(authorize),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 const data={text:'Synthetic immutable-until-written evidence'},event=s.store.appendEvent(s.chat.id,'user',data);
 s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 s.memory.source(root,source.id);
 const parse=vi.spyOn(JSON,'parse');authorize.mockClear();
 s.memory.source(root,source.id);s.memory.source(root,source.id);
 expect(parse.mock.calls.filter(([value])=>value===JSON.stringify(data))).toHaveLength(0);
 expect(authorize).toHaveBeenCalledTimes(2);
 revoked=true;expect(()=>s.memory.source(root,source.id)).toThrow('forbidden');revoked=false;
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'own write'}),event.id);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),event.id);
 expect(s.memory.source(root,source.id).id).toBe(source.id);
 const other=new DatabaseSync(join(s.store.home,'state.sqlite'));
 try{
  other.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'external write'}),event.id);
  expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
  other.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),event.id);
  expect(s.memory.source(root,source.id).id).toBe(source.id);
  other.prepare('UPDATE events SET superseded=1 WHERE id=?').run(event.id);
  expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 }finally{other.close();}
});
test('unrelated writes and other conversations preserve evidence digests while live authorization is renewed',()=>{
 let revoked=false;
 const authorize=vi.fn(()=>{if(revoked)throw new DomainError('forbidden',403,'forbidden');}),s=setup(authorize),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 const data={text:'Stable historical evidence'},event=s.store.appendEvent(s.chat.id,'user',data);
 s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 s.memory.source(root,source.id);
 const parse=vi.spyOn(JSON,'parse');authorize.mockClear();
 s.store.database.prepare('UPDATE memory_collections SET data=data WHERE id=?').run(c.id);
 s.memory.source(root,source.id);
 const otherChat=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 s.store.appendEvent(otherChat.id,'text',{text:'Unrelated active stream'});
 const other=new DatabaseSync(join(s.store.home,'state.sqlite'));
 try{
  other.prepare('UPDATE memory_collections SET data=data WHERE id=?').run(c.id);
  s.memory.source(root,source.id);
  expect(parse.mock.calls.filter(([value])=>value===JSON.stringify(data))).toHaveLength(0);
  expect(authorize).toHaveBeenCalledTimes(2);
  revoked=true;expect(()=>s.memory.source(root,source.id)).toThrow('forbidden');revoked=false;
  other.prepare('DELETE FROM events WHERE id=?').run(event.id);
  expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 }finally{other.close();}
});
test('moving an event invalidates both transcript digests',()=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 const event=s.store.appendEvent(s.chat.id,'user',{text:'Evidence in original conversation'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 s.memory.source(root,source.id);
 const target=s.store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 s.store.database.prepare('UPDATE events SET conversationId=? WHERE id=?').run(target.id,event.id);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 expect(s.store.database.prepare('SELECT revision FROM event_revisions WHERE conversation_id=?').get(target.id)?.revision).toBe(1);
 s.store.database.prepare('UPDATE events SET conversationId=? WHERE id=?').run(s.chat.id,event.id);
 expect(s.memory.source(root,source.id).id).toBe(source.id);
});
test('one authority query materializes shared raw source payload only once across scope checks',()=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 s.store.appendEvent(s.chat.id,'user',{text:'Shared source payload'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const payload=s.store.database.prepare('SELECT data FROM memory_sources WHERE id=?').get(source.id)!.data;
 const parse=vi.spyOn(JSON,'parse');
 s.memory.withAuthorityQuery(()=>{s.memory.source(root,source.id);s.memory.source(root,source.id,null);});
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(1);
 s.store.database.prepare("UPDATE memory_sources SET data=json_set(data,'$.status','retracted') WHERE id=?").run(source.id);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_retracted');
});
test.each([[false,false],[true,false],[false,true],[true,true]])('rolled-back event digests never survive their transaction (initially changed: %s, nested: %s)',(changed,nested)=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null}),data={text:'Original fixed evidence'},event=s.store.appendEvent(s.chat.id,'user',data);
 s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const update=s.store.database.prepare('UPDATE events SET data=? WHERE id=?'),replacement=JSON.stringify({text:'Replaced evidence'});
 const check=(valid:boolean)=>valid?expect(s.memory.source(root,source.id).id).toBe(source.id):expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
 if(changed)update.run(replacement,event.id);
 check(!changed);
 const transaction=()=>s.store.transaction(()=>{
  if(!nested)check(!changed);
  update.run(changed?JSON.stringify(data):replacement,event.id);
  check(changed);
  throw new Error('rollback-test');
 });
 expect(()=>nested?s.memory.withAuthorityQuery(transaction):transaction()).toThrow('rollback-test');
 check(!changed);
});
test('conversation authorization is shared within a job list and renewed after permissions change',()=>{
 let revoked=false;const authorize=vi.fn(()=>{if(revoked)throw new Error('forbidden');}),s=setup(authorize),c=s.memory.ensureCollection(root,{projectId:null,agentId:null}),jobs=createMemoryJobs(s.store,s.memory);
 s.store.appendEvent(s.chat.id,'user',{text:'Synthetic permission fact'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 for(const kind of ['request','session'] as const)s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind});
 authorize.mockClear();expect(jobs.list(root)).toHaveLength(2);expect(authorize).toHaveBeenCalledTimes(1);
 revoked=true;expect(jobs.list(root)).toEqual([]);expect(authorize.mock.calls.length).toBeGreaterThan(1);
});
test('native memory history checks only metadata and still reject missing fixed revisions and superseded acknowledgments',()=>{
 const s=setup();for(let i=0;i<1000;i++)s.store.appendEvent(s.chat.id,'text',{text:'Unrelated output '.repeat(100)});
 const unrelated={execution:'started'};for(let i=0;i<100;i++)s.store.appendEvent(s.chat.id,'metadata',unrelated);
 const acknowledgment=s.store.appendEvent(s.chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:'synthetic',revision:2}]});
 const history=vi.spyOn(s.store,'listEvents'),parse=vi.spyOn(JSON,'parse');
 expect(memoryHistoryReferences(s.store,s.chat.id)).toEqual([{recordId:'synthetic',revision:2,reason:'inherited_native_history'}]);
 expect(history).not.toHaveBeenCalled();
 expect(parse.mock.calls.filter(call=>call[0]===JSON.stringify(unrelated))).toHaveLength(0);
 s.store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(acknowledgment.id);
 expect(memoryHistoryReferences(s.store,s.chat.id)).toEqual([]);
 s.store.appendEvent(s.chat.id,'metadata',{memoryRecall:'request',status:'completed',count:1});
 expect(()=>memoryHistoryReferences(s.store,s.chat.id)).toThrow('legacy_memory_history_unverified');
});
test('scene scheduling filters the collection before validating unrelated stale sources',()=>{
 const s=setup(),collections=['one','two'].map(projectId=>{
  const c=s.memory.ensureCollection(root,{projectId,agentId:null}),chat=s.store.createConversation({projectId,agentId:'',cli:'codex',model:null});
  const input=s.store.appendEvent(chat.id,'user',{text:'Synthetic fact '+projectId});s.store.appendEvent(chat.id,'status',{status:'idle'});
  const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  const proposal={collectionId:c.id,layer:'L1' as const,contentType:'fact' as const,text:'Synthetic fact '+projectId,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:1}],support:[{sourceId:source.id,eventId:input.id,quote:'Synthetic fact '+projectId}],validUntil:null,certainty:'observed' as const};
  const fact=s.memory.applyProposal(root,proposal,c.generation,'evidence_extract')!;
  s.memory.applyProposal(root,{...proposal,layer:'L2',semanticKey:'scene.synthetic',dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'layer_summary');
  s.memory.correct(root,{recordId:fact.recordId,expectedRevision:fact.revision,text:'Changed synthetic fact'});return c;
 });
 expect(s.memory.staleScenes(root,'one',collections[0].id).map(r=>r.collectionId)).toEqual([collections[0].id]);
});
test('job listing validates shared evidence once per synchronous query and rechecks it on the next call',()=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null}),jobs=createMemoryJobs(s.store,s.memory);
 const data={text:'Shared synthetic fact'},input=s.store.appendEvent(s.chat.id,'user',data);s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 for(const kind of ['request','session'] as const)s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind});
 const parse=vi.spyOn(JSON,'parse');expect(jobs.list(root)).toHaveLength(2);
 expect(parse.mock.calls.filter(call=>call[0]===JSON.stringify(data))).toHaveLength(1);
 parse.mockClear();expect(jobs.list(root,{collectionId:c.id,states:['running']})).toEqual([]);
 expect(parse.mock.calls.filter(call=>call[0]===JSON.stringify(data))).toHaveLength(0);
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Changed shared fact'}),input.id);
 expect(jobs.list(root)).toEqual([]);
});
test('job watermarks ignore metadata without parsing the transcript and reject later content',()=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null}),jobs=createMemoryJobs(s.store,s.memory);
 s.store.appendEvent(s.chat.id,'user',{text:'Synthetic complete turn'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});s.store.completeConversation(s.chat.id,true);
 s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'completed',kind:'request'});
 s.store.appendEvent(s.chat.id,'metadata',{execution:'completed'});const history=vi.spyOn(s.store,'listEvents');
 const job=jobs.claim('synthetic-worker')!;expect(job.state).toBe('running');expect(history).not.toHaveBeenCalled();
 jobs.validateLease(job);s.store.appendEvent(s.chat.id,'text',{text:'Later content'});expect(()=>jobs.validateLease(job)).toThrow('source_changed');
});
test('disabled background generation never reads conversation history',async()=>{
 const s=setup(),runtime=createMemoryRuntime({home:join(tmpdir(),'unused-synthetic-home'),store:s.store,loadConfig:async()=>({version:2,projects:[],agents:[],system:{cli:'codex',memoryCapture:false}})});
 const history=vi.spyOn(s.store,'listEvents');try{await runtime.scan();expect(history).not.toHaveBeenCalled();}finally{await runtime.close();}
});
test.each([499,500,501,1001])('source validation preserves hashes across a %i-event stream',count=>{
 const s=setup(),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 s.store.appendEvent(s.chat.id,'user',{text:'Synthetic chunk boundary'});let last=0;
 for(let i=0;i<count;i++)last=s.store.appendEvent(s.chat.id,'text',{text:'中文片段 '+i}).id;
 s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 expect(s.memory.source(root,source.id).eventIds).toHaveLength(count+2);
 s.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'Changed boundary'}),last);
 expect(()=>s.memory.source(root,source.id)).toThrow('source_changed');
});

test('idle background scans do not rebuild unchanged transcripts, while new content and collection changes recapture',async()=>{
 const s=setup(),config={version:2 as const,projects:[],agents:[],system:{cli:'codex' as const,memory:{request:{generate:true,read:true},session:{generate:false,read:true},idleHours:6}}};
 s.store.appendEvent(s.chat.id,'user',{text:'Synthetic user fact'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const runtime=createMemoryRuntime({home:join(tmpdir(),'unused-synthetic-home'),store:s.store,loadConfig:async()=>config,schedule:false});
 const history=vi.spyOn(s.store,'listEvents');
 try{
  await runtime.scan();expect(history).toHaveBeenCalled();history.mockClear();
  s.store.appendEvent(s.chat.id,'metadata',{systemTask:'memory',status:'completed'});
  await runtime.scan();await runtime.scan();expect(history).not.toHaveBeenCalled();
  s.store.appendEvent(s.chat.id,'user',{text:'Another synthetic fact'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
  await runtime.scan();expect(history).toHaveBeenCalled();history.mockClear();
  s.store.database.prepare("UPDATE memory_collections SET data=json_set(data,'$.generation',json_extract(data,'$.generation')+1)").run();
  await runtime.scan();expect(history).toHaveBeenCalled();
 }finally{await runtime.close();}
});

test('a background scheduling pass validates shared event content once across project Agent scopes',async()=>{
 const s=setup(),config={version:2 as const,projects:[{id:'p',name:'Project',cwd:'',agentIds:['a','b'],resources:[],skills:[],mcp:[]}],agents:['a','b'].map(id=>({id,name:id,instructions:'',defaultCli:'codex' as const,models:{},skills:[],mcp:[]}))};
 const runtime=createMemoryRuntime({home:join(tmpdir(),'unused-synthetic-home'),store:s.store,loadConfig:async()=>config});
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),data={text:'Shared project scheduling evidence'};
 const event=s.store.appendEvent(chat.id,'user',data);s.store.appendEvent(chat.id,'status',{status:'idle'});
 const c=runtime.memory.ensureCollection(root,{projectId:'p',agentId:null});
 const source=runtime.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
 runtime.memory.applyProposal(root,{collectionId:c.id,layer:'L1',contentType:'fact',text:data.text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:data.text}],validUntil:null,certainty:'observed'},c.generation,'evidence_extract');
 try{
  await runtime.scan();const parse=vi.spyOn(JSON,'parse');
  await runtime.scan();expect(parse.mock.calls.filter(call=>call[0]===JSON.stringify(data)).length).toBeLessThanOrEqual(1);
 }finally{await runtime.close();}
});

test('idle workers leave completed jobs out of the claim read path',()=>{
 const s=setup(),jobs=createMemoryJobs(s.store,s.memory),c=s.memory.ensureCollection(root,{projectId:null,agentId:null});
 s.store.appendEvent(s.chat.id,'user',{text:'Synthetic finished job'});s.store.appendEvent(s.chat.id,'status',{status:'idle'});
 const captured=s.memory.captureConversation(root,{collectionId:c.id,conversationId:s.chat.id,trigger:'explicit',kind:'request'});
 const done={...captured.jobs[0],state:'completed'};
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify(done),done.id);
 const parse=vi.spyOn(JSON,'parse');expect(jobs.claim('idle-worker')).toBeNull();
 expect(parse.mock.calls.filter(call=>call[0]===JSON.stringify(done))).toHaveLength(0);
});

test('background reconciliation runs every five seconds while the worker keeps polling',async()=>{
 const s=setup(),runtime=createMemoryRuntime({home:join(tmpdir(),'unused-synthetic-home'),store:s.store,loadConfig:async()=>({version:2,projects:[],agents:[]})});
 vi.useFakeTimers();const chats=vi.spyOn(s.store,'listConversations'),claims=vi.spyOn(runtime.jobs,'claim');
 try{
  runtime.start();await runtime.scan();await vi.advanceTimersByTimeAsync(4200);
  expect(chats).toHaveBeenCalledTimes(2);expect(claims.mock.calls.length).toBeGreaterThanOrEqual(4);
  // A pass yields to real I/O; the clock assertion checks that the next pass started.
  await vi.advanceTimersByTimeAsync(1000);expect(chats.mock.calls.length).toBeGreaterThanOrEqual(3);
 }finally{await runtime.close();vi.useRealTimers();}
});

test('an execution cutoff omits old inherited memory without weakening the default history check',()=>{
 const s=setup();s.store.appendEvent(s.chat.id,'metadata',{memoryRecall:'request',status:'completed',count:1});
 const boundary=s.store.appendEvent(s.chat.id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked'}});
 s.store.appendEvent(s.chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:'current',revision:3}]});
 expect(()=>memoryHistoryReferences(s.store,s.chat.id)).toThrow('legacy_memory_history_unverified');
 expect(memoryHistoryReferences(s.store,s.chat.id,boundary.id)).toEqual([{recordId:'current',revision:3,reason:'inherited_native_history'}]);
});
