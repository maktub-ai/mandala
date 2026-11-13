import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import {createMemoryRecall} from '../server/memory-recall';
const root={userId:'local'},actor={...root,agentId:'a'};
const homes:string[]=[],stores:ReturnType<typeof openStore>[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function setup(texts=['travels to Tokyo','cooks pasta']) {
 const home=mkdtempSync(join(tmpdir(),'memory-vectors-'));homes.push(home);const store=openStore(home);stores.push(store);
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local'});
 memory.importLegacy(root,texts.map((content,i)=>({id:`row-${i}`,kind:'memory' as const,title:'synthetic',content,scope:'agent' as const,agentId:'a',projectId:'p',status:'active' as const,access:{mode:'owner' as const},createdAt:'2020',updatedAt:'2020'})));
 return {home,store,memory};
}
const vector=(text:string)=>text.includes('Tokyo')||text.includes('日本')?[1,0]:[0,1];
test('real async retrieval generates and persists local semantic vectors, caches across recall instances',async()=>{
 const s=setup(),calls:string[][]=[];const embed=async(texts:string[])=>{calls.push(texts);return texts.map(vector);};
 const recall=createMemoryRecall(s.memory,{embed,model:'synthetic-embed'});
 expect(recall.search(actor,{projectId:'p',query:'日本旅行'}).items).toEqual([]);
 const result=await recall.hybridSearch(actor,{projectId:'p',query:'日本旅行'});
 expect(result.items.map(r=>r.text)).toEqual(['travels to Tokyo']);expect(result.items[0].reason).toContain('向量');expect(result.degraded).toBe(false);
 expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(2);
 await createMemoryRecall(s.memory,{embed,model:'synthetic-embed'}).hybridSearch(actor,{projectId:'p',query:'日本旅行'});
 expect(calls.flat().filter(x=>x.includes('Tokyo'))).toHaveLength(1);
});
test('same semantic content reuses embeddings despite evidence-only revision and new model gets its own cache',async()=>{
 const s=setup(['travels to Tokyo']),calls:string[][]=[];const embed=async(texts:string[])=>{calls.push(texts);return texts.map(vector);};
 const recall=createMemoryRecall(s.memory,{embed,model:'synthetic-one'});await recall.hybridSearch(actor,{projectId:'p',query:'日本'});
 const record=s.memory.list(actor,{projectId:'p'})[0];const changed={...record,revision:record.revision+1,contentHash:'evidence-updated'};
 s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify(changed),record.recordId);
 expect((await recall.hybridSearch(actor,{projectId:'p',query:'日本'})).items[0].revision).toBe(changed.revision);
 expect(calls.flat().filter(x=>x.includes('Tokyo'))).toHaveLength(1);
 await createMemoryRecall(s.memory,{embed,model:'synthetic-two'}).hybridSearch(actor,{projectId:'p',query:'日本'});
 expect(calls.flat().filter(x=>x.includes('Tokyo'))).toHaveLength(2);
});
test('only authorized active text reaches embed and awaited revoke or correction cannot return old text',async()=>{
 const s=setup(['travels to Tokyo']),seen:string[]=[];let revoke=false;
 const embed=async(texts:string[])=>{seen.push(...texts);if(revoke){const r=s.memory.list(root,{projectId:'p',status:'active'})[0];s.memory.retract(root,{recordId:r.recordId,expectedRevision:r.revision});}return texts.map(vector);};
 const recall=createMemoryRecall(s.memory,{embed,model:'synthetic'});
 expect((await recall.hybridSearch({...root,agentId:'b'},{projectId:'p',query:'日本'})).items).toEqual([]);expect(seen).toEqual([]);
 revoke=true;expect((await recall.hybridSearch(actor,{projectId:'p',query:'日本'})).items).toEqual([]);
 expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(0);
});
test('embedding failures and malformed vectors visibly fall back to BM25',async()=>{
 for(const embed of [async()=>{throw new Error('offline');},async(texts:string[])=>texts.map(()=>[0,0])]){
  const s=setup(['travels to Tokyo']),recall=createMemoryRecall(s.memory,{embed,model:'synthetic'});
  const result=await recall.hybridSearch(actor,{projectId:'p',query:'Tokyo'});
  expect(result.items[0].text).toContain('Tokyo');expect(result.degraded).toBe(true);expect(result.items[0].reason).toContain('降级');
 }
});
test('exact paths remain ahead of semantic distractors within eight-record budget',async()=>{
 const s=setup(['Change server/memory-store.ts carefully',...Array.from({length:12},(_,i)=>`semantic distractor ${i}`)]);
 const recall=createMemoryRecall(s.memory,{embed:async(texts)=>texts.map(text=>text==='server/memory-store.ts'?[1,0]:text.includes('memory-store.ts')?[0,1]:[1,0]),model:'synthetic'});
 const result=await recall.hybridSearch(actor,{projectId:'p',query:'server/memory-store.ts'});
 expect(result.items[0].text).toContain('server/memory-store.ts');expect(result.items).toHaveLength(8);expect(result.items[0].reason).toContain('精确');
});
test('bounded lazy indexing progresses until all authorized legacy rows are indexed',async()=>{
 const s=setup(Array.from({length:70},(_,i)=>`travels to Tokyo ${i}`)),recall=createMemoryRecall(s.memory,{embed:async(texts)=>texts.map(vector),model:'synthetic'});
 const first=await recall.hybridSearch(actor,{projectId:'p',query:'日本'});expect(first.indexLag).toBe(6);expect(first.degraded).toBe(true);
 const second=await recall.hybridSearch(actor,{projectId:'p',query:'日本'});expect(second.indexLag).toBe(0);expect(second.degraded).toBe(false);
});
test('oversized documents embed all bounded overlapping chunks instead of silently truncating the tail',async()=>{
 const tail='essential Tokyo tail',s=setup(['甲'.repeat(3000)+tail]),seen:string[]=[];
 const recall=createMemoryRecall(s.memory,{embed:async texts=>{seen.push(...texts);return texts.map(vector);},model:'synthetic'});
 await recall.hybridSearch(actor,{projectId:'p',query:'日本'});
 const documents=seen.filter(t=>t!=='日本');expect(documents.length).toBeGreaterThan(1);expect(documents.some(t=>t.includes(tail))).toBe(true);
 expect(documents.every(t=>Buffer.byteLength(t,'utf8')<1500)).toBe(true);
});
test('query-await correction and source permission revoke exclude cached vectors from retrieval',async()=>{
 const s=setup(['travels to Tokyo']),initial=createMemoryRecall(s.memory,{embed:async texts=>texts.map(vector),model:'synthetic'});
 await initial.hybridSearch(actor,{projectId:'p',query:'日本'});
 const recall=createMemoryRecall(s.memory,{embed:async texts=>{const r=s.memory.list(root,{projectId:'p'})[0];s.memory.correct(root,{recordId:r.recordId,expectedRevision:r.revision,text:'cooks pasta'});return texts.map(vector);},model:'synthetic'});
 const result=await recall.hybridSearch(actor,{projectId:'p',query:'日本'});expect(result.items).toEqual([]);expect(result.indexLag).toBe(1);
});
test('dimension mismatch degrades to lexical search without failing the caller',async()=>{
 const s=setup(['travels to Tokyo']),recall=createMemoryRecall(s.memory,{embed:async texts=>texts.map(t=>t==='Tokyo'?[1,0,0]:[1,0]),model:'synthetic'});
 const result=await recall.hybridSearch(actor,{projectId:'p',query:'Tokyo'});expect(result.degraded).toBe(true);expect(result.items[0].text).toContain('Tokyo');
});
test('changing validity or semantic scope creates a fresh vector key while retraction blocks old cached text',async()=>{
 const s=setup(['travels to Tokyo']),calls:string[][]=[],recall=createMemoryRecall(s.memory,{embed:async texts=>{calls.push(texts);return texts.map(vector);},model:'synthetic'});
 await recall.hybridSearch(actor,{projectId:'p',query:'日本'});const original=s.memory.list(actor,{projectId:'p'})[0];
 const changed={...original,validUntil:'2099-01-01T00:00:00Z'};s.store.database.prepare('UPDATE memory_records SET data=? WHERE id=?').run(JSON.stringify(changed),original.recordId);
 await recall.hybridSearch(actor,{projectId:'p',query:'日本'});expect(calls.flat().filter(t=>t.includes('Tokyo'))).toHaveLength(2);
 s.memory.retract(root,{recordId:original.recordId,expectedRevision:original.revision});expect((await recall.hybridSearch(actor,{projectId:'p',query:'日本'})).items).toEqual([]);
});
test('runtime background indexing advances old authorized data without a query or native generation',async()=>{
 const {createMemoryRuntime}=await import('../server/memory-runtime'),{readConfig}=await import('../server/config');
 const s=setup(Array.from({length:70},(_,i)=>`travels to Tokyo ${i}`)),config=(await readConfig(s.home)).config;
 let nativeCalls=0;const runtime=createMemoryRuntime({home:s.home,store:s.store,loadConfig:async()=>config,schedule:false,generate:async()=>{nativeCalls++;return '[]';},embed:async texts=>texts.map(vector)});
 try{runtime.start();await expect.poll(()=>s.store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()!.n,{timeout:7000}).toBe(64);
 await runtime.refreshVectors();expect(s.store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()!.n).toBe(70);expect(nativeCalls).toBe(0);
 }finally{await runtime.close();}
});
test('cached vectors cannot bypass source permission revoked during an awaited query',async()=>{
 const {DomainError}=await import('../shared/workspace-contracts'),{createMemoryJobs}=await import('../server/memory-jobs'),{createMemoryPipeline}=await import('../server/memory-pipeline'),{evidenceFixture}=await import('./memory-evidence-fixture');
 const s=setup([]),collection=s.memory.ensureCollection(root,{projectId:'p',agentId:'a'}),chat=s.store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null});
 s.store.appendEvent(chat.id,'user',{text:'请记住：以后用中文回答'});s.store.appendEvent(chat.id,'text',{text:'ok'});s.store.appendEvent(chat.id,'status',{status:'idle'});
 s.memory.captureConversation(root,{collectionId:collection.id,conversationId:chat.id,trigger:'explicit'});
 const jobs=createMemoryJobs(s.store,s.memory),pipeline=createMemoryPipeline(s.memory,jobs,{generate:evidenceFixture});let job=await pipeline.runNext('synthetic');while(job?.state==='queued'&&job.attempt===0)job=await pipeline.runNext('synthetic');
 const input={projectId:'p',query:'中文',layers:['L1' as const]};await createMemoryRecall(s.memory,{model:'synthetic',embed:async texts=>texts.map(()=>[1,0])}).hybridSearch(actor,input);
 const recall=createMemoryRecall(s.memory,{model:'synthetic',embed:async texts=>{s.memory.options.authorizeConversationRead=()=>{throw new DomainError('forbidden',403,'source_permission_revoked');};return texts.map(()=>[1,0]);}});
 expect((await recall.hybridSearch(actor,input)).items).toEqual([]);
});
test('persisted finite wrong-dimension cache is reported missing and rebuilt after restart',async()=>{
 const s=setup(['travels to Tokyo']),first=createMemoryRecall(s.memory,{model:'synthetic',embed:async texts=>texts.map(vector)});
 await first.hybridSearch(actor,{projectId:'p',query:'日本'});
 s.store.database.prepare('UPDATE memory_vectors SET vector=?').run('[1,0,0]');
 const unavailable=createMemoryRecall(s.memory,{model:'synthetic',embed:async()=>{throw new Error('offline');}});
 const broken=await unavailable.refreshVectors(actor,{projectId:'p'});expect(broken.indexLag).toBe(1);expect(broken.degraded).toBe(true);
 const restarted=createMemoryRecall(s.memory,{model:'synthetic',embed:async texts=>texts.map(vector)});
 expect(await restarted.refreshVectors(actor,{projectId:'p'})).toEqual({indexLag:0,degraded:false});
 const recovered=await restarted.hybridSearch(actor,{projectId:'p',query:'日本'});expect(recovered.items[0].text).toContain('Tokyo');expect(recovered.degraded).toBe(false);
});
test('shutdown waits for foreground recall paused in asynchronous authority revalidation',async()=>{
 const {createMemoryRuntime}=await import('../server/memory-runtime'),{readConfig}=await import('../server/config'),s=setup(['travels to Tokyo']),config=(await readConfig(s.home)).config;
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),paused=new Promise<void>(r=>release=r);
 const runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>{enter();await paused;return config;},embed:async texts=>texts.map(vector)});
 const search=runtime.recall.hybridSearch(root,{projectId:'p',query:'日本'});await entered;let closed=false;const closing=runtime.close().then(()=>{closed=true;});
 await new Promise(resolve=>setTimeout(resolve,10));expect(closed).toBe(false);release();await search;await closing;expect(closed).toBe(true);
});
test('mid-await reading disable excludes automatic recall while human library search stays available',async()=>{
 const {createMemoryRuntime}=await import('../server/memory-runtime'),{readConfig}=await import('../server/config'),s=setup(['travels to Tokyo']),config=(await readConfig(s.home)).config;
 config.system={cli:'codex',memory:{request:{generate:false,read:true},session:{generate:false,read:false},idleHours:6}};
 const runtime=createMemoryRuntime({home:s.home,store:s.store,schedule:false,loadConfig:async()=>config,embed:async texts=>{config.system!.memory!.request!.read=false;return texts.map(vector);}});
 try{await runtime.getSettings();expect((await runtime.recall.hybridSearch(root,{projectId:'p',query:'日本',kinds:['request']})).items).toEqual([]);
 expect((await runtime.recall.hybridSearch(root,{projectId:'p',query:'日本'})).items[0].text).toContain('Tokyo');}finally{await runtime.close();}
});

test('default retrieval uses keywords without any embedding request or degraded status',async()=>{
 const {vi}=await import('vitest'),s=setup(['travels to Tokyo']);
 const network=vi.fn(async()=>{throw new Error('No model service installed');});vi.stubGlobal('fetch',network);
 const recall=createMemoryRecall(s.memory),input={projectId:'p',query:'Tokyo'};
 try{
  const result=await recall.hybridSearch(actor,input);
  expect(result.items[0].text).toContain('Tokyo');expect(result.degraded).toBe(false);expect(result.indexLag).toBe(0);
  await recall.contextSearch(actor,input);
  await recall.turnContextSearch(actor,input,new AbortController().signal);
  await recall.refreshVectors(actor,{projectId:'p'});
  await recall.refreshGenerationVectors(actor,{projectId:'p'});
  const ranked=await recall.rankCandidates(actor,{records:s.memory.list(actor,{projectId:'p'}),query:'Tokyo',limit:5});
  expect(ranked.degraded).toBe(false);expect(network).not.toHaveBeenCalled();
 }finally{await recall.close();vi.unstubAllGlobals();}
});
