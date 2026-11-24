import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,join,resolve} from 'node:path';
import {runtimeCatalog,runtimeIds} from '../shared/runtimes';
import {diagnoseNativeCli,spawn} from '../server/native-spawn';

const {launch}=vi.hoisted(()=>({launch:vi.fn()}));
vi.mock('cross-spawn',()=>({default:launch}));
const dirs:string[]=[];
afterEach(async()=>{launch.mockReset();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(){
 const first=await mkdtemp(join(tmpdir(),'mandala-catalog-first-'));
 const next=await mkdtemp(join(tmpdir(),'mandala-catalog-next-'));
 dirs.push(first,next);
 return {first,next,env:{PATH:['relative-fixture',first,next].join(delimiter),PWD:'not-the-execution-directory'}};
}

it.skipIf(process.platform==='win32')('binds all advertised Unix launchers to the same absolute candidate as detection, preserving order, argv, and environment',async()=>{
 const {first,next,env}=await fixture();
 for(const cli of runtimeIds){
  const {command,args}=runtimeCatalog[cli], installed=join(first,command);
  await writeFile(installed,'never executed',{mode:0o755});
  await writeFile(join(next,command),'never executed',{mode:0o755});
  expect(diagnoseNativeCli(command,env)).toEqual({state:'executable',path:installed});
  spawn(command,[...args],{catalogRuntime:cli,cwd:next,env,stdio:'pipe',shell:false});
  expect(launch).toHaveBeenLastCalledWith(installed,args,expect.objectContaining({env:{...env,PWD:resolve(next)},shell:false}));
  expect(env.PWD).toBe('not-the-execution-directory');
 }
 expect(launch).toHaveBeenCalledTimes(runtimeIds.length);
});

it.skipIf(process.platform==='win32')('does not attempt a bare built-in when no candidate meets the diagnostic contract',async()=>{
 const {next,env}=await fixture();
 expect(diagnoseNativeCli('codex',env).state).toBe('missing');
 expect(()=>spawn('codex',['app-server'],{catalogRuntime:'codex',cwd:next,env,stdio:'pipe'})).toThrow('codex not found in explicit PATH directories');
 expect(launch).not.toHaveBeenCalled();
});

it.skipIf(process.platform==='win32')('preserves non-catalog, generic bare and explicit commands without rebinding',async()=>{
 const {next,env}=await fixture();
 const explicit=join(next,'private-test-command');
 spawn('codex',['--version'],{cwd:next,env,stdio:'pipe'});
 spawn('custom-command',[],{catalogRuntime:'codex',cwd:next,env,stdio:'pipe'});
 spawn(explicit,[],{catalogRuntime:'codex',cwd:next,env,stdio:'pipe'});
 expect(launch.mock.calls.map(([command])=>command)).toEqual(['codex','custom-command',explicit]);
});

it.skipIf(process.platform==='win32')('does not select a different candidate when the checked process launch fails',async()=>{
 const {first,next,env}=await fixture();
 for(const dir of [first,next])await writeFile(join(dir,'codex'),'never executed',{mode:0o755});
 launch.mockImplementationOnce(()=>{throw new Error('synthetic launch error');});
 expect(()=>spawn('codex',['app-server'],{catalogRuntime:'codex',cwd:next,env,stdio:'pipe'})).toThrow('synthetic launch error');
 expect(launch.mock.calls.map(([command])=>command)).toEqual([join(first,'codex')]);
});
