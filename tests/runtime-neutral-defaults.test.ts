import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enabledRuntimes,runtimeIds} from '../shared/runtimes';
import {ensureMandalaConfig,readConfig,writeConfig} from '../server/config';
import {businessCliInstructions} from '../server/business-cli-runtime';
const homes:string[]=[];
async function home(){const path=await mkdtemp(join(tmpdir(),'neutral-runtime-'));homes.push(path);return path;}
afterEach(async()=>{await Promise.all(homes.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
it('leaves a new home unselected without writing a coordinator with a guessed runtime',async()=>{
 const path=await home(),before=await readConfig(path);
 expect(enabledRuntimes(before.config)).toEqual([]);
 expect(await ensureMandalaConfig(path)).toEqual(before);
});
it.each(runtimeIds)('preserves the selected %s runtime and models when initializing Mandala',async cli=>{
 const path=await home(),before=await readConfig(path);
 const agent={id:'user',name:'User',instructions:'Keep',defaultCli:cli,models:{[cli]:'chosen-model'},mcp:[],skills:[]};
 await writeConfig(path,{...before.config,runtimes:[cli],agents:[agent]},before.revision);
 const first=await ensureMandalaConfig(path);
 expect(first.config.agents.find(a=>a.id==='user')).toEqual(agent);
 expect(first.config.agents.find(a=>a.id===first.config.mandala?.agentId)?.defaultCli).toBe(cli);
 expect(await ensureMandalaConfig(path)).toEqual(first);
});
it('preserves legacy saved executors without adding vendor defaults or overriding an explicit disabled list',()=>{
 const agents=[{id:'a',name:'A',instructions:'',defaultCli:'gemini' as const,models:{},mcp:[],skills:[]}];
 expect(enabledRuntimes({agents})).toEqual(['gemini']);
 expect(enabledRuntimes({agents,runtimes:[]})).toEqual([]);
});
it('supplies discovery examples without preselecting runtime brands',()=>{
 const prompt=businessCliInstructions({launcher:'/test/mandala',contextFile:'/test/context',command:'/test/mandala',dispose(){}},{project:false,assets:false,memory:false,coordinator:true});
 expect(prompt).not.toContain('"codex"');expect(prompt).not.toContain('"omp"');
 expect(prompt).toContain('registered');
});

it('saves language and memory preferences without selecting an executor',async()=>{
 const path=await home(),before=await readConfig(path);
 await writeConfig(path,{...before.config,system:{memory:{language:'en'},memoryCapture:false}},before.revision);
 const saved=await readConfig(path);
 expect(saved.config.system).toEqual({memory:{language:'en'},memoryCapture:false});
 expect(enabledRuntimes(saved.config)).toEqual([]);
 expect(await ensureMandalaConfig(path)).toEqual(saved);
});
it('creates an unassigned chat with the configured runtime instead of a synthetic Codex default',async()=>{
 const {openStore}=await import('../server/store'),{createSessionManager}=await import('../server/sessions');
 const path=await home(),store=openStore(path),config={version:2 as const,runtimes:['gemini' as const],agents:[],projects:[]};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,path);
 try{expect((await manager.create('','')).cli).toBe('gemini');}finally{await manager.close();store.close();}
});
