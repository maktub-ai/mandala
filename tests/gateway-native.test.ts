import {expect,it} from 'vitest';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openClawNativeSettings} from '../server/gateway-native';

// Exercise the real subprocess boundary. This fake native CLI emits only the two
// public metadata queries the integration is allowed to make.
async function nativeFixture(mode:'local'|'remote'|'failure',run:(env:Record<string,string>)=>Promise<void>){
 const cwd=await mkdtemp(join(tmpdir(),'mandala-native-metadata-'));
 try{
  const file=join(cwd,'openclaw');
  await writeFile(file,`#!${process.execPath}\nconst args=process.argv.slice(2);if(args.join(' ')==='config get gateway.remote.url --json'){${mode==='remote'?`console.log(JSON.stringify('wss://other-machine.invalid'));`:mode==='failure'?`console.error('sensitive diagnostic');process.exit(2);`:`console.log(JSON.stringify({ok:false,error:{message:'Config path is valid but unset: gateway.remote.url.'}}));process.exit(1);`}}else if(args.join(' ')==='models list --json')console.log(JSON.stringify({models:[{key:'provider/default',name:'Native model',tags:['default']},{key:'provider/other',tags:[]}]}));else process.exit(99);`);
  await chmod(file,0o700);await run({PATH:cwd});
 }finally{await rm(cwd,{recursive:true,force:true});}
}
it('probes only the real native default model without advertising unsupported OpenClaw model routing',async()=>{
 await nativeFixture('local',async env=>expect(await openClawNativeSettings({cwd:'/tmp',env})).toEqual({model:{id:'provider/default',label:'Native model',isDefault:true}}));
});
it('refuses a Gateway on a different machine before an ACP adapter starts',async()=>{
 await nativeFixture('remote',async env=>await expect(openClawNativeSettings({cwd:'/tmp',env})).rejects.toThrow(/execution machine.*SSH/));
});
it('fails closed on native configuration errors without exposing subprocess diagnostics',async()=>{
 await nativeFixture('failure',async env=>{try{await openClawNativeSettings({cwd:'/tmp',env});throw new Error('accepted');}catch(e){expect(String(e)).toMatch(/native configuration/);expect(String(e)).not.toContain('sensitive');}});
});
it('refuses native URL overrides whose filesystem and business CLI location cannot be guaranteed',async()=>{
 await expect(openClawNativeSettings({cwd:'/tmp',env:{OPENCLAW_GATEWAY_URL:'ws://127.0.0.1:9999'}})).rejects.toThrow(/execution machine/);
});
it('refuses Hermes remote and tunneled Gateway URLs before launching its adapter',async()=>{
 const {startAcp}=await import('../server/acp');
 await expect(startAcp('hermes',{cwd:'/tmp',env:{PATH:'/no-native-bin',HERMES_TUI_GATEWAY_URL:'ws://127.0.0.1:9999'},onEvent(){},onApproval(){},onExit(){}})).rejects.toThrow(/execution machine.*SSH/);
});
