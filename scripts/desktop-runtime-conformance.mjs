// Opt-in, macOS only. Synthetic launch/readiness protocol against a signed staged
// desktop backend, never an installed App. Run with RUNTIME_PATH EXPECTED_SHA.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import cases from './desktop-runtime-conformance-cases.json' with { type:'json' };

const script = fileURLToPath(import.meta.url);
const guard = 'claude';
const deny = ['EPERM','EACCES'];

function shim(name, ledger, fixtureRoot, runtime) {
  const record = event => appendFileSync(ledger, JSON.stringify({ name, event })+'\n');
  const bad = (stage='rpc') => { record('unexpected-'+stage); process.exit(88); };
  const row = cases.find(item => item.command === name);
  record('launch');
  const args = process.argv.slice(5);
  if (!row || process.env.HOME !== join(fixtureRoot,'user') ||
      process.env.PATH !== join(fixtureRoot,'bin') ||
      !process.cwd().startsWith(join(fixtureRoot,'scratch','mana-catalog-')) ||
      Object.keys(process.env).some(name => /^(OPENAI_|ANTHROPIC_|CLAUDE_CONFIG_DIR|HTTPS?_PROXY|ALL_PROXY|NODE_OPTIONS|NODE_PATH)/i.test(name))) bad('isolation');
  const exact=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
  const expectedArgs=row.args.map(arg=>arg.replace('$scratch-cwd',process.cwd()).replace('$pi-extension',join(runtime,'server','pi-permission-extension.mjs')));
  const acp=row.probe==='acp'||row.probe==='gateway-session';
  if (acp && ['--version','--help'].includes(args.at(-1)) &&
      (args.length === 1 || exact(args.slice(0,-1),expectedArgs))) {
    record(args.at(-1));
    process.stdout.write(row.version+'\n');
    return;
  }
  if (row.cli==='openclaw') {
    if (exact(args,['config','get','gateway.remote.url','--json'])) { record('local-config'); process.stdout.write('null\n'); return; }
    if (exact(args,['models','list','--json'])) { record('model-catalog'); process.stdout.write('{"models":[{"key":"fixture/model","tags":["default"]}]}\n'); return; }
  }
  if (!exact(args,expectedArgs)) bad('argv');
  if (row.probe==='version-only') { record('version'); process.stdout.write(row.version+'\n'); return; }
  if (row.cli==='omp') process.stdout.write('{"type":"ready"}\n');

  const sessionId = 'synthetic-gateway-session';
  const reader = createInterface({input:process.stdin});
  reader.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return bad(); }
    const {id, params} = request;
    const method=row.probe==='rpc'?request.type:request.method;
    // The fixture never sends a prompt, and fails if the package tries one.
    if (!row.methods.includes(method) && !row.optionalMethods?.includes(method)) return bad();
    record(method);
    if (id === undefined && method === 'initialized') return;
    let result;
    if (row.probe==='rpc') {
      if(typeof id!=='string')return bad();
      const data=method==='get_state'?{sessionFile:join(process.cwd(),'fixture-session'),model:{id:'synthetic',provider:'fixture'}}:
        {commands:[{name:'mandala-permission-gate',source:'extension',sourceInfo:{path:join(runtime,'server','pi-permission-extension.mjs')}}]};
      process.stdout.write(JSON.stringify({type:'response',id,success:true,data})+'\n');
      return;
    }
    if (row.cli === 'codex') {
      if(method === 'initialize') result={userAgent:'fixture/'+row.version};
      if(method === 'account/read' && params?.refreshToken === false) result={requiresOpenaiAuth:true,account:{type:'chatgpt'}};
    } else {
      if(method === 'initialize') result={protocolVersion:1,agentInfo:{name:'fixture',version:row.version},agentCapabilities:row.cli==='openclaw'?{sessionCapabilities:{resume:{}}}:{loadSession:true}};
      if(method === 'session/new' && params?.mcpServers?.length === 0) result={sessionId};
      if(['session/load','session/resume'].includes(method) && params?.sessionId === sessionId && params?.mcpServers?.length === 0) result={};
    }
    if (!result || id === undefined) return bad();
    process.stdout.write(JSON.stringify({...row.cli==='codex'?{}:{jsonrpc:'2.0'},id,result})+'\n');
  });
}

async function worker(runtime, root, node, build) {
  assert(deny.includes(spawnSync('/usr/bin/true',[]).error?.code),'QA sandbox allowed an unlisted executable');
  assert.equal(process.env.PATH,join(root,'bin'));
  assert.equal(homedir(),join(root,'user'));
  let service;
  let exited;
  try {
    service=spawn(node,[join(runtime,'server/main.mjs')],{ cwd:runtime, env:process.env, stdio:['ignore','ignore','ignore','ipc'] });
    exited=once(service,'exit');
    const {port,setupToken}=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Packaged backend did not start')),15000);
      service.once('error',()=>{clearTimeout(timer);reject(Error('Packaged backend could not launch under QA profile'));});
      service.once('exit',()=>{clearTimeout(timer);reject(Error('Packaged backend exited during startup'));});
      service.on('message',message=>{
        if(message?.type==='mandala:ready'&&Number.isInteger(message.port)&&message.port>0&&typeof message.setupToken==='string'){
          clearTimeout(timer);resolve(message);
        }
      });
    });
    const origin='http://127.0.0.1:'+port;
    const api=(path,options={})=>fetch(origin+path,{...options,signal:AbortSignal.timeout(18000),redirect:'error'});
    assert.equal((await api('/api/config')).status,401);
    const launchCookie='mandala_setup='+setupToken;
    const launch=await (await api('/auth/session',{headers:{Cookie:launchCookie}})).json();
    assert.equal(launch.setup.available,true);
    const owner=await api('/auth/setup',{method:'POST',headers:{Origin:origin,Cookie:launchCookie,'X-Setup-Token':launch.setup.token,'Content-Type':'application/json'},
      body:JSON.stringify({username:'conformance',password:'synthetic-conformance-password'})});
    assert.equal(owner.status,201);
    const cookie=owner.headers.getSetCookie().find(value=>/local_session=/.test(value))?.split(';')[0];
    assert(cookie,'No synthetic local session');
    const headers={Cookie:cookie};
    const status=await (await api('/api/status',{headers})).json();
    assert.equal(status.runtime.nodeVersion,build.node.replace(/^v/, ''));
    const statusOf=async cli=>{
      const response=await api('/api/cli/status?scope=runtime&explain=1&cli='+cli,{headers});
      assert.equal(response.status,200);
      return response.json();
    };
    const ledger=join(root,'ledger');
    const rows=async()=> (await readFile(ledger,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const evidence=[];
    for (const row of cases) {
      const previous=(await rows()).length;
      const value=await statusOf(row.cli);
      const entries=(await rows()).slice(previous);
      assert.equal(value.status,'ready',row.cli+' synthetic readiness failed ('+value.diagnostics?.failureStage+'; '+entries.map(item=>item.event).join(',')+')');
      assert.equal(value.version,row.version);
      assert.equal(value.diagnostics.probe,row.probe);
      assert.equal(value.diagnostics.auth,row.auth);
      assert.equal(value.diagnostics.executable,'executable');
      assert(entries.length>0 && entries.every(item=>item.name===row.command&&!item.event.startsWith('unexpected-')),row.cli+' used a wrong launcher or method');
      assert(entries.some(item=>item.event==='launch'));
      for(const method of row.methods)assert(entries.some(item=>item.event===method),row.cli+' omitted '+method);
      if(row.probe==='rpc')assert.equal(entries.filter(item=>item.event==='get_state').length,2,row.cli+' must start and probe independently');
      if(row.probe==='version-only')assert(entries.some(item=>item.event==='version'));
      if(row.cli==='openclaw') for(const method of ['local-config','model-catalog'])assert(entries.some(item=>item.event===method),row.cli+' omitted '+method);
      evidence.push({cli:row.cli,probe:row.probe,observed:[...new Set(entries.map(item=>item.event))]});
    }
    const missing=[];
    for(const {cli,command} of cases){
      const count=(await rows()).length;
      const exactLauncher=join(root,'bin',command), hidden=join(root,'missing-'+command);
      // Remove only the launcher under test. Every other mock stays available
      // so an accidental cross-runtime fallback is also observed.
      await rename(exactLauncher,hidden);
      try {
        const value=await statusOf(cli);
        assert.equal(value.status,'unavailable',cli+' unexpectedly passed without its launcher');
        assert.equal(value.diagnostics.executable,'missing');
        if(cli==='claude')assert.equal(value.diagnostics.standaloneClaude,true);
        assert.equal((await rows()).length,count,cli+' missing starter ran another command');
        missing.push(cli);
      } finally { await rename(hidden,exactLauncher); }
    }
    service.send({type:'mandala:stop'});
    let timer;
    try { assert.deepEqual(await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture shutdown timed out')),12000);})]),[0,null]); }
    finally { clearTimeout(timer); }
    return {commit:build.commit,version:build.version,node:build.node,platform:build.platform,arch:build.arch,evidence,missing,prompts:0,realVendorLaunches:0};
  } finally {
    if(service?.exitCode===null && service?.signalCode===null){
      service.kill('SIGKILL'); await exited?.catch(()=>{});
    }
  }
}

async function run(path, expectedCommit) {
  assert.equal(process.platform,'darwin','Mac pilot only: do not run a missing-command probe on Windows registry PATH');
  assert(path && /^[a-f0-9]{40}$/.test(expectedCommit??''),'Pass staged runtime path and exact source SHA');
  const runtime=await realpath(path);
  assert(runtime.startsWith('/private/tmp/') && runtime.endsWith('.app/Contents/Resources/runtime'),'Only staged /private/tmp desktop packages are accepted');
  const app=resolve(runtime,'../../..');
  const build=JSON.parse(await readFile(join(runtime,'build.json'),'utf8'));
  assert.equal(build.commit,expectedCommit);
  assert.equal(build.sourceDirty,false);
  assert.equal(build.platform,'darwin');
  assert.equal(build.arch,process.arch);
  const verified=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:20000});
  assert.equal(verified.status,0,'Staged package signature verification failed');
  const node=join(runtime,'bin','node');
  const metadata=await lstat(node);
  assert((await lstat(join(runtime,'server','pi-permission-extension.mjs'))).isFile(),'Missing packaged Pi permission extension');
  assert(metadata.isFile() && !metadata.isSymbolicLink(),'Unexpected Node binary layout');
  const root=await realpath(await mkdtemp('/private/tmp/mandala-conformance-'));
  try{
    const bin=join(root,'bin'),user=join(root,'user'),home=join(root,'data'),scratch=join(root,'scratch'),ledger=join(root,'ledger');
    for(const dir of [bin,user,home,scratch])await mkdir(dir,{mode:0o700});
    await writeFile(ledger,'',{mode:0o600});
    // Build exact, audited fixture files. No package/ambient/login/default PATH is searched.
    const launchers=[...cases.map(item=>item.command),guard];
    for(const name of launchers){
      const file=join(bin,name);
      await writeFile(file,'#!/usr/bin/env node\n'+
        'process.argv.splice(2,0,"--shim",'+JSON.stringify(name)+','+JSON.stringify(ledger)+');\n'+
        'process.env.MANDALA_QA_TEST_ROOT='+JSON.stringify(root)+';\n'+
        'process.env.MANDALA_QA_TEST_RUNTIME='+JSON.stringify(runtime)+';\n'+
        'void import('+JSON.stringify(script)+');\n',{mode:0o700,flag:'wx'});
    }
    // Byte copy the staged Node into PATH; chmod never touches the package.
    const nodeLauncher=join(bin,'node');
    await copyFile(node,nodeLauncher,constants.COPYFILE_EXCL);
    await chmod(nodeLauncher,0o700);
    assert.deepEqual((await readdir(bin)).sort(),[...launchers,'node'].sort());
    const asLiteral=path=>'(literal '+JSON.stringify(path)+')';
    const profile=[
      '(version 1)','(allow default)','(deny network*)',
      '(allow network-bind (local ip "localhost:*"))','(allow network-inbound (local ip "localhost:*"))','(allow network-outbound (remote ip "localhost:*"))',
      '(deny process-exec)','(allow process-exec '+[node,nodeLauncher,'/usr/bin/env',...launchers.map(name=>join(bin,name))].map(asLiteral).join(' ')+')',
      '(deny file-read* file-write* (subpath '+JSON.stringify(homedir())+'))',
    ].join('\n');
    // The worker's request/start/stop deadlines are below this outer ceiling.
    // If the worker itself is terminated, the nonpersistent backend receives
    // IPC disconnect and its desktop lifecycle shuts down.
    const result=spawnSync('/usr/bin/sandbox-exec',['-p',profile,node,script,'--worker',runtime,root,node,expectedCommit],{
      cwd:root,env:{HOME:user,PATH:bin,TMPDIR:scratch,LANG:'C',NO_PROXY:'*',MANDALA_HOME:home,MANDALA_PORT:'0',MANDALA_DESKTOP:'1'},
      encoding:'utf8',timeout:(2*cases.length+4)*18000+45000,maxBuffer:256*1024,
    });
    assert.equal(result.status,0,result.stderr||result.error?.message||'Conformance exited without evidence');
    return JSON.parse(result.stdout);
  }finally{await rm(root,{recursive:true,force:true});}
}

const [, , mode, ...args]=process.argv;
if(mode==='--shim'){
  shim(args[0],args[1],process.env.MANDALA_QA_TEST_ROOT,process.env.MANDALA_QA_TEST_RUNTIME);
}else if(mode==='--worker'){
  const [runtime,root,node,expectedCommit]=args;
  // Do not permit direct invocation: the worker itself verifies the exec sandbox.
  const build=JSON.parse(await readFile(join(runtime,'build.json'),'utf8'));
  assert.equal(build.commit,expectedCommit);
  console.log(JSON.stringify(await worker(runtime,root,node,build)));
}else{
  console.log(JSON.stringify(await run(mode,args[0]),null,2));
}
