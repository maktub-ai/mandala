import {DatabaseSync} from 'node:sqlite';
import {describe,it,expect} from 'vitest';
import {createMemoryScenes,buildSceneInstructions,buildProfileInstructions} from '../server/memory-scenes';
import type {MemoryStore} from '../server/memory-store';
import type {MemoryRevision} from '../shared/memory';
const fact=(id:string,revision=1):MemoryRevision=>({recordId:id,revision,collectionId:'c',layer:'L1',status:'active',text:'fact',semanticKey:id,contentType:'fact',dependencies:[],evidence:[],observedAt:null,effectiveFrom:'',validUntil:null,extractedAt:'',verification:'evidence_extract',taskId:null,conversationId:null,contentHash:'hash'});
const setup=()=>{const database=new DatabaseSync(':memory:');return {database,scenes:createMemoryScenes({store:{database},compatibleRevision:(ref:{revision:number},current:MemoryRevision)=>ref.revision===current.revision||current.revisionKind==='evidence_append'} as unknown as MemoryStore)};};
describe('durable scene scope cursor',()=>{
 it('does not consume on prepare, isolates collection, persists successful revisions',()=>{
 const {database,scenes}=setup();const a=fact('a');expect(scenes.prepare('c',[a]).newFacts).toEqual([a]);expect(scenes.prepare('c',[a]).newFacts).toEqual([a]);
 scenes.commit('c',[a],'now');expect(createMemoryScenes({store:{database},compatibleRevision:(ref:{revision:number},current:MemoryRevision)=>ref.revision===current.revision||current.revisionKind==='evidence_append'} as unknown as MemoryStore).prepare('c',[a]).newFacts).toEqual([]);
 expect(scenes.prepare('c',[fact('a',2)]).newFacts[0].revision).toBe(2);expect(scenes.prepare('other',[a]).newFacts).toEqual([]);
 });
 it('joins caller transaction so failed publication cannot consume facts',()=>{
 const {database,scenes}=setup();database.exec('BEGIN');scenes.commit('c',[fact('a')],'now');database.exec('ROLLBACK');expect(scenes.prepare('c',[fact('a')]).newFacts).toHaveLength(1);
 });
 it('rebuilds stale dependencies from current facts and omits session summaries',()=>{
 const {scenes}=setup();const a=fact('a');scenes.commit('c',[a],'now');
 const scene={...fact('s'),layer:'L2' as const,semanticKey:'scene.work',status:'stale' as const,dependencies:[{recordId:'a',revision:1}]};
 const result=scenes.prepare('c',[fact('a',2),scene,{...scene,recordId:'session',semanticKey:'session.context',status:'active'}]);
 expect(result.newFacts.map(r=>r.recordId)).toEqual(['a']);expect(result.scenes.map(r=>r.recordId)).toEqual(['s']);expect(result.index).not.toContain('session');
 });
 it('keeps revocation rebuild scenes even with no active fact and permits empty commit',()=>{
 const {scenes}=setup();const a=fact('a');scenes.commit('c',[a],'now');const stale={...fact('s'),layer:'L2' as const,semanticKey:'scene.work',status:'stale' as const,dependencies:[{recordId:'a',revision:1}]};const result=scenes.prepare('c',[{...a,revision:2,status:'retracted'},stale]);expect(result.newFacts).toEqual([]);expect(result.scenes).toEqual([stale]);scenes.commit('c',[],'later');expect(scenes.prepare('c',[a]).newFacts).toEqual([]);
 });
 it('triggers explicit/cold/recovery/50 new memories with durable profile cursor',()=>{
 const {scenes}=setup();const scene={...fact('s'),layer:'L2' as const,semanticKey:'scene.work'};
 expect(scenes.profileTrigger('c',[],true).should).toBe(true);expect(scenes.profileTrigger('c',[scene]).reason).toContain('冷启动');
 scenes.commit('c',[fact('a')],'now');scenes.profileCommitted('c',[fact('a'),scene],'now');expect(scenes.profileTrigger('c',[scene]).reason).toContain('恢复');
 const persona={...fact('p'),layer:'L3' as const};const facts=Array.from({length:50},(_,i)=>fact('new'+i));scenes.commit('c',facts,'later');
 expect(scenes.profileTrigger('c',[scene,persona,...facts]).reason).toContain('阈值');scenes.profileCommitted('c',[scene,persona,...facts],'later');expect(scenes.profileTrigger('c',[scene,persona,...facts]).should).toBe(false);
 });
 it('acknowledges consumed revoked facts on successful profile publication',()=>{
 const {scenes}=setup();const facts=Array.from({length:50},(_,i)=>fact('gone'+i));const scene={...fact('s'),layer:'L2' as const,semanticKey:'scene.work'};const persona={...fact('p'),layer:'L3' as const};scenes.commit('c',facts,'first');scenes.commit('c',[],'second');expect(scenes.profileTrigger('c',[scene,persona]).should).toBe(true);scenes.profileCommitted('c',[scene,persona],'profile');expect(scenes.profileTrigger('c',[scene,persona])).toEqual({should:false,reason:''});
 });
 it('never triggers profile without a valid active scene except explicit requests',()=>{
 const {scenes}=setup();const facts=Array.from({length:50},(_,i)=>fact('f'+i));scenes.commit('c',facts,'first');expect(scenes.profileTrigger('c',facts)).toEqual({should:false,reason:''});scenes.commit('c',[],'second');expect(scenes.profileTrigger('c',facts)).toEqual({should:false,reason:''});expect(scenes.profileTrigger('c',facts,true).should).toBe(true);
 });
 it('does not rebuild consumed evidence-only appends with compatible scene anchors',()=>{
 const {scenes}=setup();const current={...fact('a',2),revisionKind:'evidence_append' as const};const scene={...fact('s'),layer:'L2' as const,semanticKey:'scene.work',dependencies:[{recordId:'a',revision:1}]};scenes.commit('c',[current,scene],'now');expect(scenes.prepare('c',[current,scene]).newFacts).toEqual([]);expect(scenes.prepare('c',[{...current,revisionKind:'correction'},scene]).newFacts).toEqual([{...current,revisionKind:'correction'}]);
 });
 it('retains full upstream narrative and work doctrine in proposal adaptation',()=>{expect(buildSceneInstructions()).toContain('Create');expect(buildSceneInstructions()).toContain('MemoryProposal');expect(buildProfileInstructions()).toContain('Operating Doctrine');});
});
