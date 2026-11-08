import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skipIf(process.platform === 'win32')('login PATH probe falls back when a shell ignores the timeout termination signal', async () => {
 const directory=mkdtempSync(join(tmpdir(),'mandala-path-probe-'));
 const shell=join(directory,'shell'),pidFile=join(directory,'pid');
 writeFileSync(shell,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.PROBE_PID,String(process.pid));\nprocess.on('SIGTERM',()=>{});\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import {loginShellPath} from './desktop/runtime.ts';process.stdout.write(loginShellPath());"],{env:{...process.env,SHELL:shell,PROBE_PID:pidFile},stdio:['ignore','pipe','ignore']});
 let output='';child.stdout.on('data',data=>{output+=data;});
 const watchdog=setTimeout(()=>child.kill('SIGKILL'),13000);
 try {
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  expect(code).toBe(0);expect(output).toBe(process.env.PATH??'');
 } finally {
  clearTimeout(watchdog);
  if(existsSync(pidFile))try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  rmSync(directory,{recursive:true,force:true});
 }
},20000);
