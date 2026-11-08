import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { memoryServices } from '../server/memory-runtime';
import { searchWorkspace } from '../server/workspace-search';
import { DomainError } from '../shared/workspace-contracts';
import type { Config } from '../shared/types';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();vi.restoreAllMocks();});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'workspace-search-')),store=openStore(home);
 const config:Config={version:2,projects:[{id:'p',name:'Billing 项目',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'Finance Agent',defaultCli:'codex',models:{},instructions:'private instructions',mcp:[],skills:[]}]};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home),assets=createAssets(store,createAssetFiles(home));
 cleanup.push(async()=>{await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
 const chat=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});store.updateConversation(chat.id,{title:'Azure 对账'});
 return {home,store,manager,config,assets,chat};
}
test('cross-object query uses Chinese and normalized English and compact DTOs',async()=>{
 const s=setup(),task=s.manager.taskService.createTask({userId:'local'},{goal:'Azure 对账任务',projectId:'p'},'create');
 const result=await searchWorkspace({...s,query:'ＡＺＵＲＥ 对账'});
 expect(new Set(result.map(r=>r.id))).toEqual(new Set([s.chat.id,task.id]));
 expect(result.every(r=>Object.keys(r).sort().join(',')==='href,id,kind,snippet,title')).toBe(true);
 expect((await searchWorkspace({...s,query:'finance'})).map(r=>r.kind)).toContain('agent');
 expect((await searchWorkspace({...s,query:'billing'})).map(r=>r.kind)).toContain('project');
});
test('conversations use only visible messages and never return transcript bodies',async()=>{
 const s=setup();s.store.appendEvent(s.chat.id,'user',{text:'invoice secret-body'});
 s.store.appendEvent(s.chat.id,'tool',{method:'item/completed',params:{item:{type:'commandExecution',text:'hidden-tool'}}});
 expect((await searchWorkspace({...s,query:'invoice'})).map(r=>r.id)).toContain(s.chat.id);
 expect(JSON.stringify(await searchWorkspace({...s,query:'invoice'}))).not.toContain('secret-body');
 expect(await searchWorkspace({...s,query:'hidden-tool'})).toEqual([]);
});
test('inaccessible conversation names and text cannot produce a match',async()=>{
 const s=setup();s.store.appendEvent(s.chat.id,'user',{text:'confidential'});
 vi.spyOn(s.manager,'authorizeConversationRead').mockImplementation(()=>{throw new DomainError('forbidden',403,'Denied');});
 expect(await searchWorkspace({...s,query:'Azure'})).toEqual([]);
 expect(await searchWorkspace({...s,query:'confidential'})).toEqual([]);
});
test('task source denial is checked before goal matching and snippets',async()=>{
 const s=setup(),task=s.manager.taskService.createTask({userId:'local'},{goal:'sensitive task goal'},'create');
 vi.spyOn(s.manager.taskService,'listRuns').mockImplementation(()=>{throw new DomainError('forbidden',403,'Denied source');});
 expect(await searchWorkspace({...s,query:'sensitive'})).toEqual([]);
 expect(s.manager.taskService.getTask({userId:'local'},task.id).id).toBe(task.id);
});
test('assets owned by another principal and retracted assets are excluded',async()=>{
 const s=setup();s.assets.createAsset({userId:'other'},{kind:'document',title:'private document',owner:{userId:'other'}});
 const visible=s.assets.createAsset({userId:'local'},{kind:'document',title:'公开资料',owner:{userId:'local'}});
 expect(await searchWorkspace({...s,query:'private document'})).toEqual([]);
 expect((await searchWorkspace({...s,query:'公开资料'}))[0]).toMatchObject({kind:'asset',id:visible.id,href:'/assets/'+visible.id});
});
test('authorized memory is findable with a record deep link and inactive records stay absent',async()=>{
 const s=setup(),memory=memoryServices(s.home,s.store).memory;
 memory.importLegacy({userId:'local'},[{id:'legacy',kind:'memory',title:'Preference',content:'账单审查惯例',scope:'global',status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]);
 const result=await searchWorkspace({...s,memoryRuntime:{memory} as any,query:'审查惯例'});
 expect(result).toHaveLength(1);expect(result[0].kind).toBe('memory');expect(result[0].href).toContain('recordId=');
 memory.retract({userId:'local'},{recordId:result[0].id,expectedRevision:1});
 expect(await searchWorkspace({...s,memoryRuntime:{memory} as any,query:'审查惯例'})).toEqual([]);
});
test('invalid or excessive query is rejected and blank search is bounded',async()=>{
 const s=setup();await expect(searchWorkspace({...s,query:'x'.repeat(2001)})).rejects.toMatchObject({status:422});
 expect((await searchWorkspace({...s,query:''})).length).toBeLessThanOrEqual(60);
});
test('kind filtering happens before bounded results so target pickers are not starved by many conversations',async()=>{
 const s=setup();for(let i=0;i<70;i++)s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 const task=s.manager.taskService.createTask({userId:'local'},{goal:'Pickable goal'},'target');
 expect(await searchWorkspace({...s,query:'',kind:'task'})).toEqual([expect.objectContaining({kind:'task',id:task.id})]);
});
test('a readable asset title is hidden when its published head depends on a revoked source',async()=>{
 const s=setup(),p={userId:'local'},files=createAssetFiles(s.home);
 const {writeFileSync}=await import('node:fs');writeFileSync(join(s.home,'source.txt'),'secret file body');
 const source=s.assets.createAsset(p,{kind:'document',title:'Source',owner:p});
 const staged=await files.stageFiles(p,null,[{allowedRoot:s.home,relativePath:'source.txt',manifestPath:'document.md'}]);
 const version=s.assets.publishAssetVersion(p,{assetId:source.id,expectedHeadVersionId:null,submissionId:staged.submissionId,files:staged.files,provenance:{sourceVersions:[]}},'source');
 const derived=s.assets.createAsset(p,{kind:'document',title:'Sensitive derived title',owner:p});
 const second=await files.stageFiles(p,null,[{allowedRoot:s.home,relativePath:'source.txt',manifestPath:'document.md'}]);
 s.assets.publishAssetVersion(p,{assetId:derived.id,expectedHeadVersionId:null,submissionId:second.submissionId,files:second.files,provenance:{sourceVersions:[{assetId:source.id,versionId:version.id}]}},'derived');
 expect((await searchWorkspace({...s,query:'sensitive'})).map(hit=>hit.id)).toContain(derived.id);
 s.assets.setLifecycle(p,source.id,'retracted',2);
 expect(await searchWorkspace({...s,query:'sensitive'})).toEqual([]);
});

test.each(['project','agent'] as const)('%s-only search never reads conversations, tasks, assets or memory',async kind=>{
 const s=setup();
 s.config.projects.push({...s.config.projects[0],id:'target',name:'Scope needle'});
 s.config.agents.push({...s.config.agents[0],id:'target',name:'Scope needle'});
 for(let i=0;i<50;i++){const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(chat.id,'user',{text:'synthetic history '+i});}
 const chats=vi.spyOn(s.store,'listConversations'),events=vi.spyOn(s.store,'listEvents'),tasks=vi.spyOn(s.manager.taskService,'listTasks');
 const reads=vi.spyOn(s.store.database,'prepare');
 const result=await searchWorkspace({...s,query:'needle',kind});
 expect(result).toEqual([expect.objectContaining({kind,id:'target'})]);
 expect(chats).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();expect(tasks).not.toHaveBeenCalled();
 expect(reads.mock.calls).toEqual([]);
});
test('conversation-only search reads authorized histories while avoiding task, asset and memory collection',async()=>{
 const s=setup();s.store.appendEvent(s.chat.id,'user',{text:'needle in history'});
 const denied=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});s.store.appendEvent(denied.id,'user',{text:'needle secret'});
 const authorize=s.manager.authorizeConversationRead.bind(s.manager);
 vi.spyOn(s.manager,'authorizeConversationRead').mockImplementation(id=>{if(id===denied.id)throw new DomainError('forbidden',403,'Denied');authorize(id);});
 const events=vi.spyOn(s.store,'listEvents'),tasks=vi.spyOn(s.manager.taskService,'listTasks'),reads=vi.spyOn(s.store.database,'prepare');
 expect(await searchWorkspace({...s,query:'needle',kind:'conversation'})).toEqual([expect.objectContaining({kind:'conversation',id:s.chat.id})]);
 expect(events.mock.calls.map(call=>call[0])).toEqual([s.chat.id]);expect(tasks).not.toHaveBeenCalled();
 expect(reads.mock.calls.map(call=>call[0]).filter(sql=>/FROM (assets|memory_)/i.test(sql))).toEqual([]);
});

test.each(['task','asset','memory'] as const)('%s-only search avoids unrelated category collection',async kind=>{
 const s=setup(),memory=memoryServices(s.home,s.store).memory;
 const task=s.manager.taskService.createTask({userId:'local'},{goal:'Scoped needle'},'scoped');
 const asset=s.assets.createAsset({userId:'local'},{kind:'document',title:'Scoped needle',owner:{userId:'local'}});
 memory.importLegacy({userId:'local'},[{id:'scope-memory',kind:'memory',title:'Scoped needle',content:'Scoped needle',scope:'global',status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]);
 const chats=vi.spyOn(s.store,'listConversations'),events=vi.spyOn(s.store,'listEvents'),tasks=vi.spyOn(s.manager.taskService,'listTasks'),memories=vi.spyOn(memory,'listAll'),reads=vi.spyOn(s.store.database,'prepare');
 const result=await searchWorkspace({...s,memoryRuntime:{memory} as any,query:'needle',kind});
 expect(result).toHaveLength(1);expect(result[0].kind).toBe(kind);
 if(kind==='task')expect(result[0].id).toBe(task.id);
 if(kind==='asset')expect(result[0].id).toBe(asset.id);
 expect(chats).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();
 if(kind!=='task')expect(tasks).not.toHaveBeenCalled();
 if(kind!=='memory')expect(memories).not.toHaveBeenCalled();
 if(kind==='task')expect(reads.mock.calls.some(call=>/FROM (assets|memory_)/i.test(call[0]))).toBe(false);
});
