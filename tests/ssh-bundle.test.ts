import {expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,cp,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createBusinessCliRuntime} from '../server/business-cli-runtime';
const exec=promisify(execFile);
it('builds relocatable service/CLI bundles and executes a bound mailbox command without local dependencies',async()=>{
 await exec(process.execPath,['scripts/build-ssh-runner.mjs'],{cwd:process.cwd(),timeout:30000});const root=await realpath(await mkdtemp(join(tmpdir(),'mandala-ssh-bundle-')));
 let runtime:Awaited<ReturnType<typeof createBusinessCliRuntime>>|undefined;
 try{
  const bundle=join(root,'bundle');await cp(resolve('release/ssh-runner'),bundle,{recursive:true});
  expect(await readFile(join(bundle,'pi-permission-extension.mjs'),'utf8')).toContain('mandala-permission-gate');
  const help=await exec(process.execPath,[join(bundle,'mandala.mjs'),'--help']);expect(help.stdout).toContain('memory search');
  const calls:any[]=[];runtime=await createBusinessCliRuntime(root,'inv',{baseUrl:'http://127.0.0.1:1',token:'mailbox-only'},async request=>{calls.push(request);return {records:[]};},join(bundle,'mandala.mjs'));
  const result=await exec(process.execPath,[join(bundle,'mandala.mjs'),'memory','search','--data','{"query":"past decision"}','--key','stable-key'],{env:{...process.env,MANDALA_CONTEXT:runtime.contextFile},timeout:5000});
  expect(JSON.parse(result.stdout)).toMatchObject({ok:true,data:{records:[]}});expect(calls).toEqual([{command:'memory search',args:{query:'past decision'},commandKey:'stable-key'}]);
 }finally{runtime?.dispose();await rm(root,{recursive:true,force:true});}
},40000);
