import {afterEach,expect,it,vi} from 'vitest';
import {adoptRuntime} from '../src/onboarding';
import type {Config} from '../shared/types';

afterEach(()=>vi.unstubAllGlobals());
it.each(['codex','claude'] as const)('persists only the selected runtime on first adoption: %s',async cli=>{
 let config:Config={version:2,agents:[{id:'main',name:'Mandala',systemRole:'mandala',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]}],projects:[]};
 vi.stubGlobal('fetch',async(_url:string,options:RequestInit)=>{
  if(options.method==='PUT')config=JSON.parse(options.body as string).config;
  return new Response(JSON.stringify({config,revision:'current'}));
 });
 const saved=await adoptRuntime(cli,false);
 expect(saved.config.runtimes).toEqual([cli]);
});
it('preserves explicit runtime registrations when adopting another',async()=>{
 let config:Config={version:2,agents:[],projects:[],runtimes:['omp']};
 vi.stubGlobal('fetch',async(_url:string,options:RequestInit)=>{
  if(options.method==='PUT')config=JSON.parse(options.body as string).config;
  return new Response(JSON.stringify({config,revision:'current'}));
 });
 expect((await adoptRuntime('claude',false)).config.runtimes).toEqual(['omp','claude']);
});
it('preserves a legacy executor runtime without registering unused fallback adapters',async()=>{
 let config:Config={version:2,projects:[],agents:[{id:'worker',name:'Worker',instructions:'',defaultCli:'codex',models:{},skills:[],mcp:[]}]};
 vi.stubGlobal('fetch',async(_url:string,options:RequestInit)=>{
  if(options.method==='PUT')config=JSON.parse(options.body as string).config;
  return new Response(JSON.stringify({config,revision:'current'}));
 });
 expect((await adoptRuntime('claude',false)).config.runtimes).toEqual(['codex','claude']);
});
it('keeps a legacy system executor when adding a different runtime',async()=>{
 let config:Config={version:2,agents:[],projects:[],system:{cli:'omp',model:'saved-model'}};
 vi.stubGlobal('fetch',async(_url:string,options:RequestInit)=>{
  if(options.method==='PUT')config=JSON.parse(options.body as string).config;
  return new Response(JSON.stringify({config,revision:'current'}));
 });
 const saved=await adoptRuntime('gemini',false);
 expect(saved.config.runtimes).toEqual(['omp','gemini']);
 expect(saved.config.system).toEqual({cli:'omp',model:'saved-model'});
});
