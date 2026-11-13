import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createAssets} from '../server/assets';
import {createAssetFiles} from '../server/asset-files';
import {createTasks} from '../server/tasks';
import {createMemoryStore} from '../server/memory-store';
import {createMemoryRecall} from '../server/memory-recall';
import {fixtureMemoryEmbed} from './e2e/helpers/memory-embedding';
afterEach(()=>vi.unstubAllGlobals());
test('UI embedding fixture exercises healthy async persistent retrieval without an external provider',async()=>{
 const fetch=vi.fn(()=>{throw Error('Unexpected external fixture dependency');});vi.stubGlobal('fetch',fetch);
 const home=mkdtempSync(join(tmpdir(),'e2e-memory-embedding-')),store=openStore(home),root={userId:'local'};
 try{
  const assets=createAssets(store,createAssetFiles(home)),tasks=createTasks(store,{assets}),memory=createMemoryStore(store,{assets,tasks,localUserId:'local'});
  memory.importLegacy(root,['Weekly personal reading plan','Database backup rotation'].map((content,i)=>({id:'fixture-'+i,kind:'memory' as const,title:'synthetic',content,scope:'global' as const,status:'active' as const,access:{mode:'owner' as const},createdAt:'2020',updatedAt:'2020'})));
  const embed=vi.fn(fixtureMemoryEmbed),recall=createMemoryRecall(memory,{embed});
  const result=await recall.hybridSearch(root,{projectId:null,query:'Recall the weekly personal reading plan'});
  expect(result.degraded).toBe(false);expect(result.indexLag).toBe(0);expect(result.items.map(r=>r.text)).toEqual(['Weekly personal reading plan']);
  const documents=embed.mock.calls.flatMap(([texts])=>texts).filter(text=>['Weekly personal reading plan','Database backup rotation'].includes(text));
  await recall.hybridSearch(root,{projectId:null,query:'weekly personal reading plan'});
  expect(embed.mock.calls.flatMap(([texts])=>texts).filter(text=>['Weekly personal reading plan','Database backup rotation'].includes(text))).toEqual(documents);
  expect(embed.mock.calls.flatMap(([texts])=>texts).some(text=>text==='Recall the weekly personal reading plan')).toBe(true);
  expect(fetch).not.toHaveBeenCalled();await recall.close();
 }finally{store.close();rmSync(home,{recursive:true,force:true});}
});
