import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRpcClient, type RpcMessage } from "../server/rpc";
import { connectCodex, startCodex } from "../server/codex";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
it("passes_agent_instructions_and_parses_native_ids_and_models", async () => {
  let start!: RpcMessage;
  const rpc = createRpcClient(
    spawn(process.execPath, ["tests/fixtures/fake-cli.mjs"], { stdio: "pipe" }),
    {
      onNotification: (m) => {
        start = m;
      },
    },
  );
  const cli = await connectCodex(rpc);
  try {
    expect(await cli.listModels()).toEqual([
      { id: "model-fixture", label: "Fixture" },
    ]);
    expect(
      await cli.startThread({
        cwd: "/tmp",
        instructions: "Review changes carefully.",
        model: "model-fixture",
      }),
    ).toBe("native-1");
    expect(start.params).toMatchObject({
      developerInstructions: "Review changes carefully.",
      cwd: "/tmp",
      model: "model-fixture",
    });
    expect(await cli.startTurn("native-1", "hello")).toBe("turn-1");
    await cli.resumeThread("native-1");
  } finally {
    cli.close();
  }
});
it("reports_native_login_requirement_without_exposing_account_identity", async () => {
  const cli = await connectCodex(
    createRpcClient(
      spawn(process.execPath, ["tests/fixtures/fake-cli.mjs"], {
        stdio: "pipe",
      }),
      {},
    ),
  );
  try {
    expect(await cli.getStatus()).toEqual({
      status: "ready",
      version: "0.154.0",
    });
  } finally {
    cli.close();
  }
});
it.each([
  ["--logged-out", "login-required"],
  ["--custom-provider", "ready"],
])("respects native authentication requirements %s", async (flag, status) => {
  const cli = await connectCodex(
    createRpcClient(
      spawn(process.execPath, ["tests/fixtures/fake-cli.mjs", flag], {
        stdio: "pipe",
      }),
      {},
    ),
  );
  try {
    expect(await cli.getStatus()).toEqual({ status, version: "0.154.0" });
  } finally {
    cli.close();
  }
});
it.each([
  { profile: ["--profile", "personal"] },
  { profile: ["--profile=personal"] },
  { profile: ["-p", "personal"] },
])("starts Codex with its native profile before the app-server subcommand", async ({ profile }) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-codex-runtime-"));
  const executable = join(dir, "codex");
  const capture = join(dir, "launch.json");
  await writeFile(executable, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), value: process.env.MANA_RUNTIME_TEST, inherited: process.env.PATH }));
import(${JSON.stringify(resolve("tests/fixtures/fake-cli.mjs"))});
`);
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  let client;
  try {
    client = await startCodex({ cwd: dir, extraArgs: ["--strict-config", ...profile], env: { MANA_RUNTIME_TEST: "resolved-value" },
      onEvent() {}, onApproval() {}, onExit() {} });
    const launch = JSON.parse(await readFile(capture, "utf8"));
    expect(launch.args).toEqual([...profile, "app-server", "--stdio", "--strict-config"]);
    expect(launch.value).toBe("resolved-value");
    expect(launch.inherited).toBe(process.env.PATH);
  } finally {
    client?.close();
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
it("keeps system threads read-only while ordinary threads default to full access", async () => {
  const starts: RpcMessage[] = [];
  const cli = await connectCodex(createRpcClient(
    spawn(process.execPath, ["tests/fixtures/fake-cli.mjs"], { stdio: "pipe" }),
    { onNotification: (message) => { if (message.method === "fixture/start") starts.push(message); } },
  ));
  try {
    await cli.startThread({ cwd: "/tmp", instructions: "Generate a title.", ephemeral: true, safeSystem: true });
    expect(starts[0].params).toMatchObject({ ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    await cli.startThread({ cwd: "/tmp", instructions: "Ordinary chat." });
    expect(starts[1].params.ephemeral).toBe(false);
    expect(starts[1].params.sandbox).toBe("danger-full-access");
    expect(starts[1].params).not.toHaveProperty("approvalPolicy");
  } finally { cli.close(); }
});

it("forks before the exact native turn and verifies the retained prefix", async () => {
  const calls: { method: string; params: any }[] = [];
  const turns = ["first", "second", "third"].map((text, index) => ({ id: `turn-${index}`,
    items: [{ type: "userMessage", content: [{ type: "text", text }] }] }));
  const cli = await connectCodex({
    async request(method, params: any) {
      calls.push({ method, params });
      if (method === "initialize") return { userAgent: "codex/0.154.0" };
      if (method === "thread/read") return { thread: { turns: params.threadId === "original" ? turns : turns.slice(0, 1) } };
      if (method === "thread/fork") return { thread: { id: "forked" } };
      if (method === "config/read") return {config:{}};
      if (method === "thread/resume" || method === "thread/inject_items") return {};
      throw new Error("Unexpected request");
    }, notify() {}, reply() {}, close() {},
  });
  expect(await cli.forkThread!("original", ["first", "second", "third"], 1)).toBe("forked");
  expect(calls.find(call => call.method === "thread/fork")?.params)
    .toEqual({ threadId: "original", beforeTurnId: "turn-1", deferGoalContinuation: true });
  await expect(cli.forkThread!("original", ["different", "second", "third"], 1)).rejects.toThrow("Native message history does not match");
  expect(calls.filter(call => call.method === "thread/fork")).toHaveLength(1);
  await cli.forkThread!("original", ["first", "second", "third"], 1, "selected-model");
  expect(calls.filter(call => call.method === "thread/fork").at(-1)?.params.model).toBe("selected-model");
  await cli.resumeThread("forked", [], "Instructions", "selected-model");
  expect(calls.find(call => call.method === "thread/resume")?.params.model).toBe("selected-model");
});

it("does not accept a native fork that silently retains the edited turn", async () => {
  const turns = [{ id: "turn-1", items: [{ type: "userMessage", content: [{ type: "text", text: "old text" }] }] }];
  const cli = await connectCodex({
    async request(method) {
      if (method === "initialize") return {};
      if (method === "thread/read") return { thread: { turns } };
      if (method === "thread/fork") return { thread: { id: "new-thread" } };
      throw new Error("Unexpected request");
    }, notify() {}, reply() {}, close() {},
  });
  await expect(cli.forkThread!("original", ["old text"], 0)).rejects.toThrow("Native branch prefix could not be verified");
});

it.each([1, 2])("forks through %s completed replies and verifies assistant content", async count => {
  const turns = ["one", "two"].map((text, index) => ({id:`t-${index}`, items:[
    {type:"userMessage", content:[{type:"text", text}]}, {type:"agentMessage", text:`answer ${text}`},
  ]}));
  let params: any, corrupt = false;
  const client = await connectCodex({
    async request(method, p: any) {
      if (method === "initialize") return {};
      if (method === "thread/fork") {params = p; return {thread:{id:"fork"}};}
      if (method === "thread/read") return {thread:{turns:p.threadId === "source" ? turns : turns.slice(0,count).map(turn => ({...turn, items:corrupt ? turn.items.filter(item => item.type === "userMessage") : turn.items}))}};
      throw Error("unexpected request");
    }, notify(){}, reply(){}, close(){},
  });
  expect(await client.forkThread!("source", ["one","two"], count)).toBe("fork");
  if (count === 2) expect(params).not.toHaveProperty("beforeTurnId");
  else expect(params.beforeTurnId).toBe("t-1");
  corrupt = true;
  await expect(client.forkThread!("source", ["one","two"], count)).rejects.toThrow("Native branch prefix could not be verified");
});
it('inspects exact native turn terminal only; other sessions, missing turns and inProgress remain unknown',async()=>{
 let response:any={thread:{id:'session',turns:[{id:'other',status:'completed'},{id:'turn',status:'inProgress'}]}};
 const calls:{method:string;params:unknown}[]=[];
 const cli=await connectCodex({request:async(method:string,params:unknown)=>{calls.push({method,params});return method==='initialize'?{userAgent:'fixture/0.160.0'}:response;},notify(){},close(){}} as any);
 const identity={runId:'run',hostId:'local',nativeSessionId:'session',nativeTurnId:'turn'};
 expect(await cli.inspectInvocation!(identity)).toBe('unknown');response.thread.turns[1].status='completed';expect(await cli.inspectInvocation!(identity)).toBe('succeeded');
 response.thread.turns[1].status='failed';expect(await cli.inspectInvocation!(identity)).toBe('failed');
 expect(await cli.inspectInvocation!({...identity,nativeTurnId:'missing'})).toBe('unknown');response.thread.id='wrong-session';expect(await cli.inspectInvocation!(identity)).toBe('unknown');
 expect(calls.filter(c=>c.method!=='initialize').every(c=>c.method==='thread/read'&&JSON.stringify(c.params)===JSON.stringify({threadId:'session',includeTurns:true}))).toBe(true);
});

it('passes trusted per-attempt output roots without replacing native permission policy',async()=>{
 const requests:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{requests.push({method,params});return method==='initialize'?{userAgent:'codex/0.160.0'}:method==='thread/start'?{thread:{id:'root-thread'}}:{turn:{id:'root-turn'}};},notify(){},reply(){},close(){}};
 const client=await connectCodex(rpc as any,'/selected');
 await client.startThread({cwd:'/selected',instructions:'',runtimeWorkspaceRoots:['/selected','/managed/output']} as any);
 await (client.startTurn as any)('root-thread','write actual output',undefined,['/selected','/managed/output']);
 expect(requests.find(r=>r.method==='thread/start')?.params).toMatchObject({runtimeWorkspaceRoots:['/selected','/managed/output']});
 expect(requests.find(r=>r.method==='turn/start')?.params).toMatchObject({runtimeWorkspaceRoots:['/selected','/managed/output']});
 expect(requests.find(r=>r.method==='turn/start')?.params).not.toHaveProperty('sandboxPolicy');
});

it("waits for native cleanup before rejecting failed initialization", async () => {
  let release!:()=>void, closing!:()=>void;
  const cleanup = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>closing=resolve);
  let rejected=false, cleaned=false;
  const connecting=connectCodex({request:async()=>{throw new Error('synthetic initialization rejected');},notify(){},reply(){},close:async()=>{closing();await cleanup;cleaned=true;}}).catch(error=>{rejected=true;return error.message;});
  await started;await Promise.resolve();const rejectedBeforeCleanup=rejected;release();
  expect(await connecting).toBe('synthetic initialization rejected');expect(rejectedBeforeCleanup).toBe(false);expect(cleaned).toBe(true);
});

it('applies explicit full access to new and resumed Agent threads while keeping system threads read-only',async()=>{
 const calls:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:{thread:{id:'thread'}};},notify(){},reply(){},close(){}};
 const cli=await (connectCodex as any)(rpc,'/workspace',true);
 await cli.startThread({cwd:'/workspace',instructions:''});await cli.resumeThread('thread');
 expect(calls.find(c=>c.method==='thread/start')?.params.sandbox).toBe('danger-full-access');
 expect(calls.find(c=>c.method==='thread/resume')?.params.sandbox).toBe('danger-full-access');
 await cli.startThread({cwd:'/workspace',instructions:'',safeSystem:true});
 expect(calls.filter(c=>c.method==='thread/start').at(-1)?.params.sandbox).toBe('read-only');
});

it.each([{sandbox_mode:'read-only'}, {default_permissions:'restricted-agent'}, {}])('restores current native permissions on resume when full access is disabled: %j',async(config)=>{
 const calls:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:method==='config/read'?{config}:{};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);await cli.resumeThread('previous-full-access-thread');
 const params=calls.find(c=>c.method==='thread/resume')?.params;
 if('default_permissions' in config)expect(params.permissions).toBe('restricted-agent');
 else expect(params.sandbox).toBe('sandbox_mode' in config?'read-only':'workspace-write');
});

it('refreshes constrained invocation roots on native resume without enabling network or full access',async()=>{
 const calls:RpcMessage[]=[];
 const config={sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:false}};
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:method==='config/read'?{config}:method==='thread/start'?{thread:{id:'thread'}}:{};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);
 await cli.startThread({cwd:'/workspace',instructions:'',runtimeWorkspaceRoots:['/workspace','/private/first/mailbox'],runtimeMailboxPath:'/private/first/mailbox'});
 await cli.resumeThread('thread',[], 'New command',undefined,['/workspace','/private/second/mailbox'],'/private/second/mailbox');
 const start=calls.find(c=>c.method==='thread/start')!.params, resume=calls.find(c=>c.method==='thread/resume')!.params;
 expect(start.runtimeWorkspaceRoots).toEqual(['/workspace','/private/first/mailbox']);
 expect(start).not.toHaveProperty('sandbox');
 expect(resume).toMatchObject({sandbox:'workspace-write',runtimeWorkspaceRoots:['/workspace','/private/second/mailbox']});
 expect(resume).not.toHaveProperty('sandboxPolicy');
 expect(resume.config).not.toHaveProperty('sandbox_workspace_write');
 expect(config.sandbox_workspace_write.network_access).toBe(false);
 expect(await cli.requiresRuntimeReload!('/private/second/mailbox')).toBe(false);
 expect(await cli.requiresRuntimeReload!('/private/third/mailbox')).toBe(true);
});

it.each([{fullAccess:true,safeSystem:false},{fullAccess:false,safeSystem:true}])('does not derive IPC permissions for full-access or safe system threads: %j',async({fullAccess,safeSystem})=>{
 let start!:RpcMessage;
 const rpc={request:async(method:string,params:any)=>{if(method==='config/read')throw new Error('Unexpected permission override');if(method==='thread/start')start={method,params};return method==='initialize'?{}:{thread:{id:'thread'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',fullAccess);
 await cli.startThread({cwd:'/workspace',instructions:'',safeSystem,runtimeMailboxPath:'/private/mailbox'});
 expect(start.params.sandbox).toBe(safeSystem?'read-only':'danger-full-access');
 expect(start.params).not.toHaveProperty('permissions');expect(start.params.config).not.toHaveProperty('permissions');
});

it.each([
 {sandbox_mode:'read-only',approval_policy:'never',sandbox_workspace_write:{network_access:false}},
 {default_permissions:'restricted-agent',permissions:{'restricted-agent':{filesystem:{'/sensitive':'none'},network:{enabled:false}}}},
])('derives a mailbox-only permission profile from the current native restriction: %j',async(config)=>{
 const calls:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:method==='config/read'?{config}:method==='thread/start'?{thread:{id:'thread'}}:{turn:{id:'turn'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);
 await cli.startThread({cwd:'/workspace',instructions:'',mcp:[{name:'reader',transport:'stdio',command:'reader'}],runtimeWorkspaceRoots:['/workspace','/private/first/mailbox'],runtimeMailboxPath:'/private/first/mailbox'} as any);
 await (cli.resumeThread as any)('thread',[],'New command',undefined,['/workspace','/private/second/mailbox'],'/private/second/mailbox');
 const start=calls.find(c=>c.method==='thread/start')!.params, resume=calls.find(c=>c.method==='thread/resume')!.params;
 expect(start.permissions).toEqual(expect.stringMatching(/^mandala-cli-[0-9a-f]+$/));
 expect(start.config.permissions[start.permissions]).toEqual({extends:'default_permissions' in config?'restricted-agent':':read-only',filesystem:{'/private/first/mailbox':'write'}});
 expect(start.config.mcp_servers.reader).toMatchObject({command:'reader'});
 if(config.permissions)expect(start.config.permissions['restricted-agent']).toEqual(config.permissions['restricted-agent']);
 expect(resume.permissions).not.toBe(start.permissions);
 expect(resume.config.permissions[resume.permissions]).toEqual({extends:'default_permissions' in config?'restricted-agent':':read-only',filesystem:{'/private/second/mailbox':'write'}});
 expect(start).not.toHaveProperty('sandbox');expect(resume).not.toHaveProperty('sandbox');
 expect(start.config).not.toHaveProperty('sandbox_workspace_write');expect(resume.config).not.toHaveProperty('approval_policy');
 await cli.startTurn('thread','Use CLI',undefined,['/workspace','/private/second/mailbox']);
 expect(calls.find(c=>c.method==='turn/start')!.params).not.toHaveProperty('sandboxPolicy');
});

it('retains normalized base profiles while omitting null fields from native overrides',async()=>{
 const calls:RpcMessage[]=[];
 const config={default_permissions:'restricted-agent',permissions:{'restricted-agent':{description:null,extends:':read-only',workspace_roots:null,filesystem:{glob_scan_max_depth:0,'/sensitive':'deny'},network:{enabled:false,proxy_url:null,unix_sockets:[]}}}};
 const rpc={request:async(method:string,params:any)=>{
  calls.push({method,params});
  if(method==='initialize')return {};
  if(method==='config/read')return {config};
  if(['thread/start','thread/resume'].includes(method)) {
   if(!params.config.permissions['restricted-agent'])throw new Error('Derived profile extends undefined native profile');
   if(Object.values(params.config.permissions??{}).some((profile:any)=>profile.workspace_roots===null))throw new Error('Native override rejects null profile fields');
   return {thread:{id:'thread'}};
  }
  return {};
 },notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);
 await expect(cli.startThread({cwd:'/workspace',instructions:'',runtimeMailboxPath:'/private/first/mailbox'})).resolves.toBe('thread');
 await expect(cli.resumeThread('thread',[],'New CLI',undefined,undefined,'/private/second/mailbox')).resolves.toBeUndefined();
 for(const call of calls.filter(c=>['thread/start','thread/resume'].includes(c.method??''))) {
  expect(call.params.config.permissions['restricted-agent']).toEqual({extends:':read-only',filesystem:{glob_scan_max_depth:0,'/sensitive':'deny'},network:{enabled:false,unix_sockets:[]}});
  expect(call.params.config.permissions[call.params.permissions].extends).toBe('restricted-agent');
 }
 expect(config.permissions['restricted-agent'].workspace_roots).toBeNull();
});

it('defaults ordinary new and resumed native threads to full access without an Agent override',async()=>{
 const calls:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:{thread:{id:'thread'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace');
 await cli.startThread({cwd:'/workspace',instructions:''});await cli.resumeThread('thread');
 expect(calls.filter(c=>['thread/start','thread/resume'].includes(c.method??'')).every(c=>c.params.sandbox==='danger-full-access')).toBe(true);
});

it('disables the retired built-in MCP on new and resumed threads while preserving third-party servers',async()=>{
 const calls:RpcMessage[]=[];
 const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:{thread:{id:'thread'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace');
 await cli.startThread({cwd:'/workspace',instructions:'',mcp:[{name:'reader',transport:'stdio',command:'reader',args:[]}]});
 await cli.resumeThread('previous-mcp-thread',[],'Use business CLI');
 const start=calls.find(c=>c.method==='thread/start')?.params;
 expect(start.config.mcp_servers.reader).toMatchObject({command:'reader'});
 expect(start.config.mcp_servers.openmana_tasks).toEqual({command:process.execPath,args:['--version'],enabled:false});
 expect(calls.find(c=>c.method==='thread/resume')?.params.config.mcp_servers.openmana_tasks).toEqual({command:process.execPath,args:['--version'],enabled:false});
});

it('sets fresh usage baseline and resets restored baseline before native replay (Codex 0.160.0)',async()=>{
 const events:RpcMessage[]=[];
 const rpc={request:async(method:string)=>{
  if(method==='thread/resume')events.push({method:'thread/tokenUsage/updated',params:{threadId:'thread'}});
  return method==='initialize'?{userAgent:'codex/0.160.0'}:method==='thread/resume'?{thread:{id:'thread'}}:{thread:{id:'thread'},model:'native-default'};
 },notify(){},reply(){},close(){}};
 const cli=await (connectCodex as any)(rpc,'/workspace',true,(event:RpcMessage)=>events.push(event));
 await cli.startThread({cwd:'/workspace',instructions:''});await cli.resumeThread('thread');
 expect(events.map(event=>event.method)).toEqual(['mandala/usageBaseline','mandala/usageBaseline','thread/tokenUsage/updated']);
 expect(events[0].params).toMatchObject({threadId:'thread',fresh:true,model:'native-default'});
 expect(events[1].params).toMatchObject({threadId:'thread',fresh:false});
});
it('refreshes resumed model-visible developer instructions instead of trusting a loaded thread override',async()=>{
 const calls:RpcMessage[]=[];const rpc={request:async(method:string,params:any)=>{calls.push({method,params});return method==='initialize'?{}:method==='config/read'?{config:{sandbox_mode:'workspace-write'}}:{thread:{id:'same-native'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);await cli.startThread({cwd:'/workspace',instructions:'Old launcher'});await cli.resumeThread('same-native',[],'Fresh current launcher');
 const resumed=calls.findIndex(call=>call.method==='thread/resume'),injected=calls.findIndex(call=>call.method==='thread/inject_items');expect(injected).toBeGreaterThan(resumed);expect(calls[injected].params).toMatchObject({threadId:'same-native',items:[{type:'message',role:'developer',content:[{type:'input_text',text:expect.stringContaining('Fresh current launcher')}]}]});
});
it('fails closed when model-visible instruction refresh is rejected before the next native turn',async()=>{
 const rpc={request:async(method:string)=>{if(method==='thread/inject_items')throw Error('Instruction refresh unavailable');return method==='initialize'?{}:method==='config/read'?{config:{sandbox_mode:'workspace-write'}}:{thread:{id:'thread'}};},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);await expect(cli.resumeThread('thread',[],'Current launcher')).rejects.toThrow('Instruction refresh unavailable');
});
it('reloads scoped native permissions when the mailbox, current profile or restrictions change',async()=>{
 let config:any={sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:false}};
 const rpc={request:async(method:string)=>method==='initialize'?{}:method==='config/read'?{config:structuredClone(config)}:{thread:{id:'native'}},notify(){},reply(){},close(){}};
 const cli=await connectCodex(rpc,'/workspace',false);await cli.startThread({cwd:'/workspace',instructions:'first',runtimeMailboxPath:'/first/mailbox'});
 expect(await cli.requiresRuntimeReload!('/first/mailbox')).toBe(false);
 expect(await cli.requiresRuntimeReload!('/second/mailbox')).toBe(true);
 config.sandbox_workspace_write.network_access=true;expect(await cli.requiresRuntimeReload!('/first/mailbox')).toBe(true);
 config={sandbox_mode:'read-only'};expect(await cli.requiresRuntimeReload!('/first/mailbox')).toBe(true);
 config={default_permissions:'named',permissions:{named:{extends:':read-only',filesystem:{'/sensitive':'deny'}}}};expect(await cli.requiresRuntimeReload!('/first/mailbox')).toBe(true);
 await cli.startThread({cwd:'/workspace',instructions:'named baseline',runtimeMailboxPath:'/first/mailbox'});config={sandbox_mode:'workspace-write'};expect(await cli.requiresRuntimeReload!('/first/mailbox')).toBe(true);
});
it('the fixture reports an authoritative empty background-terminal list for safe native reload',async()=>{
 const rpc=createRpcClient(spawn(process.execPath,['tests/fixtures/fake-cli.mjs'],{stdio:'pipe'}),{}),cli=await connectCodex(rpc);
 try{await cli.startThread({cwd:'/tmp',instructions:'Synthetic fixture only'});expect(await rpc.request('thread/backgroundTerminals/list',{threadId:'native-1'})).toEqual({data:[],nextCursor:null});await expect(cli.assertReloadable!('native-1')).resolves.toBeUndefined();}finally{await cli.close();}
});
it('a malformed native background response still blocks reload without closing its client',async()=>{
 let closed=0;const rpc={request:async(method:string)=>method==='initialize'?{}:{threadId:'thread'},notify(){},reply(){},close(){closed++;}};const cli=await connectCodex(rpc);await expect(cli.assertReloadable!('thread')).rejects.toMatchObject({code:'native_background_check_failed'});expect(closed).toBe(0);
});
