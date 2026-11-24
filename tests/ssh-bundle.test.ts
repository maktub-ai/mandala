import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import bridge from '../scripts/claude-bridge/manifest.json';
import {sshBundleFiles} from '../server/ssh-transport';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {mkdtemp,cp,rm,readFile,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startAcp} from '../server/acp';
import {createBusinessCliRuntime} from '../server/business-cli-runtime';
const exec=promisify(execFile);
it('builds relocatable service/CLI bundles and executes a bound mailbox command without local dependencies',async()=>{
 await exec(process.execPath,['scripts/build-ssh-runner.mjs'],{cwd:process.cwd(),timeout:30000});const root=await realpath(await mkdtemp(join(tmpdir(),'mandala-ssh-bundle-')));
 let runtime:Awaited<ReturnType<typeof createBusinessCliRuntime>>|undefined;
 try{
  const bundle=join(root,'bundle');await cp(resolve('release/ssh-runner'),bundle,{recursive:true});
  expect(await readFile(join(bundle,'pi-permission-extension.mjs'),'utf8')).toContain('mandala-permission-gate');
  const assets=await sshBundleFiles();
  expect(createHash('sha256').update(assets.claude).digest('hex')).toBe(bridge.sha256);
  expect(assets.notices.toString()).toContain('@anthropic-ai/claude-agent-sdk');
  const loaded=await exec(process.execPath,['--input-type=module','-e',`const runner=await import(${JSON.stringify(pathToFileURL(join(bundle,'ssh-runner.mjs')).href)});console.log(typeof runner.runSshDaemon,typeof runner.attachSshDaemon);`],{cwd:root,timeout:5000});
  expect(loaded.stdout.trim()).toBe('function function');
  const help=await exec(process.execPath,[join(bundle,'mandala.mjs'),'--help']);expect(help.stdout).toContain('memory search');
  const calls:any[]=[];runtime=await createBusinessCliRuntime(root,'inv',{baseUrl:'http://127.0.0.1:1',token:'mailbox-only'},async request=>{calls.push(request);return {records:[]};},join(bundle,'mandala.mjs'));
  const result=await exec(process.execPath,[join(bundle,'mandala.mjs'),'memory','search','--data','{"query":"past decision"}','--key','stable-key'],{env:{...process.env,MANDALA_CONTEXT:runtime.contextFile},timeout:5000});
  expect(JSON.parse(result.stdout)).toMatchObject({ok:true,data:{records:[]}});expect(calls).toEqual([{command:'memory search',args:{query:'past decision'},commandKey:'stable-key'}]);
  if(process.platform!=='win32')await verifyClaudeMcp(root);
 }finally{runtime?.dispose();await rm(root,{recursive:true,force:true});}
},40000);


async function verifyClaudeMcp(root:string) {
 const launcher=join(root,'claude'), ledger=join(root,'claude-trace');
 const marker='synthetic-claude-sdk-secret';
 await writeFile(launcher,`#!${process.execPath}
const {appendFileSync}=require('node:fs');
const {createInterface}=require('node:readline');
const args=process.argv.slice(2);
const emit=msg=>process.stdout.write(JSON.stringify(msg)+'\\n');
if(args.includes('--version')){console.log('2.1.330 (Claude Code)');process.exit(0);}
if(args[0]==='auth'){emit({loggedIn:false,authMethod:'none'});process.exit(0);}
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.type!=='control_request')process.exit(84);
 if(request.request?.subtype==='initialize'){
  const marker=process.env.MANDALA_TEST_CLAUDE_MARKER;
  appendFileSync(process.env.MANDALA_TEST_CLAUDE_LEDGER,JSON.stringify({
   markerInArgv:args.some(arg=>arg.includes(marker)||arg.startsWith('--mcp-config')),
   markerInInitialize:JSON.stringify(request.request).includes(marker),
   protectedDelivery:args.includes('--await-initialize'),
   manualMode:args.includes('--permission-mode=default')&&!args.includes('--allow-dangerously-skip-permissions'),
  })+'\\n');
 }
 emit({type:'control_response',response:{request_id:request.request_id,subtype:'success',
  response:{models:[],commands:[],account:{},mcp_servers_applied:process.env.MANDALA_TEST_CLAUDE_ACK==='1'}}});
});
`,{mode:0o700});
 vi.stubEnv('MANDALA_TEST_CLAUDE_MARKER',marker);
 try {
  for (const ack of ['1','0']) {
   const client=await startAcp('claude',{
    cwd:root, env:{CLAUDE_CODE_EXECUTABLE:launcher,CLAUDE_CONFIG_DIR:root,HOME:root,
     MANDALA_TEST_CLAUDE_LEDGER:ledger,MANDALA_TEST_CLAUDE_ACK:ack},onEvent(){},onApproval(){},onExit(){},
   });
   try {
    const connect=client.startThread({cwd:root,instructions:'',mcp:[{
     name:'fixture',transport:'stdio',command:'/usr/bin/false',env:{TEST:'${MANDALA_TEST_CLAUDE_MARKER}'},
    }]});
    if(ack==='1')await expect(connect).resolves.toEqual(expect.any(String));
    else {
     const error=await connect.then(()=>null,error=>error);
     expect(error).toBeInstanceOf(Error);
     expect(String(error)).not.toContain(marker);
    }
   } finally { await client.close(); }
  }
  const records=(await readFile(ledger,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records).toEqual(Array(2).fill({markerInArgv:false,markerInInitialize:true,protectedDelivery:true,manualMode:true}));
 } finally { vi.unstubAllEnvs(); }
}
