import {expect,it} from 'vitest';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {spawn} from '../server/native-spawn';

it.each([true,false])('native Node CLI receives PWD for its actual working directory (explicit cwd: %s)',async explicit=>{
 const directory=await mkdtemp(join(tmpdir(),'mandala-native-cwd-'));
 const env={...process.env,PWD:join(directory,'stale-parent-directory')};
 const cwd=explicit?directory:undefined;
 const child=spawn(process.execPath,['-e','process.stdout.write(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD}))'],{cwd,env,stdio:'pipe'});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.resume();child.stdin.end();
 try{
  const [code]=await once(child,'close');expect(code).toBe(0);
  const result=JSON.parse(output);expect(result.pwd).toBe(resolve(cwd??process.cwd()));expect(await realpath(result.pwd)).toBe(result.cwd);
  expect(env.PWD).toBe(join(directory,'stale-parent-directory'));
 }finally{clearTimeout(timeout);child.kill();await rm(directory,{recursive:true,force:true});}
});
