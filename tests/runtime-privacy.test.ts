import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig,validateConfig} from '../server/config';
import {resolveRuntime} from '../server/runtime';
import {startNativeRuntime} from '../server/native-runtime';
import type {RuntimeConfig} from '../shared/types';

const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
it('keeps a saved retired route readable but blocks execution until the user selects native settings',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mandala-retired-route-'));homes.push(home);
 const source=JSON.stringify({version:2,projects:[],agents:[],runtimeDefaults:{gemini:{gateway:'retired-local-route'}}});
 await writeFile(join(home,'config.json'),source);
 const {config}=await readConfig(home);
 expect(config.runtimeDefaults?.gemini?.gateway).toBe('unavailable');
 expect(()=>resolveRuntime('gemini',undefined,config.runtimeDefaults)).toThrow(/native CLI settings/);
 expect(await readFile(join(home,'config.json'),'utf8')).toBe(source);
 config.runtimeDefaults!.gemini!.gateway='native';
 expect(()=>validateConfig(config)).not.toThrow();
 expect(resolveRuntime('gemini',undefined,config.runtimeDefaults)).toMatchObject({gateway:'native',env:{}});
});
it('rejects unsupported routes supplied directly instead of silently changing their provider',async()=>{
 const runtime={pi:{gateway:'retired-local-route'}} as unknown as RuntimeConfig;
 expect(()=>resolveRuntime('pi',runtime)).toThrow(/native CLI settings/);
 await expect(startNativeRuntime('pi',{cwd:tmpdir(),gateway:'retired-local-route' as never,onEvent(){},onApproval(){},onExit(){}})).rejects.toThrow(/native CLI settings/);
});
