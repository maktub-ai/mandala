import {vi,it,expect,afterEach,beforeEach} from 'vitest';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {readConfig,writeConfig} from '../server/config';
const fixture=vi.hoisted(()=>({platform:'win32',attempts:[] as string[],asyncAttempts:0,asyncFail:false,asyncAlways:false,cleanupFail:false,recoveryFail:false,fail:undefined as undefined|((path:string,dst:string,writeNow:(path:string,text:string)=>void)=>void)}));
vi.mock('node:os',async original=>({...await original<typeof import('node:os')>(),platform:()=>fixture.platform}));
vi.mock('node:fs',async original=>{
 const fs=await original<typeof import('node:fs')>();
 return {...fs,readFileSync:(...args:Parameters<typeof fs.readFileSync>)=>{if(fixture.recoveryFail)throw Object.assign(new Error('synthetic private recovery path'),{code:'EPERM'});return fs.readFileSync(...args);},renameSync:(src:string,dst:string)=>{
  if(fixture.fail){fixture.attempts.push(src);fixture.fail(src,dst,fs.writeFileSync);}
  return fs.renameSync(src,dst);
 }};
});
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>();
 return {...fs,rm:async(...args:Parameters<typeof fs.rm>)=>{if(fixture.cleanupFail&&String(args[0]).endsWith('.tmp'))throw Object.assign(new Error('synthetic private cleanup path'),{code:'EPERM'});return fs.rm(...args);},rename:async(src:string,dst:string)=>{
  if(fixture.asyncFail&&(++fixture.asyncAttempts===1||fixture.asyncAlways))throw Object.assign(new Error('synthetic asynchronous contention'),{code:'EPERM'});
  return fs.rename(src,dst);
 }};
});
const busy=(code='EPERM')=>Object.assign(new Error('synthetic private absolute path'),{code});
let home:string;
beforeEach(async()=>{fixture.platform='win32';fixture.attempts=[];fixture.asyncAttempts=0;fixture.asyncFail=false;fixture.asyncAlways=false;fixture.cleanupFail=false;fixture.recoveryFail=false;fixture.fail=undefined;home=await mkdtemp(join(tmpdir(),'mandala-config-atomic-'));});
afterEach(async()=>{fixture.fail=undefined;await rm(home,{recursive:true,force:true});});
const oldText=()=>readFile(join(home,'config.json'),'utf8');
const verifyTemp=async()=>expect((await readdir(home)).filter(n=>n.endsWith('.tmp'))).toEqual([]);
it('retries Windows EPERM with the same temp and rechecks authorization before publication',async()=>{
 const current=await readConfig(home),before=await oldText();let guards=0;
 fixture.fail=(src,dst)=>{expect(dirname(src)).toBe(home);expect(dirname(dst)).toBe(home);if(fixture.attempts.length===1)throw busy();};
 await writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{guards++;});
 expect(new Set(fixture.attempts).size).toBe(1);expect(fixture.attempts).toHaveLength(2);expect(guards).toBeGreaterThanOrEqual(3);
 expect(await oldText()).not.toBe(before);await verifyTemp();
});
it('returns a bounded sanitized 409 without altering existing config when contention persists',async()=>{
 const current=await readConfig(home),before=await oldText();fixture.fail=()=>{throw busy();};
 const error=await writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{}).catch(e=>e);
 expect(error).toMatchObject({code:'config_busy',status:409});expect(error.message).not.toContain('private');
 expect(fixture.attempts).toHaveLength(3);expect(new Set(fixture.attempts).size).toBe(1);
 expect(await oldText()).toBe(before);await verifyTemp();
});
it('does not publish after authorization expires during retry',async()=>{
 const current=await readConfig(home),before=await oldText();let active=true;
 fixture.fail=()=>{active=false;throw busy();};
 await expect(writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{if(!active)throw Error('invocation expired');})).rejects.toThrow('invocation expired');
 expect(fixture.attempts).toHaveLength(1);expect(await oldText()).toBe(before);await verifyTemp();
});
it('does not overwrite another revision that appeared during the retry',async()=>{
 const current=await readConfig(home),external=JSON.stringify({...current.config,runtimes:['pi']});
 fixture.fail=(_src,dst,write)=>{write(dst,external);throw busy();};
 await expect(writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{})).rejects.toThrow('configuration changed');
 expect(fixture.attempts).toHaveLength(1);expect(await oldText()).toBe(external);await verifyTemp();
});
it.each([['darwin','EPERM'],['win32','EINVAL']])('does not retry other platform/code %s %s',async(platform,code)=>{
 const current=await readConfig(home),before=await oldText();fixture.platform=platform;
 fixture.fail=()=>{throw busy(code);};
 await expect(writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{})).rejects.toMatchObject({code});
 expect(fixture.attempts).toHaveLength(1);expect(await oldText()).toBe(before);await verifyTemp();
});

it('keeps ordinary settings publication asynchronous and retries its exact same-directory operation',async()=>{
 const current=await readConfig(home);
 fixture.asyncFail=true;
 await writeConfig(home,{...current.config,runtimes:['codex']},current.revision);
 expect(fixture.asyncAttempts).toBe(2);
 expect((await readConfig(home)).config.runtimes).toEqual(['codex']);
 await verifyTemp();
});

it('sanitizes bounded Windows contention during ordinary asynchronous settings publication',async()=>{
 const current=await readConfig(home),before=await oldText();
 fixture.asyncFail=true;fixture.asyncAlways=true;
 await expect(writeConfig(home,{...current.config,runtimes:['codex']},current.revision)).rejects.toMatchObject({code:'config_busy',status:409,message:'Configuration could not be saved right now. Try again.'});
 expect(fixture.asyncAttempts).toBe(3);expect(await oldText()).toBe(before);await verifyTemp();
});
it('preserves the sanitized contention error if cleanup and recovery also fail',async()=>{
 const current=await readConfig(home),before=await oldText();
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 fixture.fail=()=>{if(fixture.attempts.length===3){fixture.cleanupFail=true;fixture.recoveryFail=true;}throw busy();};
 try{
  await expect(writeConfig(home,{...current.config,runtimes:['codex']},current.revision,()=>{})).rejects.toMatchObject({code:'config_busy',status:409,message:'Configuration could not be saved right now. Try again.'});
  expect(warn.mock.calls.flat()).toEqual(['Configuration recovery after a busy save was unsuccessful.','Temporary configuration cleanup after a busy save was unsuccessful.']);
  expect(await oldText()).toBe(before);
 } finally { fixture.cleanupFail=false;fixture.recoveryFail=false;warn.mockRestore(); }
});
