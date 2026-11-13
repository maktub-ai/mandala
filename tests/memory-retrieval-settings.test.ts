import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {readConfig} from '../server/config';
import {createMemoryRuntime} from '../server/memory-runtime';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.unstubAllGlobals();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'memory-retrieval-')),store=openStore(home),config=(await readConfig(home)).config;
 const runtime=createMemoryRuntime({home,store,loadConfig:async()=>config,schedule:false});
 cleanup.push(async()=>{await runtime.close();store.close();rmSync(home,{recursive:true,force:true});});
 runtime.memory.importLegacy({userId:'local'},[{id:'synthetic',kind:'memory',title:'Tokyo',content:'travels to Tokyo',scope:'global',status:'active',access:{mode:'owner'},createdAt:'2020',updatedAt:'2020'}]);
 return {home,store,runtime};
}
const settings={enabled:true,provider:'openai',baseUrl:'https://embedding.example/v1',model:'chosen-embedding',apiKey:'synthetic-key'};
const input={projectId:null,query:'日本'};
test('fresh and existing workspaces use keywords without network access, including background indexing',async()=>{
 const {runtime}=await setup(),fetcher=vi.fn(async()=>{throw new Error('unexpected network');});vi.stubGlobal('fetch',fetcher);
 expect(await runtime.retrieval.status()).toMatchObject({enabled:false,baseUrl:'',model:'',hasApiKey:false});
 const result=await runtime.recall.hybridSearch({userId:'local'},{...input,query:'Tokyo'});
 expect(result.items[0].text).toBe('travels to Tokyo');expect(result.degraded).toBe(false);
 await runtime.refreshVectors();expect(fetcher).not.toHaveBeenCalled();
});
test('explicit provider selection persists privately and uses the chosen endpoint, model and key',async()=>{
 const {runtime,home}=await setup(),requests:{url:string;body:any;authorization:string|null}[]=[];
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);requests.push({url,body,authorization:new Headers(init.headers).get('authorization')});return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:[1,0,0]}))});});
 const saved=await runtime.retrieval.configure(settings);expect(saved.hasApiKey).toBe(true);expect(JSON.stringify(saved)).not.toContain('synthetic-key');
 const result=await runtime.recall.hybridSearch({userId:'local'},input);expect(result.items[0].text).toBe('travels to Tokyo');expect(result.degraded).toBe(false);
 expect(requests).toHaveLength(2);expect(requests[0]).toEqual({url:'https://embedding.example/v1/embeddings',body:{model:'chosen-embedding',input:['travels to Tokyo'],encoding_format:'float'},authorization:'Bearer synthetic-key'});
 expect(JSON.parse(readFileSync(join(home,'memory-retrieval.json'),'utf8')).enabled).toBe(true);
 if(process.platform!=='win32')expect(statSync(join(home,'memory-retrieval.json')).mode&0o777).toBe(0o600);
 await runtime.retrieval.configure({enabled:false});requests.length=0;
 const disabled=await runtime.recall.hybridSearch({userId:'local'},{...input,query:'Tokyo'});expect(disabled.degraded).toBe(false);expect(disabled.indexLag).toBe(0);
 await runtime.refreshVectors();expect(requests).toHaveLength(0);
});
test('model and endpoint changes rebuild separate caches and never forward a saved key to a new endpoint',async()=>{
 const {runtime,store}=await setup();let documents=0;
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);documents+=body.input.filter((s:string)=>s==='travels to Tokyo').length;return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:[1,0]}))});});
 await runtime.retrieval.configure(settings);await runtime.recall.hybridSearch({userId:'local'},input);
 await runtime.recall.hybridSearch({userId:'local'},input);expect(documents).toBe(1);
 await runtime.retrieval.configure({model:'another-model'});await runtime.recall.hybridSearch({userId:'local'},input);expect(documents).toBe(2);
 const changed=await runtime.retrieval.configure({baseUrl:'https://other.example/v1'});expect(changed.hasApiKey).toBe(false);
 await runtime.recall.hybridSearch({userId:'local'},input);expect(documents).toBe(3);
 expect(store.database.prepare('SELECT COUNT(DISTINCT model) AS n FROM memory_vectors').get()?.n).toBe(3);
});
test('Ollama uses the selected server and model digest with arbitrary dimensions',async()=>{
 const {runtime}=await setup();let digest='first',documents=0;
 vi.stubGlobal('fetch',async(url:string,init?:RequestInit)=>{
  expect(url.startsWith('http://127.0.0.1:19999/')).toBe(true);
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'chosen:latest',digest}]});
  const body=JSON.parse(init!.body as string);expect(body.model).toBe('chosen');documents+=body.input.filter((s:string)=>s==='travels to Tokyo').length;
  return Response.json({embeddings:body.input.map(()=>[1,0,0,0])});
 });
 await runtime.retrieval.configure({enabled:true,provider:'ollama',baseUrl:'http://127.0.0.1:19999',model:'chosen'});
 expect((await runtime.recall.hybridSearch({userId:'local'},input)).degraded).toBe(false);
 digest='second';await runtime.recall.hybridSearch({userId:'local'},input);expect(documents).toBe(2);
});
test('disabling during an in-flight request aborts it and discards its vectors',async()=>{
 const {runtime,store}=await setup();let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined;
 const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{signal=init.signal!;entered();await blocked;return Response.json({data:[{index:0,embedding:[1,0]}]});});
 await runtime.retrieval.configure(settings);const work=runtime.recall.hybridSearch({userId:'local'},{...input,query:'Tokyo'});
 await started;await runtime.retrieval.configure({enabled:false});expect(signal?.aborted).toBe(true);release();
 expect((await work).items[0].text).toBe('travels to Tokyo');expect(store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(0);
});
test('invalid configuration is rejected and unavailable providers retain keyword results',async()=>{
 const {runtime}=await setup();
 for(const value of [{enabled:true},{enabled:'yes'},{provider:'unknown'},{baseUrl:'file:///tmp/secret'},{baseUrl:'https://user:pass@example.com'},{baseUrl:'https://example.com/?key=secret'},{apiKey:'bad\nkey'}])await expect(runtime.retrieval.configure(value)).rejects.toMatchObject({status:422});
 await runtime.retrieval.configure(settings);vi.stubGlobal('fetch',async()=>Response.json({error:'secret upstream error'},{status:401}));
 const result=await runtime.recall.hybridSearch({userId:'local'},{...input,query:'Tokyo'});expect(result.degraded).toBe(true);expect(result.items[0].text).toBe('travels to Tokyo');expect(JSON.stringify(result)).not.toContain('secret upstream error');
});

test('saved settings survive restart and malformed provider output falls back without corrupting the cache',async()=>{
 const {createMemoryRetrieval}=await import('../server/memory-retrieval'),{runtime,home,store}=await setup();
 await runtime.retrieval.configure(settings);
 const restarted=createMemoryRetrieval(home);expect(await restarted.status()).toMatchObject({enabled:true,model:'chosen-embedding',hasApiKey:true});restarted.close();
 for(const data of [[{index:4,embedding:[1,0]}],[{index:0,embedding:[0,0]}],[{index:0,embedding:[null,1]}]]){
  vi.stubGlobal('fetch',async()=>Response.json({data}));const result=await runtime.recall.hybridSearch({userId:'local'},{...input,query:'Tokyo'});
  expect(result.items[0].text).toBe('travels to Tokyo');expect(result.degraded).toBe(true);
 }
 expect(store.database.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n).toBe(0);
});
