import {historicalConfirmation} from './historical-memory-fixture';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { MEMORY_CUTOVER, memoryServices } from '../server/memory-runtime';
import { createMemoryPipeline } from '../server/memory-pipeline';
import type { MemoryProposal } from '../shared/memory';
import type { Config } from '../shared/types';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-confirmation-')),store=openStore(home),services=memoryServices(home,store),root={userId:'local'};
 store.database.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(MEMORY_CUTOVER,new Date().toISOString());
 const config:Config={version:2,projects:[{id:'p',name:'ERP',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'ERP Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]};
 services.memory.importLegacy(root,[{id:'old-l3',kind:'memory',level:'L3',title:'核对数据链路',content:'核对数据链路时区分执行成功和目标表真实入库。',scope:'agent',agentId:'a',projectId:'p',status:'candidate',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z'}]);
 const record=services.memory.listAll(root)[0];
 cleanup.push(async()=>{await services.recall.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {home,store,config,root,record,...services};
}
test.each(['confirm','edit'] as const)('automatic layer summaries do not silently replace %s-confirmed legacy context',action=>{
 const s=setup(),confirmed=action==='confirm'?historicalConfirmation(s.memory,s.root,{recordId:s.record.recordId,expectedRevision:1}):historicalConfirmation(s.memory,s.root,{recordId:s.record.recordId,expectedRevision:1},'user_correction','核对入库质量并提供证据。');
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),text='核对数据质量。';
 const event=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(s.root,{collectionId:confirmed.collectionId,conversationId:chat.id,trigger:'explicit'}).sources[0];
 const c=s.memory.collection(s.root,confirmed.collectionId),proposal={collectionId:c.id,layer:'L1' as const,contentType:'fact' as const,text,operation:'store' as const,replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted' as const};
 const fact=s.memory.applyProposal(s.root,proposal,c.generation,'evidence_extract')!;
 const candidate=s.memory.applyProposal(s.root,{...proposal,layer:'L1',contentType:'procedure',operation:'update',replaces:[{recordId:confirmed.recordId,revision:confirmed.revision}],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},c.generation,'evidence_extract')!;
 expect(candidate.status).toBe('proposed');expect(s.memory.read(s.root,confirmed.recordId)).toMatchObject({status:'active',revision:confirmed.revision,text:confirmed.text});
});
test('automatic extraction merge cannot treat missing legacy evidence as permission to replace confirmed L1',()=>{
 const s=setup();
 s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'old-l1',level:'L1',content:'当前目标表需要回读。'}]);
 const old=s.memory.listAll(s.root).find(r=>r.legacyId==='old-l1')!,confirmed=historicalConfirmation(s.memory,s.root,{recordId:old.recordId,expectedRevision:1});
 const chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null}),text='当前目标表还需要核对质量。';
 const event=s.store.appendEvent(chat.id,'user',{text});s.store.appendEvent(chat.id,'status',{status:'idle'});
 const source=s.memory.captureConversation(s.root,{collectionId:confirmed.collectionId,conversationId:chat.id,trigger:'explicit'}).sources[0],c=s.memory.collection(s.root,confirmed.collectionId);
 const candidate=s.memory.applyProposal(s.root,{collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'merge',replaces:[{recordId:confirmed.recordId,revision:confirmed.revision}],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'user_asserted'},c.generation,'evidence_extract')!;
 expect(candidate.status).toBe('proposed');expect(s.memory.read(s.root,confirmed.recordId)).toMatchObject({status:'active',revision:confirmed.revision});
});

test('several confirmed rules consolidate into one current persona with revisioned dependencies',async()=>{
 const s=setup();
 s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'second-rule',content:'使用工具前验证当前路由。'}]);
 for(const r of s.memory.listAll(s.root))historicalConfirmation(s.memory,s.root,{recordId:r.recordId,expectedRevision:r.revision});
 expect(s.memory.listAll(s.root,{status:'active'}).filter(r=>r.layer==='L3')).toHaveLength(0);
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return input.drafts!;
  const parents=input.records.filter(r=>r.layer===(input.stage==='scene'?'L1':'L2'));
  const prior=input.records.find(r=>r.semanticKey===(input.stage==='scene'?'scene.work':'persona.operating-doctrine'));
  const p:MemoryProposal={collectionId:input.job.collectionId,layer:input.stage==='scene'?'L2':'L3',contentType:'procedure',semanticKey:input.stage==='scene'?'scene.work':'persona.operating-doctrine',text:parents.map(r=>r.text).join('\n'),operation:prior?'update':'store',replaces:prior?[{recordId:prior.recordId,revision:prior.revision}]:[],evidence:[],dependencies:parents.map(({recordId,revision})=>({recordId,revision})),support:[],validUntil:null,certainty:'observed'};
  return [p];
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',state:'completed',error:null});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'profile',state:'completed',error:null});
 const records=s.memory.listAll(s.root,{status:'active'}),persona=records.find(r=>r.layer==='L3')!;
 expect(records.filter(r=>r.layer==='L3')).toHaveLength(1);
 expect(persona).toMatchObject({semanticKey:'persona.operating-doctrine',evidence:[],verification:'layer_summary'});
 const scene=s.memory.read(s.root,persona.dependencies[0].recordId);
 expect(scene.dependencies).toEqual(expect.arrayContaining(records.filter(r=>r.layer==='L1').map(({recordId,revision})=>({recordId,revision}))));
 s.memory.retract(s.root,{recordId:scene.dependencies[0].recordId,expectedRevision:scene.dependencies[0].revision});
 expect(s.memory.list({...s.root,agentId:'a'},{projectId:'p',status:'active',layer:'L3'})).toEqual([]);
});
test('startup repairs only mistakenly promoted legacy rules and preserves approval, history and ACL',()=>{
 const s=setup(),confirmed=historicalConfirmation(s.memory,s.root,{recordId:s.record.recordId,expectedRevision:1});
 const promoted={...confirmed,layer:'L3' as const};
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify(promoted),confirmed.recordId);
 s.store.database.prepare('UPDATE memory_revisions SET data=? WHERE record_id=? AND revision=?').run(JSON.stringify(promoted),confirmed.recordId,confirmed.revision);
 const asset=s.memory.options.assets.getAuthorizedAsset(s.root,confirmed.collectionId);
 expect(s.memory.repairLegacyContexts(s.root)).toEqual({repaired:1});
 const repaired=s.memory.read(s.root,confirmed.recordId);
 expect(repaired).toMatchObject({layer:'L1',revision:3,status:'active',verification:'user_confirmation',text:confirmed.text,legacy:confirmed.legacy});
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_revisions WHERE record_id=? AND revision=2').get(confirmed.recordId)!.data as string)).toEqual(promoted);
 expect(s.memory.options.assets.getAuthorizedAsset(s.root,confirmed.collectionId)).toEqual(asset);
 expect(s.memory.repairLegacyContexts(s.root)).toEqual({repaired:0});
});
test('unconfirmed evidence-free legacy rules cannot authorize generated layers',()=>{
 const s=setup(),r=s.record;
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify({...r,status:'active'}),r.recordId);
 expect(()=>s.memory.applyProposal(s.root,{collectionId:r.collectionId,layer:'L2',contentType:'procedure',semanticKey:'scene.work',text:r.text,operation:'store',replaces:[],evidence:[],dependencies:[{recordId:r.recordId,revision:r.revision}],validUntil:null,certainty:'observed'},s.memory.collection(s.root,r.collectionId).generation,'layer_summary')).toThrow('unsupported_summary');
});
test('identical source-free summaries retain newly confirmed rule dependencies and invalidate older derived context',()=>{
 const s=setup(),first=historicalConfirmation(s.memory,s.root,{recordId:s.record.recordId,expectedRevision:1});
 const proposal:MemoryProposal={collectionId:first.collectionId,layer:'L2',contentType:'procedure',text:first.text,semanticKey:'scene.work',operation:'store',replaces:[],evidence:[],dependencies:[{recordId:first.recordId,revision:first.revision}],validUntil:null,certainty:'observed',pipeline:'request'};
 const scene=s.memory.applyProposal(s.root,proposal,s.memory.collection(s.root,first.collectionId).generation,'layer_summary')!;
 const profileCollection=s.memory.ensureCollection(s.root,{projectId:'p',agentId:'a'});
 const persona=s.memory.applyProposal(s.root,{...proposal,collectionId:profileCollection.id,layer:'L3',semanticKey:'persona.operating-doctrine',dependencies:[{recordId:scene.recordId,revision:scene.revision}]},profileCollection.generation,'layer_summary',{profileScope:{projectId:'p',agentId:'a'}})!;
 s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'same-rule-new-source',content:first.text}]);
 const candidate=s.memory.listAll(s.root).find(r=>r.legacyId==='same-rule-new-source')!,second=historicalConfirmation(s.memory,s.root,{recordId:candidate.recordId,expectedRevision:1});
 const updated=s.memory.applyProposal(s.root,{...proposal,operation:'update',replaces:[{recordId:scene.recordId,revision:scene.revision}],dependencies:[...proposal.dependencies!,{recordId:second.recordId,revision:second.revision}]},s.memory.collection(s.root,first.collectionId).generation,'layer_summary')!;
 expect(updated.dependencies).toEqual(expect.arrayContaining([{recordId:first.recordId,revision:first.revision},{recordId:second.recordId,revision:second.revision}]));
 expect(updated.revision).toBe(scene.revision+1);
 expect(JSON.parse(s.store.database.prepare('SELECT data FROM memory_records WHERE id=?').get(persona.recordId)!.data as string).status).toBe('stale');
});
test('confirmation consolidation skips unsupported legacy facts without changing their state or scope',async()=>{
 const s=setup();s.memory.importLegacy(s.root,[{...s.record.legacy!,id:'active-unreviewed',content:'Unreviewed legacy claim',status:'active'}]);
 const unreviewed=s.memory.listAll(s.root).find(r=>r.legacyId==='active-unreviewed')!;
 historicalConfirmation(s.memory,s.root,{recordId:s.record.recordId,expectedRevision:1});
 const pipeline=createMemoryPipeline(s.memory,s.jobs,{verifyOutput:true,generate:async input=>{
  if(input.stage==='verify')return input.drafts!;
  expect(input.records.some(r=>r.recordId===unreviewed.recordId)).toBe(false);
  const parents=input.records.filter(r=>r.layer===(input.stage==='scene'?'L1':'L2'));
  return [{collectionId:input.job.collectionId,layer:input.stage==='scene'?'L2':'L3',contentType:'procedure',text:parents.map(r=>r.text).join('\n'),semanticKey:input.stage==='scene'?'scene.work':'persona.operating-doctrine',operation:'store',replaces:[],evidence:[],dependencies:parents.map(({recordId,revision})=>({recordId,revision})),validUntil:null,certainty:'observed'}];
 }});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'scene',state:'completed',error:null});
 expect(await pipeline.runNext('w')).toMatchObject({stage:'profile',state:'completed',error:null});
 expect(s.memory.read(s.root,unreviewed.recordId)).toEqual(unreviewed);
 expect(s.memory.listAll(s.root,{status:'active'}).filter(r=>r.layer==='L3')).toHaveLength(1);
});
