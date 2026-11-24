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
import { createHash } from 'node:crypto';
import bridge from './claude-bridge/manifest.json' with { type:'json' };
import cases from './desktop-runtime-conformance-cases.json' with { type:'json' };

const script = fileURLToPath(import.meta.url);
const guard = 'claude-agent-acp';
const deny = ['EPERM','EACCES'];

const fixtureInput='Mandala synthetic package first-turn fixture';
const fixtureAnswer=cli=>'Synthetic package result for '+cli;
const streamId='89d89771-5861-4e5c-ab40-d97fde6b1f91';
const approvedMethods=new Set(['config/read','thread/start','thread/read','thread/backgroundTerminals/list','mcpServerStatus/list','skills/list','get_available_commands','session/new','session/load','session/resume']);
const isInput=text=>typeof text==='string'&&(text===fixtureInput||text.endsWith('\n\n'+fixtureInput));

function claudeFixture(row, args, canPrompt, record, bad) {
  const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
  if (args.length===1 && args[0]==='--version') {
    record('--version'); process.stdout.write(row.nativeVersion+' (Claude Code)\n'); return;
  }
  if (args.join(' ')==='auth status --json') {
    record('auth-status'); emit({loggedIn:true,authMethod:'fixture'}); return;
  }
  const sessionId=args.find(arg=>arg.startsWith('--session-id='))?.slice('--session-id='.length);
  if (!sessionId || !args.includes('--input-format') || !args.includes('--permission-mode=default') ||
      args.some(arg=>arg.startsWith('--mcp-config')||arg.startsWith('--allow-dangerously-skip-permissions'))) return bad('claude-argv');
  createInterface({input:process.stdin}).on('line',line=>{
    let request;
    try { request=JSON.parse(line); } catch { return bad('claude-json'); }
    if (request.type==='control_request' && ['initialize','get_settings','get_context_usage','interrupt'].includes(request.request?.subtype)) {
      record('sdk/'+request.request.subtype);
      emit({type:'control_response',response:{subtype:'success',request_id:request.request_id,
        response:{models:[],commands:[],account:{},mcp_servers_applied:true}}});
      return;
    }
    if (request.type!=='user' || !canPrompt || !request.message?.content?.some(block=>isInput(block.text))) return bad('claude-request');
    record('sdk/user');
    const answer=fixtureAnswer(row.cli), usage={input_tokens:1,output_tokens:1};
    emit({type:'assistant',session_id:sessionId,parent_tool_use_id:null,uuid:streamId,
      message:{id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-4-6',
        content:[{type:'text',text:answer}],stop_reason:'end_turn',stop_sequence:null,usage}});
    emit({type:'result',subtype:'success',session_id:sessionId,uuid:streamId,result:answer,
      stop_reason:'end_turn',total_cost_usd:0,duration_ms:1,duration_api_ms:1,is_error:false,
      num_turns:1,usage,modelUsage:{},permission_denials:[]});
  });
}

function shim(name, ledger, fixtureRoot, runtime, firstTurn) {
  const record = event => appendFileSync(ledger, JSON.stringify({ name, event })+'\n');
  const bad = (stage='rpc') => { record('unexpected-'+stage); process.exit(88); };
  const row = cases.find(item => item.command === name);
  record('launch');
  const args = process.argv.slice(5);
  if (!row || process.env.HOME !== join(fixtureRoot,'user') ||
      process.env.PATH !== join(fixtureRoot,'bin') ||
      !(process.cwd().startsWith(join(fixtureRoot,'scratch','mana-catalog-')) || firstTurn&&process.cwd()===join(fixtureRoot,'scratch','turn-'+row?.cli)) ||
      Object.entries(process.env).some(([name,value]) => value && /^(OPENAI_|ANTHROPIC_|CLAUDE_CONFIG_DIR|HTTPS?_PROXY|ALL_PROXY|NODE_OPTIONS|NODE_PATH)/i.test(name))) bad('isolation');
  const exact=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
  const expectedArgs=row.args.map(arg=>arg.replace('$scratch-cwd',process.cwd()).replace('$pi-extension',join(runtime,'server','pi-permission-extension.mjs')));
  const acp=row.probe==='acp'||row.probe==='gateway-session';
  const turn=firstTurn&&process.cwd()===join(fixtureRoot,'scratch','turn-'+row.cli);
  if (row.cli==='claude') return claudeFixture(row,args,turn,record,bad);
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
  const answer=fixtureAnswer(row.cli), emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  if(turn&&row.probe==='version-only'){
    if(row.cli==='cursor'&&exact(args,['create-chat'])){record('create-chat');process.stdout.write(streamId+'\n');return;}
    const valid=row.cli==='cursor'
      ? exact(args.slice(0,-1),['--print','--output-format','stream-json','--force','--workspace',process.cwd(),'--resume',streamId])&&isInput(args.at(-1))
      : exact([args[0],...args.slice(2)],['--print','--output-format','stream-json','--dangerously-skip-permissions'])&&isInput(args[1]);
    if(!valid)return bad('argv');
    record('stream-result');
    emit(row.cli==='cursor'?{type:'result',session_id:streamId,result:answer,is_error:false}:{type:'result',result:{conversation_id:streamId,status:'success',response:answer}});
    return;
  }
  const syntheticOmp=turn&&row.cli==='omp'&&exact(args.slice(0,3),expectedArgs.slice(0,3))&&
    args.slice(3).every((arg,i,tail)=>arg==='--plugin-dir'&&tail[i+1]?.startsWith(join(fixtureRoot,'data','runtime')+'/')||
      arg.startsWith(join(fixtureRoot,'data','runtime')+'/')&&tail[i-1]==='--plugin-dir'||
      arg.startsWith('--append-system-prompt='+join(fixtureRoot,'data','runtime')+'/')&&arg.endsWith('/instructions.md')||
      arg.startsWith('--add-dir='+join(fixtureRoot,'data')+'/'));
  if (!exact(args,expectedArgs)&&!syntheticOmp) bad('argv');
  if (row.probe==='version-only') { record('version'); process.stdout.write(row.version+'\n'); return; }
  if (row.cli==='omp') process.stdout.write('{"type":"ready"}\n');

  const sessionId = 'synthetic-session-'+row.cli, turnId='synthetic-turn-'+row.cli;
  const assistant={role:'assistant',model:'fixture',stopReason:'stop',content:[{type:'text',text:answer}]};
  const completed=()=>emit({method:'turn/completed',params:{threadId:sessionId,turn:{id:turnId,status:'completed'}}});
  const reader = createInterface({input:process.stdin});
  reader.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { return bad(); }
    const {id, params} = request;
    const method=row.probe==='rpc'?request.type:request.method;
    // The fixture never sends a prompt, and fails if the package tries one.
    if (!row.methods.includes(method) && !row.optionalMethods?.includes(method) &&
        !(turn&&(method===row.firstTurn.method||approvedMethods.has(method)))) return bad();
    record(method);
    if (id === undefined && method === 'initialized') return;
    let result;
    if (row.probe==='rpc') {
      if(typeof id!=='string')return bad();
      if(method==='prompt'){
        if(!turn||!isInput(request.message))return bad();
        emit({type:'response',id,success:true,data:{}});
        setTimeout(()=>{emit({type:'agent_start'});emit({type:'message_start',message:assistant});emit({type:'message_update',message:assistant,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:answer}});emit({type:'message_end',message:assistant});emit({type:'agent_end',messages:[assistant]});},35);
        return;
      }
      if(!['get_state','get_commands','get_available_commands'].includes(method))return bad();
      const data=method==='get_state'?{sessionFile:join(process.cwd(),'fixture-session'),model:{id:'synthetic',provider:'fixture'}}:
        method==='get_commands'?{commands:[{name:'mandala-permission-gate',source:'extension',sourceInfo:{path:join(runtime,'server','pi-permission-extension.mjs')}}]}:{commands:[]};
      process.stdout.write(JSON.stringify({type:'response',id,success:true,data})+'\n');
      return;
    }
    if (row.cli === 'codex') {
      if(method === 'initialize') result={userAgent:'fixture/'+row.version};
      if(method === 'account/read' && params?.refreshToken === false) result={requiresOpenaiAuth:true,account:{type:'chatgpt'}};
      if(turn&&method==='config/read')result={config:{approval_policy:'on-request',sandbox_mode:'read-only'}};
      if(turn&&method==='thread/start'&&params?.cwd===process.cwd())result={thread:{id:sessionId}};
      if(turn&&method==='thread/read'&&params?.threadId===sessionId)result={thread:{id:sessionId,turns:[]}};
      if(turn&&['thread/backgroundTerminals/list','mcpServerStatus/list','skills/list'].includes(method))result={data:[],nextCursor:null};
      if(turn&&method==='turn/start'&&params?.threadId===sessionId&&params?.input?.length===1&&isInput(params.input[0]?.text)){
        result={turn:{id:turnId,status:'inProgress'}};
        setTimeout(()=>{emit({method:'turn/started',params:{threadId:sessionId,turn:{id:turnId,status:'inProgress'}}});
          emit({method:'item/agentMessage/delta',params:{threadId:sessionId,turnId,itemId:'fixture-message',delta:answer}});
          emit({method:'item/completed',params:{threadId:sessionId,turnId,item:{id:'fixture-message',type:'agentMessage',phase:'final_answer',text:answer}}});completed();},35);
      }
    } else {
      if(method === 'initialize') result={protocolVersion:1,agentInfo:{name:'fixture',version:row.version},agentCapabilities:row.cli==='openclaw'?{sessionCapabilities:{resume:{}}}:{loadSession:true}};
      if(method === 'session/new' && params?.mcpServers?.length === 0) result={sessionId};
      if(['session/load','session/resume'].includes(method) && params?.sessionId === sessionId && params?.mcpServers?.length === 0) result={};
      if(turn&&method==='session/prompt'&&params?.sessionId===sessionId&&params.prompt?.length===1&&isInput(params.prompt[0]?.text)){
        emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});
        result={stopReason:'end_turn'};
      }
    }
    if (!result || id === undefined) return bad();
    process.stdout.write(JSON.stringify({...row.cli==='codex'?{}:{jsonrpc:'2.0'},id,result})+'\n');
  });
}

async function worker(runtime, root, node, build, firstTurn) {
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
      if(row.cli==='claude')assert.equal(value.diagnostics.nativeVersion,row.nativeVersion);
      assert.equal(value.diagnostics.probe,row.probe);
      assert.equal(value.diagnostics.auth,row.auth);
      assert.equal(value.diagnostics.executable,'executable');
      assert(entries.length>0 && entries.every(item=>item.name===row.command&&!item.event.startsWith('unexpected-')),row.cli+' used a wrong launcher or method');
      assert(entries.some(item=>item.event==='launch'));
      for(const method of row.methods)assert(entries.some(item=>item.event===method),row.cli+' omitted '+method);
      if(row.probe==='rpc')assert.equal(entries.filter(item=>item.event==='get_state').length,2,row.cli+' must start and probe independently');
      if(row.probe==='version-only')assert(entries.some(item=>item.event==='version'));
      if(row.cli==='openclaw') for(const method of ['local-config','model-catalog'])assert(entries.some(item=>item.event===method),row.cli+' omitted '+method);
      if(row.cli==='claude'){
        const models=await api('/api/models?scope=runtime&cli=claude',{headers});
        assert.equal(models.status,200);
        const modelTrace=(await rows()).slice(previous+entries.length);
        assert(modelTrace.some(item=>item.event==='sdk/initialize'));
        assert(modelTrace.every(item=>item.name==='claude'&&item.event!=='sdk/user'&&!item.event.startsWith('unexpected-')));
      }
      evidence.push({cli:row.cli,probe:row.probe,observed:[...new Set(entries.map(item=>item.event))]});
    }
    const syntheticFirstTurns=[];
    if(firstTurn){
      const saved=await (await api('/api/config',{headers})).json();
      const jsonHeaders={...headers,Origin:origin,'Content-Type':'application/json'};
      const mutate=(path,method,json)=>api(path,{method,headers:jsonHeaders,body:JSON.stringify(json)});
      const updated=await mutate('/api/config','PUT',{revision:saved.revision,config:{...saved.config,runtimes:cases.map(row=>row.cli),system:{automaticTitles:false,memoryCapture:false}}});
      assert.equal(updated.status,200,'Could not set fixture-only runtime catalog');
      const failures=[];
      for(const row of cases){
       try {
        const cwd=join(root,'scratch','turn-'+row.cli);
        await mkdir(cwd,{mode:0o700});
        const start=(await rows()).length;
        const created=await mutate('/api/conversations','POST',{cli:row.cli,cwd,approvalMode:'default'});
        assert.equal(created.status,201,row.cli+' conversation creation failed');
        const {id}=await created.json();
        assert(/^[a-zA-Z0-9_-]+$/.test(id),'Invalid fixture conversation ID');
        const path='/api/conversations/'+id;
        const sent=await mutate(path+'/messages','POST',{text:fixtureInput});
        assert.equal(sent.status,200,row.cli+' first turn rejected: '+(await rows()).slice(start).map(x=>x.event).join(','));
        let approval=false, nativeId;
        for(let tries=0;tries<40&&!nativeId;tries++){
          const snapshot=await (await api(path,{headers})).json();
          assert(!['error','interrupted'].includes(snapshot.conversation?.status),row.cli+' synthetic turn failed: '+(await rows()).slice(start).map(x=>x.event).join(','));
          if(snapshot.approvals?.length){
            assert(row.firstTurn.approval&&!approval&&snapshot.approvals.length===1,row.cli+' unexpected approval count');
            const [request]=snapshot.approvals;
            assert(request.method==='acp/permission'&&request.params?.wholeTurnApproval===true,row.cli+' unexpected approval type');
            assert(!(await rows()).slice(start).some(x=>x.event===row.firstTurn.method),row.cli+' sent before fixture approval');
            assert.equal((await mutate(path+'/approvals/'+encodeURIComponent(request.id),'POST',{decision:'approve'})).status,200);
            approval=true;
          }
          if(snapshot.conversation?.status==='idle' && typeof snapshot.conversation?.nativeId==='string')nativeId=snapshot.conversation.nativeId;
          if(!nativeId)await new Promise(resolve=>setTimeout(resolve,30));
        }
        assert(nativeId&&approval===row.firstTurn.approval,row.cli+' final/approval state mismatch');
        const stream=(await api(path+'/events',{headers})).body;
        assert(stream,'Fixture history response had no body');
        const reader=stream.getReader(), decoder=new TextDecoder();
        let buffer='';
        try {
          while(!buffer.includes('event: history-ready')){
            const {done,value}=await reader.read();
            if(done)break;
            buffer+=decoder.decode(value,{stream:true});
            assert(buffer.length<512*1024,'Fixture history exceeded bound');
          }
        } finally { await reader.cancel(); }
        const events=buffer.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
        assert.equal(events.filter(event=>event.kind==='user'&&event.data?.text===fixtureInput).length,1);
        assert.equal(events.filter(event=>event.kind==='text'&&event.data?.text===fixtureAnswer(row.cli)).length,1,row.cli+' missing fixture answer in saved history');
        const terminal=events.filter(event=>event.kind==='tool'&&event.data?.method==='turn/completed');
        assert.equal(terminal.length,1,row.cli+' did not save one terminal event');
        assert(terminal[0].data.params.threadId===nativeId&&terminal[0].data.params.turn?.status==='completed',row.cli+' final result was not correlated with its original native session');
        assert(!events.some(event=>event.kind==='error'),row.cli+' saved an unexpected error');
        const trace=(await rows()).slice(start);
        assert(trace.every(item=>item.name===row.command&&!item.event.startsWith('unexpected-')),row.cli+' wrong executable or protocol operation');
        assert.equal(trace.filter(item=>item.event===row.firstTurn.method).length,1,row.cli+' first turn did not cross protocol exactly once');
        syntheticFirstTurns.push({cli:row.cli,method:row.firstTurn.method,approval,answerRetained:true});
       }catch(error){failures.push(row.cli+': '+error.message.split('\n')[0]);}
      }
      assert.equal(failures.length,0,'Synthetic first-turn failures ('+syntheticFirstTurns.length+' passed): '+failures.join('; '));
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
        assert.equal((await rows()).length,count,cli+' missing starter ran another command');
        missing.push(cli);
      } finally { await rename(hidden,exactLauncher); }
    }
    service.send({type:'mandala:stop'});
    let timer;
    try { assert.deepEqual(await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture shutdown timed out')),12000);})]),[0,null]); }
    finally { clearTimeout(timer); }
    return {commit:build.commit,version:build.version,node:build.node,platform:build.platform,arch:build.arch,evidence,missing,...firstTurn?{syntheticFirstTurns}:{},prompts:syntheticFirstTurns.length,realVendorLaunches:0};
  } finally {
    if(service?.exitCode===null && service?.signalCode===null){
      service.kill('SIGKILL'); await exited?.catch(()=>{});
    }
  }
}

async function run(path, expectedCommit, firstTurn) {
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
  const bridgeFile=join(runtime,'server','ssh-runner',bridge.entry);
  assert((await lstat(bridgeFile)).isFile(),'Missing packaged Claude bridge');
  assert.equal(createHash('sha256').update(await readFile(bridgeFile)).digest('hex'),bridge.sha256);
  assert((await lstat(join(runtime,'server','ssh-runner',bridge.notices))).isFile(),'Missing packaged Claude bridge notices');
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
        'process.env.MANDALA_QA_TEST_FIRST_TURN='+JSON.stringify(firstTurn?'1':'0')+';\n'+
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
    const result=spawnSync('/usr/bin/sandbox-exec',['-p',profile,node,script,'--worker',runtime,root,node,expectedCommit,firstTurn?'1':'0'],{
      cwd:root,env:{HOME:user,PATH:bin,TMPDIR:scratch,LANG:'C',NO_PROXY:'*',MANDALA_HOME:home,MANDALA_PORT:'0',MANDALA_DESKTOP:'1'},
      encoding:'utf8',timeout:(2*cases.length+4+(firstTurn?cases.length*8:0))*18000+45000,maxBuffer:256*1024,
    });
    assert.equal(result.status,0,result.stderr||result.error?.message||'Conformance exited without evidence');
    return JSON.parse(result.stdout);
  }finally{await rm(root,{recursive:true,force:true});}
}

const [, , mode, ...args]=process.argv;
if(mode==='--shim'){
  shim(args[0],args[1],process.env.MANDALA_QA_TEST_ROOT,process.env.MANDALA_QA_TEST_RUNTIME,process.env.MANDALA_QA_TEST_FIRST_TURN==='1');
}else if(mode==='--worker'){
  const [runtime,root,node,expectedCommit,firstTurn]=args;
  // Do not permit direct invocation: the worker itself verifies the exec sandbox.
  const build=JSON.parse(await readFile(join(runtime,'build.json'),'utf8'));
  assert.equal(build.commit,expectedCommit);
  console.log(JSON.stringify(await worker(runtime,root,node,build,firstTurn==='1')));
}else{
  assert(args.length===1||args.length===2&&args[1]==='--synthetic-first-turn','Pass staged runtime path, exact SHA, and optional --synthetic-first-turn');
  console.log(JSON.stringify(await run(mode,args[0],args[1]==='--synthetic-first-turn'),null,2));
}
