import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openStore} from '../server/store';
import {readConfig, writeConfig} from '../server/config';
import {createSkillService} from '../server/skill-service';
import {assertSkillEvidence, registerSkillConversationRead} from '../server/skill-evidence';
import {createMemoryRuntime,memoryHistoryReferences,type MemoryRuntime} from '../server/memory-runtime';
import {createSessionManager,type SessionManager} from '../server/sessions';
import type {SkillSource} from '../shared/types';
let home:string,store:ReturnType<typeof openStore>,host:SessionManager|undefined,memory:MemoryRuntime|undefined;
beforeEach(async()=>{
 home=await mkdtemp(join(tmpdir(),'skill-evidence-performance-'));store=openStore(home);
 const saved=await readConfig(home);
 await writeConfig(home,{...saved.config,agents:[{id:'a',name:'a',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]}]},saved.revision);
});
afterEach(async()=>{vi.restoreAllMocks();await host?.close();await memory?.close();host=undefined;memory=undefined;store.close();await rm(home,{recursive:true,force:true});});
function evidence(count=1){
 const chat=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const events=Array.from({length:count},(_,i)=>store.appendEvent(chat.id,'user',{text:'Synthetic evidence '+i}));
 const source:SkillSource={agentId:'a',projectId:'',method:'dialogue',verification:'draft',conversationId:chat.id,eventIds:events.map(e=>e.id),eventFingerprints:Object.fromEntries(events.map(e=>[e.id,createHash('sha256').update(JSON.stringify(e)).digest('hex')]))};
 return {chat,events,source};
}
test('repeated config hydration reads only fixed Skill evidence, not unrelated transcript payloads',async()=>{
 const {chat,source}=evidence();
 const result=await createSkillService(home,store)('a','skill_register',{name:'review',content:'---\nname: review\ndescription: Review changes\n---\nSynthetic instructions'},'seed',()=>{},source) as {skill:{id:string}};
 const unrelated=JSON.stringify({text:'Unrelated streaming payload '.repeat(100)});
 const insert=store.database.prepare('INSERT INTO events(conversationId,kind,data,createdAt) VALUES (?,?,?,?)');
 store.transaction(()=>{for(let i=0;i<2000;i++)insert.run(chat.id,'text',unrelated,'2026-10-20T00:00:00Z');});
 const parse=vi.spyOn(JSON,'parse');
 for(let i=0;i<2;i++)expect((await readConfig(home)).config.skillLibrary?.find(s=>s.id===result.skill.id)?.content).toContain('Synthetic instructions');
 expect(parse.mock.calls.filter(([value])=>value===unrelated)).toHaveLength(0);
});
test('live host Skill hydration reads receipt history without decoding unrelated dialogue payloads',async()=>{
 const {chat,source}=evidence();
 const result=await createSkillService(home,store)('a','skill_register',{name:'review',content:'---\nname: review\ndescription: Review changes\n---\nSynthetic instructions'},'seed',()=>{},source) as {skill:{id:string}};
 host=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw new Error('No native execution expected');},undefined,home);
 const unrelated=JSON.stringify({text:'Unrelated tool output '.repeat(100)}),insert=store.database.prepare('INSERT INTO events(conversationId,kind,data,createdAt) VALUES(?,?,?,?)');
 store.transaction(()=>{for(let i=0;i<2000;i++)insert.run(chat.id,'tool',unrelated,'2026-11-03T00:00:00Z');});
 const parse=vi.spyOn(JSON,'parse'),prepare=vi.spyOn(store.database,'prepare');
 expect((await readConfig(home)).config.skillLibrary?.find(s=>s.id===result.skill.id)?.content).toContain('Synthetic instructions');
 expect(parse.mock.calls.filter(([value])=>value===unrelated)).toHaveLength(0);
 const sql=prepare.mock.calls.find(([sql])=>sql.includes('SELECT kind,data FROM events')&&sql.includes('receiptContext'))![0];prepare.mockRestore();
 expect(store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(chat.id,0).map(row=>row.detail).join(' ')).toContain('events_receipt_history');
});
test('one config hydration shares inherited memory reads and renews collection access on the next read',async()=>{
 const root={userId:store.ownerUserId};
 memory=createMemoryRuntime({home,store,schedule:false,loadConfig:async()=>(await readConfig(home)).config,authorizeConversationRead:(_p,id)=>host!.authorizeConversationRead(id)});
 host=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw new Error('No native execution expected');},undefined,home,undefined,undefined,memory);
 const parent=evidence(),collection=memory.memory.ensureCollection(root,{projectId:null,agentId:'a'});
 store.appendEvent(parent.chat.id,'status',{status:'idle'});
 const captured=memory.memory.captureConversation(root,{collectionId:collection.id,conversationId:parent.chat.id,trigger:'explicit',kind:'request'}).sources[0];
 const record=memory.memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType:'fact',text:'Synthetic evidence 0',operation:'store',replaces:[],evidence:[{sourceId:captured.id,sourceRevision:captured.revision}],support:[{sourceId:captured.id,eventId:parent.events[0].id,quote:'Synthetic evidence 0'}],validUntil:null,certainty:'observed'},collection.generation,'evidence_extract')!;
 const ids:string[]=[];
 for(let i=0;i<3;i++){
  const {chat,source}=evidence();store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:record.recordId,revision:record.revision}]});
  const result=await createSkillService(home,store)('a','skill_register',{name:'shared-'+i,content:'---\nname: shared-'+i+'\ndescription: Shared evidence\n---\nSynthetic instructions'},'seed-'+i,()=>{},source) as {skill:{id:string}};ids.push(result.skill.id);
 }
 const payload=store.database.prepare('SELECT data FROM memory_sources WHERE id=?').get(captured.id)!.data;
 // Registration already warmed the source cache. Advance its revision to exercise a cold read.
 store.database.prepare('UPDATE memory_sources SET data=? WHERE id=?').run(payload,captured.id);
 const parse=vi.spyOn(JSON,'parse');
 const config=(await readConfig(home)).config;
 const skills=config.skillLibrary!.filter(skill=>ids.includes(skill.id));expect(skills).toHaveLength(3);
 expect(skills.every(skill=>skill.content?.includes('Synthetic instructions'))).toBe(true);
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(1);
 parse.mockClear();
 const cached=(await readConfig(home)).config.skillLibrary!.filter(skill=>ids.includes(skill.id));
 expect(cached).toEqual(skills);
 expect(parse.mock.calls.filter(([value])=>value===payload)).toHaveLength(0);
 const asset=memory.memory.options.assets.getAuthorizedAsset(root,collection.id);memory.memory.options.assets.setLifecycle(root,asset.id,'retracted',asset.revision);
 const unavailable=(await readConfig(home)).config.skillLibrary!.filter(skill=>ids.includes(skill.id));expect(unavailable).toHaveLength(3);
 expect(unavailable.every(skill=>skill.unavailable&&skill.content===undefined)).toBe(true);
});
test('selective receipt authorization retains both event forms, supersession, isolation and live revocation',async()=>{
 const {chat,source}=evidence(),config=(await readConfig(home)).config,root={userId:store.ownerUserId};
 host=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw new Error('No native execution expected');},undefined,home);
 const task=host.taskService.createTask(root,{goal:'Synthetic receipt authority',assigneeAgentId:'a'},'receipt-task');
 const insert=store.database.prepare("INSERT INTO task_receipts(id,task_id,policy,delivery_state,summary,artifact_versions,legacy_id,created_at) VALUES(?,?,'notify','parked','Synthetic receipt','[]',?,'2026-11-03T00:00:00Z')");
 for(const id of ['metadata-receipt','user-receipt'])insert.run(id,task.id,id);
 const metadata=store.appendEvent(chat.id,'metadata',{receiptContext:true,receiptIds:['metadata-receipt']});
 const user=store.appendEvent(chat.id,'user',{text:'Receipt continuation',source:{kind:'coordination',receiptIds:['user-receipt']}});
 const other=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});store.appendEvent(other.id,'metadata',{receiptContext:true,receiptIds:['foreign-missing']});
 const check=()=>assertSkillEvidence(store,source,'a',root,config);
 expect(check).not.toThrow();
 store.database.prepare('DELETE FROM task_receipts WHERE id=?').run('metadata-receipt');expect(check).toThrow('receipt_not_found');
 store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(metadata.id);expect(check).not.toThrow();
 store.database.prepare('DELETE FROM task_receipts WHERE id=?').run('user-receipt');expect(check).toThrow('receipt_not_found');
 store.database.prepare('UPDATE events SET superseded=1 WHERE id=?').run(user.id);expect(check).not.toThrow();
});
test('bounded evidence reads preserve fingerprints, supersession and conversation isolation across batches',async()=>{
 const {chat,events,source}=evidence(501),config=(await readConfig(home)).config,root={userId:store.ownerUserId};
 expect(()=>assertSkillEvidence(store,source,'a',root,config)).not.toThrow();
 expect(()=>assertSkillEvidence(store,{...source,eventIds:[...source.eventIds!].reverse()},'a',root,config)).not.toThrow();
 expect(()=>assertSkillEvidence(store,{...source,eventFingerprints:{...source.eventFingerprints,[events[0].id]:'forged'}},'a',root,config)).toThrow('Original Skill evidence is unavailable');
 expect(()=>assertSkillEvidence(store,{...source,eventIds:[Number.MAX_SAFE_INTEGER]},'a',root,config)).toThrow('Original Skill evidence is unavailable');
 const last=events.at(-1)!;
 store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({text:'changed'}),last.id);
 expect(()=>assertSkillEvidence(store,source,'a',root,config)).toThrow('Original Skill evidence is unavailable');
 store.database.prepare('UPDATE events SET data=?,superseded=1 WHERE id=?').run(JSON.stringify(last.data),last.id);
 expect(()=>assertSkillEvidence(store,source,'a',root,config)).toThrow('Original Skill evidence is unavailable');
 store.database.prepare('UPDATE events SET superseded=0 WHERE id=?').run(last.id);
 const other=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}),foreign=store.appendEvent(other.id,'user',{text:'Other conversation'});
 expect(()=>assertSkillEvidence(store,{...source,eventIds:[foreign.id]},'a',root,config)).toThrow('Original Skill evidence is unavailable');
 expect(()=>assertSkillEvidence(store,{...source,eventIds:[],eventFingerprints:{}},'a',root,config)).not.toThrow();
 expect(store.getConversation(chat.id)?.agentId).toBe('a');
});
test('config hydration validates shared evidence once per reader and renews authority on the next read',async()=>{
 const {source}=evidence();
 const result=await createSkillService(home,store)('a','skill_register',{name:'review',content:'---\nname: review\ndescription: Review changes\n---\nSynthetic instructions'},'seed',()=>{},source) as {skill:{id:string}};
 let revoked=false;
 const authorize=vi.fn(()=>{if(revoked)throw new Error('revoked');}),release=registerSkillConversationRead(store,authorize);
 try{
  expect((await readConfig(home)).config.skillLibrary?.find(s=>s.id===result.skill.id)?.unavailable).toBeUndefined();
  expect(authorize).toHaveBeenCalledTimes(2);
  revoked=true;
  expect((await readConfig(home)).config.skillLibrary?.find(s=>s.id===result.skill.id)).toMatchObject({unavailable:true,content:undefined});
  expect(authorize.mock.calls.length).toBeGreaterThan(2);
 }finally{release();}
});
test('memory history authorization uses the selective metadata index',()=>{
 const {chat}=evidence();
 store.appendEvent(chat.id,'metadata',{memoryUse:'acknowledged',items:[{recordId:'synthetic',revision:1}]});
 const prepare=vi.spyOn(store.database,'prepare');
 expect(memoryHistoryReferences(store,chat.id)).toHaveLength(1);
 const sql=prepare.mock.calls.find(([sql])=>sql.includes("kind='metadata'"))![0];
 prepare.mockRestore();
 const plan=store.database.prepare('EXPLAIN QUERY PLAN '+sql).all(chat.id).map(row=>row.detail).join(' ');
 expect(plan).toContain('events_memory_history');
});
