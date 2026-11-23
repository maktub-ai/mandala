import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnoseNativeCli} from '../server/native-spawn';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'mandala-detect-fixture-'));dirs.push(directory);
 const name=process.platform==='win32'?'mandala-fixture.cmd':'mandala-fixture';
 return {path:join(directory,name),env:{PATH:directory,PATHEXT:'.EXE;.CMD'}};
}
it('distinguishes absent and executable without running a runtime',async()=>{
 const x=await fixture();
 expect(diagnoseNativeCli('mandala-fixture',x.env)).toMatchObject({state:'missing'});
 await writeFile(x.path,'not launched',{mode:0o755});
 expect(diagnoseNativeCli('mandala-fixture',x.env)).toMatchObject({state:'executable'});
});
it.skipIf(process.platform==='win32')('never treats a dangling executable link or a non-executable as ready',async()=>{
 const x=await fixture();
 await symlink(x.path+'-missing',x.path);
 expect(diagnoseNativeCli('mandala-fixture',x.env)).toMatchObject({state:'broken'});
 await rm(x.path);await writeFile(x.path,'not launched',{mode:0o644});
 expect(diagnoseNativeCli('mandala-fixture',x.env)).toMatchObject({state:'blocked'});
});

it('has official setup guidance for every named launcher without declaring any implicit installation',async()=>{
 const {officialRuntimeSetup,runtimeCatalog,runtimeIds}=await import('../shared/runtimes');
 expect(Object.keys(officialRuntimeSetup).sort()).toEqual([...runtimeIds].sort());
 expect(Object.keys(runtimeCatalog).sort()).toEqual([...runtimeIds].sort());
 for(const cli of runtimeIds){
  expect(officialRuntimeSetup[cli].source.trim()).not.toBe('');
  expect(runtimeCatalog[cli].docs).toMatch(/^https:\/\//);
  expect(runtimeCatalog[cli].command).toMatch(/^[a-z0-9-]+$/);
  expect(officialRuntimeSetup[cli]).not.toHaveProperty('install');
 }
});

it('does not auto-suggest a runtime from a transport/version probe alone',async()=>{
 const {canSuggestRuntime}=await import('../src/onboarding');
 expect(canSuggestRuntime({status:'ready',version:'fixture',diagnostics:{host:'local',executable:'executable',probe:'acp',auth:'not-verified'}})).toBe(false);
 expect(canSuggestRuntime({status:'ready',version:'fixture',diagnostics:{host:'local',executable:'executable',probe:'account',auth:'native-account-ready'}})).toBe(true);
});
