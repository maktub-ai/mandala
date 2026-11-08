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
import {summarizeMemoryHit} from '../server/memory-presentation';
import type {MemoryHit} from '../shared/memory';

const root={userId:'local'},reader={...root,agentId:'a'},cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
function setup(texts:string[]) {
 const home=mkdtempSync(join(tmpdir(),'memory-search-summaries-')),store=openStore(home);
 const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local'});
 memory.importLegacy(root,texts.map((content,i)=>({id:`summary-${i}`,kind:'memory' as const,title:'Historical note',content,scope:'agent' as const,agentId:'a',projectId:'p',status:'active' as const,access:{mode:'owner' as const},createdAt:'2026-01-01',updatedAt:'2026-01-01'})));
 const recall=createMemoryRecall(memory,{model:'synthetic',embed:async()=>{throw new Error('offline');}});
 cleanups.push(async()=>{await recall.close();store.close();rmSync(home,{recursive:true,force:true});});
 return {memory,recall};
}

test('Agent context can discover an oversized memory and then read its complete authorized revision',async()=>{
 const text='背景。'.repeat(2500)+' Deployment uses server/deploy-policy.ts and requires a review.',s=setup([text]);
 const result=await s.recall.contextSearch(reader,{projectId:'p',query:'server/deploy-policy.ts'});
 expect(result.items).toHaveLength(1);
 expect(s.memory.read(reader,result.items[0].recordId,'p').text).toBe(text);
 expect(result.items[0].text).toBe(text);
 expect(result.degraded).toBe(true);
 expect(s.recall.search(reader,{projectId:'p',query:'server/deploy-policy.ts'}).items).toEqual([]);
});

test('search presents a bounded Unicode-safe excerpt around the matched detail with time and verification',()=>{
 const text='开头🧭'.repeat(300)+' The DEPLOYMENT policy requires human review. '+'尾部🧭'.repeat(300);
 const hit:MemoryHit={recordId:'record',revision:3,collectionId:'collection',layer:'L1',contentType:'constraint',text,status:'active',evidence:[{sourceId:'source',sourceRevision:1},{sourceId:'source',sourceRevision:2}],dependencies:[],observedAt:'2026-11-01',effectiveFrom:'2026-11-02',validUntil:null,extractedAt:'2026-11-02',verification:'user_confirmation',taskId:null,conversationId:null,contentHash:'hash',reason:'keyword'};
 const summary=summarizeMemoryHit(hit,'check deployment policy',100);
 expect(summary).toMatchObject({recordId:'record',revision:3,excerpt:expect.stringContaining('DEPLOYMENT policy requires human review.'),truncated:true,sourceCount:1,observedAt:'2026-11-01',effectiveFrom:'2026-11-02',verification:'user_confirmation'});
 expect(summary.excerpt.startsWith('…')).toBe(true);expect(summary.excerpt.endsWith('…')).toBe(true);
 expect(Array.from(summary.excerpt).length).toBeLessThanOrEqual(100);expect(Buffer.from(summary.excerpt,'utf8').toString('utf8')).toBe(summary.excerpt);
 expect(summary).not.toHaveProperty('text');expect(summary).not.toHaveProperty('evidence');expect(summary).not.toHaveProperty('dependencies');
 expect(summarizeMemoryHit({...hit,text:'需要审阅。'},'review')).toMatchObject({excerpt:'需要审阅。',truncated:false});
});

test('a natural Chinese query finds a relevant excerpt beyond the start of a long record',()=>{
 const s=setup(['背景。'.repeat(300)+'部署策略要求先审阅再执行。'+'附录。'.repeat(300)]);
 const hit={...s.memory.list(reader,{projectId:'p'})[0],reason:'keyword'};
 expect(summarizeMemoryHit(hit,'请查一下之前的部署策略',100).excerpt).toContain('部署策略要求先审阅再执行。');
});

test('context search budgets the serialized summaries while retaining complete internal records and scope',async()=>{
 const texts=Array.from({length:12},(_,i)=>'说明。'.repeat(2100)+` Policy ${i} uses server/deploy-policy.ts. `+'附录。'.repeat(100)),s=setup(texts);
 const query='server/deploy-policy.ts',result=await s.recall.contextSearch(reader,{projectId:'p',query});
 expect(result.items.length).toBeGreaterThan(1);expect(result.items.length).toBeLessThanOrEqual(8);
 expect(Array.from(JSON.stringify(result.items.map(hit=>summarizeMemoryHit(hit,query)))).length).toBeLessThanOrEqual(6000);
 expect(result.items.every(hit=>hit.text.length>6000)).toBe(true);
 expect((await s.recall.contextSearch({...root,agentId:'b'},{projectId:'p',query})).items).toEqual([]);
 const removed=result.items[0];s.memory.retract(root,{recordId:removed.recordId,expectedRevision:removed.revision});
 expect((await s.recall.contextSearch(reader,{projectId:'p',query})).items.map(hit=>hit.recordId)).not.toContain(removed.recordId);
});
