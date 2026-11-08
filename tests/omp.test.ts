import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startOmp, prepareCapabilityRuntime } from "../server/omp";

it("preserves distinct OMP replies, thinking and the final model timing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-observe-"));
  const executable = join(dir, "omp");
  await writeFile(executable, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  send({ type: "response", id: r.id, success: true, data: r.type === "get_state" ? { sessionFile: "sample" } : {} });
  if (r.type !== "prompt") return;
  send({ type: "agent_start" });
  for (const [text, phase, stopReason] of [["Checking", "commentary", "toolUse"], ["Done", "final_answer", "stop"]]) {
    const message = { role: "assistant", model: "sample-model", timestamp: 1000, usage:{input:10,output:5,cacheRead:20,cacheWrite:3,totalTokens:38,reasoningTokens:2},
      content: [{ type: "text", text, textSignature: JSON.stringify({ v: 1, id: phase, phase }) }], stopReason, duration: 125, ttft: 25 };
    send({ type: "message_start", message });
    send({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Checking evidence" } });
    send({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    send({ type: "message_end", messageId:'msg-'+phase, message });
  }
  send({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
});
`);
  await chmod(executable, 0o700);
  const events: { method?: string; params?: any }[] = [];
  let client;
  try {
    client = await startOmp({ cwd: dir, env: { PATH: dir + ":" + process.env.PATH }, onEvent: e => events.push(e), onApproval() {}, onExit() {} });
    await client.startTurn("sample", "Inspect");
    for (let i = 0; i < 100 && !events.some(e => e.method === "turn/completed"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const text = events.filter(e => e.method === "item/agentMessage/delta");
    expect(new Set(text.map(e => e.params.itemId)).size).toBe(2);
    expect(events.some(e => e.method === "item/reasoning/textDelta")).toBe(true);
    expect(events.find(e => e.method === "item/completed" && e.params.item.phase === "final_answer")?.params.item)
      .toMatchObject({ text: "Done", phase: "final_answer", stopReason: "stop" });
    expect(events.find(e => e.method === "item/completed" && e.params.item.type === "modelCall")?.params.item)
      .toMatchObject({ model: "sample-model", durationMs: 125, ttftMs: 25 });
    expect(events.filter(e=>e.method==='mandala/usageMessage').map(e=>e.params)).toMatchObject([
      {messageId:'msg-commentary',model:'sample-model',usage:{input:10,output:5,cacheRead:20,cacheWrite:3,reasoningTokens:2}},
      {messageId:'msg-final_answer',model:'sample-model',usage:{input:10,output:5,cacheRead:20,cacheWrite:3,reasoningTokens:2}},
    ]);
  } finally { client?.close(); await rm(dir, { recursive: true, force: true }); }
});

it("surfaces a failed OMP model turn instead of leaving the chat running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-mana-omp-"));
  const executable = join(dir, "omp");
  await writeFile(executable, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state")
    send({ type: "response", id: request.id, success: true,
      data: { sessionFile: "test-session", model: "test-model" } });
  if (request.type === "prompt") {
    send({ type: "response", id: request.id, success: true, data: {} });
    send({ type: "agent_start" });
    const message = { role: "assistant", stopReason: "error", errorMessage: "provider unavailable" };
    send({ type: "message_end", message });
    send({ type: "agent_end", isTerminal: true, messages: [message] });
  }
});
`);
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  const events: { method?: string; params?: any }[] = [];
  let client;
  try {
    client = await startOmp({ cwd: dir, onEvent: (event) => events.push(event),
      onApproval: () => {}, onExit: () => {} });
    await client.startTurn("test-session", "hello");
    for (let i = 0; i < 100 && !events.some((event) => event.method === "turn/completed"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.find((event) => event.method === "error")?.params?.error?.message)
      .toContain("provider unavailable");
    expect(events.find((event) => event.method === "turn/completed")?.params?.turn?.status)
      .toBe("failed");
  } finally {
    client?.close();
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["default", "strict", "auto"] as const)("starts OMP RPC with %s approval, separate arguments and inherited environment", async (approvalMode) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-runtime-"));
  const executable = join(dir, "omp");
  const capture = join(dir, "launch.json");
  await writeFile(executable, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), value: process.env.MANA_RUNTIME_TEST, inherited: process.env.PATH }));
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  send({ type: "response", id: request.id, success: true, data: { sessionFile: "test-session" } });
});
`);
  await chmod(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  let client;
  try {
    client = await startOmp({ cwd: dir, approvalMode, extraArgs: ["--thinking", "high"], env: { MANA_RUNTIME_TEST: "resolved-value" },
      onEvent() {}, onApproval() {}, onExit() {} });
    const launch = JSON.parse(await readFile(capture, "utf8"));
    expect(launch.args).toEqual(["--mode=rpc", `--cwd=${dir}`, `--approval-mode=${approvalMode === "auto" ? "yolo" : approvalMode === "strict" ? "always-ask" : "write"}`, "--thinking", "high"]);
    expect(launch.value).toBe("resolved-value");
    expect(launch.inherited).toBe(process.env.PATH);
  } finally {
    client?.close();
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

it("forwards native extension errors with distinct ids without synthesizing a hook lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-hooks-"));
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  send({ type: "response", id: request.id, success: true, data: { sessionFile: "test-session" } });
  if (request.type === "prompt") {
    send({ type: "agent_start" });
    for (let i = 0; i < 2; i++) send({ type: "extension_error", extensionPath: "/tmp/audit.ts", event: "tool_call", error: "Policy rejected" });
    send({ type: "notice", level: "error", message: "Ordinary CLI error" });
    send({ type: "agent_end", isTerminal: true, messages: [] });
  }
});
`);
  await chmod(join(dir, "omp"), 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  const events: { method?: string; params?: any }[] = [];
  let client;
  try {
    client = await startOmp({ cwd: dir, onEvent: (event) => events.push(event), onApproval() {}, onExit() {} });
    await client.startTurn("test-session", "hello");
    await expect.poll(() => events.some((event) => event.method === "turn/completed")).toBe(true);
    const errors = events.filter((event) => event.method === "omp/extension_error");
    expect(errors).toHaveLength(2);
    expect(errors[0].params).toMatchObject({ threadId: "test-session", extensionPath: "/tmp/audit.ts",
      event: "tool_call", error: "Policy rejected", id: expect.any(String), turnId: expect.any(String) });
    expect(errors[0].params.id).not.toBe(errors[1].params.id);
    expect(events.some((event) => event.method === "hook/started" || event.method === "hook/completed")).toBe(false);
    expect(events.find((event) => event.method === "error")?.params.error.message).toBe("Ordinary CLI error");
  } finally {
    client?.close();
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["success", "cancelled", "wrong-prefix"])("branches OMP through native entry ids and verifies active context: %s", async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-branch-"));
  const capture = join(dir, "requests.jsonl");
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let branched = false;
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  require("node:fs").appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  const r = JSON.parse(line);
  let data = {};
  if (r.type === "get_state") data = { sessionFile: branched ? "fork-session" : "source-session" };
  if (r.type === "get_branch_messages") data = { messages: [{ entryId: "entry-a", text: "first" }, { entryId: "entry-b", text: "second" }] };
  if (r.type === "branch") { branched = true; data = { cancelled: ${mode === "cancelled"}, text: "second" }; }
  if (r.type === "get_messages") data = { messages: [{ role: "user", content: [{ type: "text", text: ${JSON.stringify(mode === "wrong-prefix" ? "wrong" : "first")} }] }] };
  send({ type: "response", id: r.id, success: true, data });
});
`);
  await chmod(join(dir, "omp"), 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = dir + ":" + previousPath;
  let client;
  try {
    client = await startOmp({ cwd: dir, resume: "source-session", onEvent() {}, onApproval() {}, onExit() {} });
    if (mode === "success") expect(await client.forkThread!("source-session", ["first", "second"], 1)).toBe("fork-session");
    else await expect(client.forkThread!("source-session", ["first", "second"], 1))
      .rejects.toThrow(mode === "cancelled" ? "Native branch was cancelled" : "Native branch prefix could not be verified");
    const requests = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.find(request => request.type === "branch")).toMatchObject({ entryId: "entry-b" });
    expect(requests.some(request => request.type === "prompt")).toBe(false);
  } finally {
    client?.close();
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["accept", "decline"])("exposes OMP select-based tool approval and streams tool progress after %s", async (decision) => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-approval-"));
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
send({type:"ready"});
createInterface({input:process.stdin}).on("line", line => {
 const r = JSON.parse(line);
 if (r.type === "get_state") send({type:"response",id:r.id,success:true,data:{sessionFile:"test-session"}});
 if (r.type === "prompt") {
  send({type:"response",id:r.id,success:true,data:{}}); send({type:"agent_start"});
  send({type:"tool_execution_start",toolCallId:"bash-1",toolName:"bash",args:{command:"pwd"}});
  send({type:"extension_ui_request",id:"approval-1",method:"select",title:"Run bash: pwd?",options:["Approve","Deny"]});
 }
 if (r.type === "extension_ui_response") {
  send({type:"tool_execution_update",toolCallId:"bash-1",toolName:"bash",partialResult:{content:[{type:"text",text:"first"}]}});
  send({type:"tool_execution_update",toolCallId:"bash-1",toolName:"bash",partialResult:{content:[{type:"text",text:"first second"}]}});
  send({type:"tool_execution_end",toolCallId:"bash-1",toolName:"bash",isError:r.value!=="Approve",result:{content:[]}});
  send({type:"agent_end",isTerminal:true,messages:[]});
 }
});
`);
  await chmod(join(dir, "omp"), 0o700);
  const original = process.env.PATH; process.env.PATH = dir + ":" + original;
  const events: any[] = [], approvals: any[] = [];
  let client;
  try {
    client = await startOmp({cwd:dir,onEvent:e=>events.push(e),onApproval:a=>approvals.push(a),onExit() {}});
    await client.startTurn("test-session", "Check directory");
    await expect.poll(() => approvals.length, { timeout: 500 }).toBe(1);
    expect(approvals[0]).toMatchObject({id:"approval-1",method:"omp/confirm",params:{message:"Run bash: pwd?"}});
    client.replyApproval("approval-1", {decision});
    await expect.poll(() => events.some(e=>e.method==="turn/completed")).toBe(true);
    expect(events.find(e=>e.method==="item/completed").params.item.status).toBe(decision === "accept" ? "completed" : "failed");
    expect(events.filter(e=>e.method==="item/commandExecution/outputDelta").map(e=>e.params.delta)).toEqual(["first", " second"]);
  } finally { client?.close(); process.env.PATH = original; await rm(dir,{recursive:true,force:true}); }
});

it("force closes an OMP process that ignores SIGTERM even after its signal aborts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-close-"));
  const pidFile = join(dir, "pid");
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const {createInterface}=require("node:readline");
const send=v=>process.stdout.write(JSON.stringify(v)+"\\n");
send({type:"ready"});
createInterface({input:process.stdin}).on("line", line=>{
 const r=JSON.parse(line);send({type:"response",id:r.id,success:true,data:{sessionFile:"test-session"}});
});
`);
  await chmod(join(dir,"omp"),0o700);
  const original=process.env.PATH;process.env.PATH=dir+":"+original;
  const controller=new AbortController();
  let client, pid=0;
  try {
    client=await startOmp({cwd:dir,signal:controller.signal,onEvent(){},onApproval(){},onExit(){}});
    pid=Number(await readFile(pidFile,"utf8"));
    controller.abort();client.close();
    await expect.poll(()=>{try{process.kill(pid,0);return false;}catch{return true;}},{timeout:3500}).toBe(true);
  } finally {
    client?.close();if(pid)try{process.kill(pid,"SIGKILL");}catch{}
    process.env.PATH=original;await rm(dir,{recursive:true,force:true});
  }
});


it.each(["success", "unsupported", "wrong-history"])("forks the latest OMP reply via ACP without prompting: %s", async mode => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-reply-fork-"));
  const capture = join(dir, "requests.jsonl");
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const acp = process.argv.includes("acp");
let forked = process.argv.includes("--resume=fork-id");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (!acp) send({type:"ready"});
createInterface({input:process.stdin}).on("line", line => {
  const r = JSON.parse(line);
  require("node:fs").appendFileSync(${JSON.stringify(capture)}, JSON.stringify({acp,args:process.argv.slice(2),env:process.env.FORK_TEST_AGENT,...r}) + "\\n");
  if (acp) {
    if (r.jsonrpc !== "2.0") return send({id:r.id,error:{message:"JSON-RPC version required"}});
    const result = r.method === "initialize" ? {agentCapabilities:{sessionCapabilities:${mode === "unsupported" ? "{}" : "{fork:{}}"}}} : {sessionId:"fork-id"};
    return send({jsonrpc:"2.0",id:r.id,result});
  }
  if (r.type === "switch_session") forked = true;
  let data = {};
  if (r.type === "get_state") data = {sessionFile:forked ? "fork-session" : "source-session",sessionId:forked ? "fork-id" : "source-id"};
  if (r.type === "get_branch_messages") data = {messages:[{entryId:"user-id",text:"first"}]};
  if (r.type === "get_messages") data = {messages:[{role:"user",content:[{type:"text",text:"first"}]},{role:"assistant",content:[{type:"text",text:forked && ${mode === "wrong-history"} ? "wrong" : "retained answer"}]}]};
  send({type:"response",id:r.id,success:true,data});
});
`);
  await chmod(join(dir, "omp"), 0o700);
  const events: unknown[] = [];
  const client = await startOmp({cwd:dir,resume:"source-session",env:{PATH:dir + ":" + process.env.PATH,FORK_TEST_AGENT:"bound-agent"},extraArgs:["--no-tools"],onEvent:e=>events.push(e),onApproval() {},onExit() {}});
  try {
    if (mode === "success") expect(await client.forkThread!("source-session", ["first"], 1)).toBe("fork-session");
    else await expect(client.forkThread!("source-session", ["first"], 1)).rejects.toThrow(mode === "unsupported" ? "Native reply branching unavailable" : "Native branch prefix could not be verified");
    const requests = (await readFile(capture, "utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(requests.some(r => r.type === "prompt" || r.method === "session/prompt")).toBe(false);
    expect(events).toEqual([]);
    if (mode !== "unsupported") expect(requests.find(r=>r.method === "session/fork")).toMatchObject({params:{sessionId:"source-id",cwd:dir,mcpServers:[]},env:"bound-agent",args:expect.arrayContaining(["--no-tools"])});
  } finally { await client.close(); await rm(dir, {recursive:true,force:true}); }
});

it("maps a non-invoking prompt response before emitting its terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-command-"));
  const executable = join(dir, "omp");
  await writeFile(executable, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  send({ type: "response", id: r.id, success: true, data: r.type === "get_state" ? { sessionFile: "sample" } : { agentInvoked: false } });
});
`);
  await chmod(executable, 0o700);
  const events: { method?: string; params?: any }[] = [];
  let client;
  try {
    client = await startOmp({ cwd: dir, env: { PATH: dir + ":" + process.env.PATH }, onEvent: e => events.push(e), onApproval() {}, onExit() {} });
    const turnId = await client.startTurn("sample", "/command");
    expect(events.map(e => e.method)).toEqual(["turn/started", "turn/completed"]);
    expect(events.every(e => e.params.threadId === "sample" && e.params.turn.id === turnId)).toBe(true);
  } finally { client?.close(); await rm(dir, { recursive: true, force: true }); }
});


it('revalidates immediately before a prepared instruction file is written',async()=>{
 const home=await mkdtemp(join(tmpdir(),'omp-file-fence-'));let checked=false;
 try{await expect(prepareCapabilityRuntime(home,'conversation',[],[],'obsolete-memory',()=>{checked=true;throw new Error('stale_memory_dependency');})).rejects.toThrow('stale_memory_dependency');expect(checked).toBe(true);await expect(readFile(join(home,'runtime','conversation','instructions.md'),'utf8')).rejects.toThrow();}
 finally{await rm(home,{recursive:true,force:true});}
});
it('revalidates before spawning OMP with an instruction file',async()=>{
 const home=await mkdtemp(join(tmpdir(),'omp-spawn-fence-'));const marker=join(home,'spawned'),executable=join(home,'omp');
 await writeFile(executable,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');process.stdout.write(JSON.stringify({type:'ready'})+'\\n');setTimeout(()=>{},1000);\n`);await chmod(executable,0o700);
 let client:Awaited<ReturnType<typeof startOmp>>|undefined;try{await expect(startOmp({cwd:home,env:{PATH:home+':'+process.env.PATH},instructions:join(home,'instructions.md'),onEvent(){},onApproval(){},onExit(){},validateHandoff(){throw new Error('stale_memory_dependency');}}).then(value=>{client=value;})).rejects.toThrow('stale_memory_dependency');await expect(readFile(marker,'utf8')).rejects.toThrow();}
 finally{await client?.close();await rm(home,{recursive:true,force:true});}
});

it("uses native model effort choices and sends model, effort and image bytes before a prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mana-omp-input-"));
  const capture = join(dir, "requests.jsonl");
  const imagePath = join(dir, "sample.png");
  await writeFile(imagePath, Buffer.from("synthetic image bytes"));
  await writeFile(join(dir, "omp"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const model = { provider: "sample", id: "model", name: "Model", reasoning: true, thinking: { efforts: ["low", "high"], defaultLevel: "low" } };
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", line => {
  require("node:fs").appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  const r = JSON.parse(line);
  const data = r.type === "get_state" ? { sessionFile: "sample-session", model, thinkingLevel: "medium" } : r.type === "get_available_models" ? { models: [model] } : {};
  send({ type: "response", id: r.id, success: true, data });
});
`);
  await chmod(join(dir, "omp"), 0o700);
  let client;
  try {
    client = await startOmp({ cwd: dir, env: { PATH: dir + ":" + process.env.PATH }, onEvent() {}, onApproval() {}, onExit() {} });
    expect(await client.listModels()).toEqual([{ id: "sample/model", label: "sample / Model", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["none", "low", "high"] }]);
    await client.startTurn("sample-session", "inspect", undefined, undefined, { model: "sample/model", effort: "high", images: [{ path: imagePath, mimeType: "image/png" }] });
    const requests = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.slice(-3)).toMatchObject([
      { type: "set_model", provider: "sample", modelId: "model" },
      { type: "set_thinking_level", level: "high" },
      { type: "prompt", message: "inspect", images: [{ type: "image", mimeType: "image/png", data: Buffer.from("synthetic image bytes").toString("base64") }] },
    ]);
  } finally { await client?.close(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['rejection', 'missing-session'] as const)('reaps the child before rejecting initial OMP %s negotiation', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'mandala-omp-init-failure-'));
  const pidFile = join(dir, 'pid');
  await writeFile(join(dir, 'omp'), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));
send({type:'ready'});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  send({type:'response', id:request.id, success:${mode === 'missing-session'}, data:{}, error:'state unavailable'});
});
`);
  await chmod(join(dir, 'omp'), 0o700);
  let pid: number | undefined;
  const onExit = vi.fn();
  try {
    await expect(startOmp({cwd:dir, env:{PATH:dir+':'+process.env.PATH},
      onEvent(){}, onApproval(){}, onExit,
    })).rejects.toThrow(mode === 'rejection' ? 'state unavailable' : 'OMP did not provide a session identifier');
    pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(onExit).not.toHaveBeenCalled();
  } finally {
    if(pid)try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(dir, {recursive:true, force:true});
  }
});

it.each([undefined,'saved-session'])('delivers the current host instruction file to native OMP (resume=%s)',async resume=>{
 const dir=await mkdtemp(join(tmpdir(),'mandala-omp-instructions-')),capture=join(dir,'captured.json');
 const root=await prepareCapabilityRuntime(dir,'chat',[],[],'Current system coordinator context');
 await writeFile(join(dir,'omp'),`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
const path=args.find(a=>a.startsWith('--append-system-prompt=')).split('=').slice(1).join('=');
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,instructions:fs.readFileSync(path,'utf8')}));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');send({type:'ready'});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);send({type:'response',id:r.id,success:true,data:{sessionFile:'native'}});});
`);
 await chmod(join(dir,'omp'),0o700);
 let client;
 try{
  client=await startOmp({cwd:dir,resume,instructions:join(root,'instructions.md'),env:{PATH:dir+':'+process.env.PATH},onEvent(){},onApproval(){},onExit(){}});
  const launch=JSON.parse(await readFile(capture,'utf8'));
  expect(launch.instructions).toBe('Current system coordinator context');
  expect(launch.args.includes('--resume=saved-session')).toBe(!!resume);
 }finally{await client?.close();await rm(dir,{recursive:true,force:true});}
});
