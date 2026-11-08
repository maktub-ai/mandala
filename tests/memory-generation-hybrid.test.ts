import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig} from '../server/config';
import {createMemoryPipeline} from '../server/memory-pipeline';
import {createMemoryRuntime} from '../server/memory-runtime';
import type {MemoryProposal} from '../shared/memory';
import {DomainError} from '../shared/workspace-contracts';
import type {SystemGenerator} from '../server/system-tasks';
const root={userId:'local'},cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers();for(const fn of cleanup.splice(0))await fn();});
async function setup(texts=['travels to Tokyo']){
 const home=mkdtempSync(join(tmpdir(),'memory-generation-hybrid-')),store=openStore(home),config=(await readConfig(home)).config;
 config.system={cli:'codex',memory:{request:{generate:true,read:false},session:{generate:false,read:false}}};
 const embed=vi.fn(async(texts:string[])=>texts.map(t=>t.includes('Tokyo')||t.includes('日本')?[1,0]:[0,1]));
 const denied=new Set<string>(),generate=vi.fn<SystemGenerator>(async()=> '[]'),runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,embed,generate,schedule:false,verifyOutput:false,authorizeConversationRead:(_p,id)=>{if(denied.has(id))throw new DomainError('forbidden',403,'synthetic source permission revoked');}});
 cleanup.push(async()=>{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 const c=runtime.memory.ensureCollection(root,{projectId:null,agentId:null});
 const capture=(text:string)=>{const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null}),event=store.appendEvent(chat.id,'user',{text});store.appendEvent(chat.id,'status',{status:'idle'});const source=runtime.memory.captureConversation(root,{collectionId:c.id,conversationId:chat.id,trigger:'explicit',kind:'request'}).sources[0];return {source,event,chat};};
 const old=capture(texts.join('\n'));
 const proposal=(text:string,source=old.source,event=old.event):MemoryProposal=>({collectionId:c.id,layer:'L1',contentType:'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],support:[{sourceId:source.id,eventId:event.id,quote:text}],validUntil:null,certainty:'observed',pipeline:'request'});
 const facts=texts.map(text=>runtime.memory.applyProposal(root,proposal(text),c.generation,'evidence_extract')!);
 store.database.prepare('DELETE FROM memory_jobs').run();
 const incoming=capture('日本旅行'),atom=proposal('日本旅行',incoming.source,incoming.event),job=runtime.jobs.list(root)[0];
 store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...job,inputVersion:'text-v1',stage:'conflict'}),job.id);
 store.database.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?)').run(job.id,JSON.stringify({atoms:[atom],nextAtom:0}));
 return {home,store,config,embed,generate,runtime,c,facts,incoming,job,atom,denied,old};
}
const promptData=(prompt:string)=>JSON.parse(prompt.split('SOURCE_JSON:\n')[1].split('\nEND_SOURCE_JSON')[0]);
test('generator supplied-pool hook shares cache, bypasses read switches, and preserves five semantic candidates',async()=>{
 const s=await setup(Array.from({length:9},(_,i)=>`travels to Tokyo ${i}`));
 await s.runtime.recall.refreshVectors(root,{projectId:null});s.embed.mockClear();
 const ranked=await s.runtime.recall.rankCandidates(root,{records:s.facts,query:'日本旅行',limit:5});
 expect(ranked.degraded).toBe(false);expect(ranked.candidates).toHaveLength(5);expect(s.embed.mock.calls.flat(2).every(t=>t.startsWith('task:'))).toBe(true);
 await s.runtime.drain();expect(s.generate).toHaveBeenCalledOnce();expect(promptData(s.generate.mock.calls[0][1]).records).toHaveLength(5);
});
test('cold and provider-failed generation pools visibly degrade to BM25 without dropping lexical hits',async()=>{
 const s=await setup(Array.from({length:70},(_,i)=>`Tokyo candidate ${i}`));
 const cold=await s.runtime.recall.rankCandidates(root,{records:s.facts,query:'Tokyo',limit:15});
 expect(cold).toMatchObject({indexLag:70,degraded:true});expect(cold.candidates).toHaveLength(15);expect(s.embed).not.toHaveBeenCalled();
 await s.runtime.recall.refreshVectors(root,{projectId:null});await s.runtime.recall.refreshVectors(root,{projectId:null});
 s.embed.mockRejectedValue(new Error('offline'));
 const failed=await s.runtime.recall.rankCandidates(root,{records:s.facts,query:'Tokyo',limit:15});expect(failed.degraded).toBe(true);expect(failed.candidates).toHaveLength(15);
});
test('warm generation pool retains exact identifier pins ahead of semantic distractors',async()=>{
 const s=await setup(['Change server/memory-store.ts carefully',...Array.from({length:16},(_,i)=>`travels to Tokyo ${i}`)]);
 await s.runtime.recall.refreshVectors(root,{projectId:null});
 const ranked=await s.runtime.recall.rankCandidates(root,{records:s.facts,query:'server/memory-store.ts 日本',limit:15});
 expect(ranked.candidates).toHaveLength(15);expect(ranked.candidates[0].reason).toBe('exact');expect(ranked.candidates[0].record.text).toContain('memory-store.ts');
});
test.each(['generate_off','close','lease','generation','source_change','source_retract','record_retract','record_change','permission'])('candidate await fences %s before native call or publication',async mutation=>{
 const s=await setup();await s.runtime.recall.refreshVectors(root,{projectId:null});
 let release!:(value:number[][])=>void;s.embed.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const pending=s.runtime.drain();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));let closing:Promise<void>|undefined;
 if(mutation==='generate_off')s.config.system!.memory!.request!.generate=false;
 if(mutation==='close')closing=s.runtime.close();
 if(mutation==='lease'){const row=s.runtime.jobs.list(root)[0];s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...row,leaseToken:row.leaseToken+1}),row.id);}
 if(mutation==='generation')s.store.database.prepare('UPDATE memory_collections SET data=? WHERE id=?').run(JSON.stringify({...s.c,generation:s.c.generation+1}),s.c.id);
 if(mutation==='source_change'){const source=s.incoming.source;s.store.database.prepare('UPDATE memory_sources SET data=? WHERE id=?').run(JSON.stringify({...source,revision:source.revision+1}),source.id);}
 if(mutation==='source_retract')s.runtime.memory.retractSource(root,{sourceId:s.incoming.source.id,expectedRevision:1});
 if(mutation==='record_retract')s.runtime.memory.retract(root,{recordId:s.facts[0].recordId,expectedRevision:1});
 if(mutation==='record_change')s.runtime.memory.correct(root,{recordId:s.facts[0].recordId,expectedRevision:1,text:'cooks pasta'});
 if(mutation==='permission')s.denied.add(s.old.chat.id);
 release([[1,0]]);await pending;await closing;
 expect(s.generate).not.toHaveBeenCalled();expect(s.runtime.memory.listAll(root).some(r=>r.text==='日本旅行')).toBe(false);
});

test('background generation indexing works with reads off and automatic recall stays disabled',async()=>{
 const s=await setup();expect(await s.runtime.refreshVectors()).toMatchObject({indexLag:0,degraded:false});
 expect(s.embed).toHaveBeenCalled();const ranked=await s.runtime.recall.rankCandidates(root,{records:s.facts,query:'日本旅行',limit:5});expect(ranked.degraded).toBe(false);expect(ranked.candidates[0].record.recordId).toBe(s.facts[0].recordId);
 expect((await s.runtime.recall.hybridSearch(root,{projectId:null,query:'日本旅行',kinds:['request']})).items).toEqual([]);
});
test('scene generator keeps fifteen blocks within twelve thousand characters and retained dependencies',async()=>{
 const s=await setup(['日本旅行']),fact=s.facts[0];
 const blocks=Array.from({length:18},(_,i)=>s.runtime.memory.applyProposal(root,{...s.atom,layer:'L2',text:'travels to Tokyo '+i+' '+ 'x'.repeat(900),semanticKey:'scene.synthetic'+i,evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!);
 await s.runtime.refreshVectors();s.generate.mockClear();
 s.store.database.prepare('UPDATE memory_jobs SET data=? WHERE id=?').run(JSON.stringify({...s.job,stage:'scene',inputVersion:'text-v1'}),s.job.id);
 await s.runtime.drain();expect(s.generate).toHaveBeenCalledOnce();const data=promptData(s.generate.mock.calls[0][1]),provided=data.records.filter((r:any)=>r.layer==='L2');
 expect(provided.length).toBeGreaterThan(8);expect(provided.length).toBeLessThanOrEqual(15);expect(provided.reduce((sum:number,r:any)=>sum+r.text.length,0)).toBeLessThanOrEqual(12000);
 const canonicalId=(ref:any)=>typeof ref.recordId==='string'?ref.recordId:data.referenceDictionary.r[ref.recordId.r];
 expect(provided.every((r:any)=>blocks.some(block=>block.recordId===canonicalId(r)))).toBe(true);expect(data.retainedDependencies.map((ref:any)=>({...ref,recordId:canonicalId(ref)}))).toContainEqual({recordId:fact.recordId,revision:fact.revision});
});
test('provider timeout degrades to lexical candidates while genuine generation deadline cancels publication',async()=>{
 const s=await setup(['Tokyo travel']),records=s.facts;await s.runtime.refreshVectors();let release!:(value:number[][])=>void;s.embed.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 vi.useFakeTimers();const pending=s.runtime.recall.rankCandidates(root,{records,query:'Tokyo',limit:5});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await vi.advanceTimersByTimeAsync(15001);
 expect(await pending).toMatchObject({degraded:true,indexLag:0,candidates:[expect.objectContaining({reason:'bm25'})]});release([[1,0]]);await Promise.resolve();expect(s.generate).not.toHaveBeenCalled();
 const pipeline=createMemoryPipeline(s.runtime.memory,s.runtime.jobs,{timeoutMs:10,rankCandidates:(records,query,limit,signal,revalidate)=>s.runtime.recall.rankCandidates(root,{records,query,limit,signal,revalidate}),generate:async()=>{throw new Error('native must not run');}});
 const run=pipeline.runNext('synthetic-deadline');await vi.advanceTimersByTimeAsync(11);expect(await run).toMatchObject({error:expect.stringMatching(/generation_timed_out|memory_generation_cancelled/)});
 expect(s.runtime.memory.listAll(root).some(r=>r.text==='日本旅行')).toBe(false);
});
test('legacy project pool uses actual caller project authority and rejects another agent',async()=>{
 const s=await setup();s.config.projects=[{id:'p',name:'Synthetic project',agentIds:['a','b'],cwd:'.',resources:[],mcp:[],skills:[]}];await s.runtime.getSettings();
 s.runtime.memory.importLegacy(root,[{id:'synthetic-legacy',kind:'memory',title:'synthetic',content:'travels to Tokyo',scope:'agent',agentId:'a',projectId:'p',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'}]);
 const records=s.runtime.memory.list({...root,agentId:'a'},{projectId:'p'});await s.runtime.recall.refreshVectors({...root,agentId:'a'},{projectId:'p'});
 expect((await s.runtime.recall.rankCandidates({...root,agentId:'a'},{records,query:'日本旅行',limit:5})).candidates).toHaveLength(1);
 await expect(s.runtime.recall.rankCandidates({...root,agentId:'b'},{records,query:'日本旅行',limit:5})).rejects.toThrow();
});
test('long scene generation keeps lexical relevance and cross-word semantics at weak positive cosine',async()=>{
 const s=await setup(['Tokyo travel context']),fact=s.facts[0];
 const scene=s.runtime.memory.applyProposal(root,{...s.atom,layer:'L2',text:'Tokyo travel planning and destination notes. '+ 'Background context for the trip. '.repeat(100),semanticKey:'scene.trip',evidence:fact.evidence,support:[],dependencies:[{recordId:fact.recordId,revision:fact.revision}]},s.c.generation,'layer_summary')!;
 const cold=await s.runtime.recall.rankCandidates(root,{records:[scene],query:'Tokyo itinerary',limit:15});expect(cold.candidates[0].reason).toBe('bm25');
 s.embed.mockImplementation(async texts=>texts.map(text=>text.startsWith('task:')?[1,0]:[0.3,Math.sqrt(0.91)]));await s.runtime.refreshVectors();
 for(const query of ['Tokyo itinerary','日本観光計画']){
  const result=await s.runtime.recall.rankCandidates(root,{records:[scene],query,limit:15});expect(result.degraded).toBe(false);expect(result.candidates.map(c=>c.record.recordId)).toContain(scene.recordId);
  expect((await s.runtime.recall.hybridSearch(root,{projectId:null,query})).items).toEqual([]);
 }
});
