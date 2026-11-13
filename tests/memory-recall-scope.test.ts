import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createAssets } from '../server/assets';
import { createAssetFiles } from '../server/asset-files';
import { createTasks } from '../server/tasks';
import { createMemoryStore } from '../server/memory-store';
import { createMemoryRecall } from '../server/memory-recall';
import { DomainError } from '../shared/workspace-contracts';
import { fixtureMemoryEmbed } from './e2e/helpers/memory-embedding';

const root = { userId: 'local' }, cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function setup(embed:typeof fixtureMemoryEmbed=fixtureMemoryEmbed,denied=new Set<string>()) {
 const home=mkdtempSync(join(tmpdir(),'memory-recall-scope-')),store=openStore(home);
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets,resolve:(_p,task)=>({agentId:task.assigneeAgentId!,projectId:task.projectId,hostId:'local',input:task.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local',authorizeConversationRead:(_p,id)=>{if(denied.has(id))throw new DomainError('forbidden',403,'Source access revoked');}});
 const recall=createMemoryRecall(memory,{embed},()=>['request']);
 cleanup.push(async()=>{await recall.close();store.close();rmSync(home,{recursive:true,force:true});});
 const add=(agentId:string|null,text:string,contentType:'fact'|'preference'='fact',projectId:string|null=null)=>{
  const collection=memory.ensureCollection(root,{projectId,agentId}),chat=store.createConversation({projectId:projectId??'',agentId:agentId??'',cli:'codex',model:null});
  const event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});
  const source=memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];
  return memory.applyProposal(root,{collectionId:collection.id,layer:'L1',contentType,text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted',pipeline:'request'},collection.generation,'evidence_extract')!;
 };
 const global=add(null,'I prefer deployment checklists in Chinese.','preference'),own=add('a','Agent A deployment checklist is private.'),other=add('b','Agent B deployment checklist is private.');
 return {memory,recall,global,own,other,add,tasks};
}
for(const query of ['', 'deployment']){
 test(`${query||'blank'} context gives an agentless conversation only injectable global memory while owner inspection stays authorized`,async()=>{
  const s=setup(),result=await s.recall.contextSearch(root,{projectId:null,query,kinds:['request']});
  expect(result.items.map(r=>r.recordId)).toEqual([s.global.recordId]);
  expect(()=>s.memory.validateReferences(root,{projectId:null,items:result.items.map(r=>({recordId:r.recordId,revision:r.revision}))})).not.toThrow();
  expect(s.memory.read(root,s.own.recordId).recordId).toBe(s.own.recordId);
 });
 test(`${query||'blank'} context keeps the specified agent's own memory and excludes another agent's private memory`,async()=>{
  const s=setup(),principal={...root,agentId:'a'},result=await s.recall.contextSearch(principal,{projectId:null,query,kinds:['request']});
  expect(new Set(result.items.map(r=>r.recordId))).toEqual(new Set([s.global.recordId,s.own.recordId]));
  expect(result.items.map(r=>r.recordId)).not.toContain(s.other.recordId);
  expect(()=>s.memory.validateReferences(principal,{projectId:null,items:result.items.map(r=>({recordId:r.recordId,revision:r.revision}))})).not.toThrow();
 });
}

test.each(['search','hybridSearch'] as const)('%s owner library browsing retains authorized private memories',async method=>{
 const s=setup(),result=await s.recall[method](root,{projectId:null,query:'deployment'});
 expect(new Set(result.items.map(r=>r.recordId))).toEqual(new Set([s.global.recordId,s.own.recordId,s.other.recordId]));
});

test('project context retains valid project/global/own memory and Run authority rejects another project',async()=>{
 const s=setup(),project=s.add('a','Project P deployment checklist.','fact','p');
 s.add('a','Project Q deployment checklist.','fact','q');
 const agentless=await s.recall.contextSearch(root,{projectId:'p',query:'deployment',kinds:['request']});
 expect(new Set(agentless.items.map(r=>r.recordId))).toEqual(new Set([project.recordId,s.global.recordId]));
 const task=s.tasks.createTask(root,{goal:'Deployment work',projectId:'p',assigneeAgentId:'a'},'deployment-task');
 const run=s.tasks.startTask(root,task.id,task.revision,'deployment-run'),principal={...root,agentId:'a',runId:run.id};
 const result=await s.recall.contextSearch(principal,{projectId:'p',query:'deployment',kinds:['request']});
 expect(new Set(result.items.map(r=>r.recordId))).toEqual(new Set([project.recordId,s.global.recordId,s.own.recordId]));
 expect(()=>s.memory.validateReferences(principal,{projectId:'p',items:result.items.map(r=>({recordId:r.recordId,revision:r.revision}))})).not.toThrow();
 const wrongProject=await s.recall.contextSearch(principal,{projectId:'q',query:'deployment',kinds:['request']});
 expect(wrongProject.items).toEqual([]);
});

test('context search rechecks source access after awaited vector work',async()=>{
 let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;}),denied=new Set<string>();
 const s=setup(async texts=>{entered();await blocked;return fixtureMemoryEmbed(texts);},denied),principal={...root,agentId:'a'};
 const source=s.memory.source(root,s.own.evidence[0].sourceId);
 const work=s.recall.contextSearch(principal,{projectId:null,query:'deployment',kinds:['request']});
 await waiting;denied.add(source.conversationId!);release();
 const result=await work;expect(result.items.map(r=>r.recordId)).toEqual([s.global.recordId]);
 expect(()=>s.memory.validateReferences(principal,{projectId:null,items:result.items.map(r=>({recordId:r.recordId,revision:r.revision}))})).not.toThrow();
});

test('automatic turn recall uses one bounded query and retains authorized lexical matches on timeout', async () => {
 const {vi}=await import('vitest');
 const embed=vi.fn(fixtureMemoryEmbed),s=setup(embed),principal={...root,agentId:'a'};
 const input={projectId:null,query:'deployment',kinds:['request' as const]};
 await s.recall.refreshVectors(principal,input);
 embed.mockClear();
 embed.mockImplementation(() => new Promise(() => {}));
 const [facts,scenes]=await s.recall.turnContextSearch(principal,input,AbortSignal.timeout(30));
 expect(embed).toHaveBeenCalledTimes(1);
 expect(embed.mock.calls[0][0].every(text=>text.startsWith('task:'))).toBe(true);
 expect(facts.degraded).toBe(true);
 expect(new Set(facts.items.map(item=>item.recordId))).toEqual(new Set([s.global.recordId,s.own.recordId]));
 expect(scenes?.items).toEqual([]);
});
