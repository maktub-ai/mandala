import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createBusinessCliRuntime } from "../server/business-cli-runtime";
import { createSessionManager } from "../server/sessions";
import { openStore } from "../server/store";
import type { Config } from "../shared/types";
import { connectCodex, type CodexClient, type CodexOptions } from "../server/codex";
import { businessCliContext } from "./business-cli-context";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config: Config = { version: 2, runtimes:["codex","omp"], projects: [{ id: "p", name: "P", cwd: "/tmp", agentIds: ["a"], resources: [], mcp: [], skills: [] }], agents: [{ id: "a", name: "A", instructions: "Review", defaultCli: "codex", models: {}, mcp: [], skills: [] }] };

test("creates a private launcher with shell-safe paths and keeps its credential out of instructions and argv", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana cli ' "));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const runtime = await createBusinessCliRuntime(home, "invocation", { baseUrl: "http://127.0.0.1:4317", token: "private-token" });
  cleanups.push(runtime.dispose);
  expect(statSync(runtime.contextFile).mode & 0o777).toBe(0o600);
  expect(statSync(runtime.launcher).mode & 0o777).toBe(0o700);
  expect(statSync(join(runtime.contextFile, "..")).mode & 0o777).toBe(0o700);
  expect(runtime.command).not.toContain("private-token");
  expect(readFileSync(runtime.launcher, "utf8")).not.toContain("private-token");
  const context = businessCliContext(`OpenMana CLI command: ${runtime.command}`);
  expect(context).toMatchObject({ launcher: runtime.launcher, contextFile: runtime.contextFile, token: "private-token" });
  const child = spawn("/bin/sh", ["-c", `${runtime.command} --help`], { stdio: "pipe" });
  let output = "", error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(error).toBe(""); expect(code).toBe(0); expect(output).toContain("mandala");
});

test.each(["codex", "omp"] as const)("%s refreshes CLI bindings on resume and deletes credentials on completion, stop, and close", async cli => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-lifecycle-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  let options!: CodexOptions, turn = 0;
  const contexts: ReturnType<typeof businessCliContext>[] = [];
  const capture = (instructions = "") => {
    const context = businessCliContext(instructions);
    expect(context).not.toHaveProperty("mailboxPath");
    expect(instructions).not.toContain(context.token);
    expect(instructions).toContain('tasks execution-add');expect(instructions).toContain('tasks execution-remove');expect(instructions).not.toContain('conversationIds ([] allowed)');expect(instructions).not.toContain('tasks link;');
    expect(context.launcher.startsWith(home + "/runtime/cli/")).toBe(true);
    contexts.push(context);
  };
  const factory = async (o: CodexOptions): Promise<CodexClient> => {
    options = o;
    return { getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
      startThread: async p => { capture(p.instructions); expect(p.mcp).toEqual([]); return "native"; },
      resumeThread: async (_id, mcp, instructions) => { capture(instructions); expect(mcp).toEqual([]); },
      startTurn: async () => `turn-${++turn}`, interrupt: async () => {
        o.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: `turn-${turn}`, status: "interrupted" } } });
      }, replyApproval() {}, close() {} };
  };
  const manager = createSessionManager(store, async () => config, factory, async o => {
    const client = await factory(o);
    if (o.resume) capture(readFileSync(o.instructions!, "utf8"));
    return client;
  }, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a", undefined, cli);
  await manager.send(chat.id, "first");
  const first = contexts[0]; expect(existsSync(first.contextFile)).toBe(true);
  options.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn-1", status: "completed" } } });
  expect(existsSync(first.contextFile)).toBe(false);
  await expect(manager.callBoundTool(first.token, "project_agents", {}, "expired")).rejects.toMatchObject({ status: 403 });
  await manager.send(chat.id, "second");
  const second = contexts[1]; expect(second.token).not.toBe(first.token); expect(second.launcher).not.toBe(first.launcher);
  options.onEvent({ method: "turn/started", params: { threadId: "native", turn: { id: "turn-2" } } });
  await manager.stop(chat.id); expect(existsSync(second.contextFile)).toBe(false);
  await manager.continue(chat.id, "third");
  const third = contexts[2]; expect(existsSync(third.contextFile)).toBe(true);
  await manager.close(); expect(existsSync(third.contextFile)).toBe(false);
});

test("uses a private temporary directory when the session manager has no HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-no-home-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  let context!: ReturnType<typeof businessCliContext>;
  const factory = async (): Promise<CodexClient> => ({ getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [], startThread: async p => { context = businessCliContext(p.instructions); return "native"; }, resumeThread: async () => {}, startTurn: async () => "turn", interrupt: async () => {}, replyApproval() {}, close() {} });
  const manager = createSessionManager(store, async () => config, factory, undefined, "");
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a"); await manager.send(chat.id, "inspect");
  expect(isAbsolute(context.launcher)).toBe(true);
  expect(context.launcher.startsWith(process.cwd() + "/")).toBe(false);
  expect(context.launcher.startsWith(home + "/")).toBe(false);
  await manager.close(); expect(existsSync(context.contextFile)).toBe(false);
});

test("constrained Codex reopens its idle native client before rotating scoped mailbox permissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-constrained-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const scoped = structuredClone(config); scoped.agents[0].runtime = { codex: { fullAccess: false } };
  let options!: CodexOptions, turn = 0, initializations=0, oldClientClosed=0;
  const roots: (string[] | undefined)[] = [], contexts: (ReturnType<typeof businessCliContext> & { mailboxPath?: string })[] = [];
  const capture = (instructions: string, paths?: string[]) => { contexts.push(businessCliContext(instructions)); roots.push(paths); };
  const manager = createSessionManager(store, async () => scoped, async o => {
    options = o;initializations++;if(initializations>1)expect(oldClientClosed).toBe(1);expect(o.fullAccess).toBe(false);
    return { getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
      startThread: async p => { capture(p.instructions, p.runtimeWorkspaceRoots); return "native"; },
      resumeThread: async (_id, _mcp, instructions, _model, paths) => { capture(instructions!, paths); },
      startTurn: async () => `turn-${++turn}`, interrupt: async () => {}, replyApproval() {}, async close(){await new Promise<void>(resolve=>setImmediate(resolve));oldClientClosed++;} } as CodexClient;
  }, undefined, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a"); await manager.send(chat.id, "first");
  expect(contexts[0].mailboxPath).toEqual(expect.any(String));
  expect(roots[0]).toEqual(["/tmp",join(home,"outputs","conversations",chat.id,contexts[0].contextFile.split(/[\\/]/).at(-2)!), contexts[0].mailboxPath]);
  expect(statSync(contexts[0].mailboxPath!).mode & 0o777).toBe(0o700);
  const child = spawn(contexts[0].launcher, ["project", "agents", "--key", "list-agents"], { stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(stderr).toBe(""); expect(code).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: [{ id: "a", name: "A" }] });
  options.onEvent({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn-1", status: "completed" } } });
  await manager.send(chat.id, "second");
  expect(initializations).toBe(2);expect(oldClientClosed).toBe(1);
  expect(contexts[1].mailboxPath).not.toBe(contexts[0].mailboxPath);
  expect(roots[1]).toEqual(["/tmp",join(home,"outputs","conversations",chat.id,contexts[1].contextFile.split(/[\\/]/).at(-2)!), contexts[1].mailboxPath]);
  expect(roots[1]).not.toContain(contexts[1].contextFile);
  expect(roots[1]).not.toContain(join(contexts[1].contextFile, ".."));
});

test("mailbox does not follow request or response symlinks and does not recreate responses after disposal", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-mailbox-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let release!: () => void;
  const invoke = vi.fn(async (data: { command: string }) => {
    if (data.command === "wait") await new Promise<void>(resolve => { release = resolve; });
    return { accepted: true };
  });
  const runtime = await createBusinessCliRuntime(home, "invocation", { baseUrl: "http://127.0.0.1:1", token: "private-token" }, invoke);
  cleanups.push(runtime.dispose);
  const outside = join(home, "outside.json"), badId = randomUUID(), fifoId = randomUUID(), goodId = randomUUID(), lateId = randomUUID();
  const request = { command: "project agents", args: {}, commandKey: "fixed" };
  writeFileSync(outside, JSON.stringify(request), { mode: 0o600 });
  symlinkSync(outside, join(runtime.mailboxPath!, badId + ".request"));
  await vi.waitFor(() => expect(existsSync(join(runtime.mailboxPath!, badId + ".response"))).toBe(true));
  expect(JSON.parse(readFileSync(join(runtime.mailboxPath!, badId + ".response"), "utf8"))).toMatchObject({ ok: false });
  expect(invoke).not.toHaveBeenCalled();
  expect(spawnSync("mkfifo", ["-m", "600", join(runtime.mailboxPath!, fifoId + ".request")]).status).toBe(0);
  await vi.waitFor(() => expect(existsSync(join(runtime.mailboxPath!, fifoId + ".response"))).toBe(true));
  expect(JSON.parse(readFileSync(join(runtime.mailboxPath!, fifoId + ".response"), "utf8"))).toMatchObject({ ok: false, error: { code: "invalid_cli_request" } });
  expect(invoke).not.toHaveBeenCalled();
  const readingStarted = performance.now();
  expect(await readFile(outside, "utf8")).toBe(JSON.stringify(request));
  expect(performance.now() - readingStarted).toBeLessThan(1000);
  symlinkSync(outside, join(runtime.mailboxPath!, goodId + ".response"));
  writeFileSync(join(runtime.mailboxPath!, goodId + ".request"), JSON.stringify(request), { mode: 0o600 });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual(request);
  writeFileSync(join(runtime.mailboxPath!, lateId + ".request"), JSON.stringify({ ...request, command: "wait" }), { mode: 0o600 });
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  runtime.dispose(); release(); await new Promise(resolve => setTimeout(resolve, 60));
  expect(existsSync(runtime.mailboxPath!)).toBe(false);
  expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual(request);
});

test("a stop before native submission cleans the prepared CLI and explicit continuation can submit", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-preparation-stop-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  let entered!: () => void, release!: () => void, first = true;
  const preparing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const contexts: ReturnType<typeof businessCliContext>[] = [];
  const manager = createSessionManager(store, async () => config, async () => ({
    getStatus: async () => ({ status: "ready", version: "fixture" }), listModels: async () => [],
    startThread: async p => { contexts.push(businessCliContext(p.instructions)); if (first) { first = false; entered(); await gate; } return "native"; },
    resumeThread: async () => {}, startTurn: async () => "turn", interrupt: async () => {}, replyApproval() {}, close() {},
  }), undefined, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a"), sending = manager.send(chat.id, "ignore-stop");
  await preparing;
  expect(store.getConversation(chat.id)).toMatchObject({ status: "running", turnId: null });
  expect(existsSync(contexts[0].contextFile)).toBe(true);
  await manager.stop(chat.id);
  expect(existsSync(contexts[0].contextFile)).toBe(false);
  await manager.continue(chat.id, "Continue reading");
  release(); await sending;
  expect(store.getConversation(chat.id)).toMatchObject({ status: "running", turnId: "turn" });
  expect(manager.listUserInputs(chat.id)).toEqual([]);
});
test.each(['native_background_active','native_background_check_failed'])('blocked native reload %s preserves the old process and rejects only the new invocation',async code=>{
 const {DomainError}=await import('../shared/workspace-contracts');const home=mkdtempSync(join(tmpdir(),'mana-native-background-')),store=openStore(home);cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const scoped=structuredClone(config);scoped.agents[0].runtime={codex:{fullAccess:false}};let options!:CodexOptions,starts=0,closes=0,factories=0,blocked=true;const contexts:ReturnType<typeof businessCliContext>[]=[],pending:ReturnType<typeof businessCliContext>[]=[];
 const manager=createSessionManager(store,async()=>scoped,async o=>{options=o;factories++;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],requiresRuntimeReload:async(mailbox?:string)=>{if(mailbox)pending.push({launcher:join(mailbox,'..','mandala'),contextFile:join(mailbox,'..','context.json'),...JSON.parse(readFileSync(join(mailbox,'..','context.json'),'utf8'))});return true;},assertReloadable:async()=>{if(blocked)throw new DomainError(code,409,'Background commands are still running; wait and retry.');},startThread:async p=>{contexts.push(businessCliContext(p.instructions));return 'native';},resumeThread:async(_id,_mcp,instructions)=>{contexts.push(businessCliContext(instructions!));},startTurn:async()=>`t${++starts}`,interrupt:async()=>{},replyApproval(){},close(){closes++;}} as CodexClient;},undefined,home);cleanups.push(()=>manager.close());
 const chat=await manager.create('p','a');await manager.send(chat.id,'First');options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'t1',status:'completed'}}});
 await expect(manager.send(chat.id,'Second request')).rejects.toMatchObject({code});expect(closes).toBe(0);expect(factories).toBe(1);expect(starts).toBe(1);expect(store.getConversation(chat.id)?.status).toBe('error');expect(store.listEvents(chat.id,0).filter(event=>event.kind==='error').at(-1)?.data).toMatchObject({code,nativeTurnSubmitted:false});
 for(const context of [contexts[0],...pending]){expect(existsSync(context.contextFile)).toBe(false);await expect(manager.callBoundTool(context.token,'task_context',{},'expired')).rejects.toMatchObject({status:403});}
 blocked=false;await manager.send(chat.id,'Retry the second request');expect(factories).toBe(2);expect(closes).toBe(1);expect(starts).toBe(2);expect(await manager.callBoundTool(contexts.at(-1)!.token,'task_context',{},'fresh')).toMatchObject({conversationId:chat.id});
});
test.each(['queued-input','durable-task'] as const)('background reload guard rejects only unsubmitted %s and keeps the original native process',async route=>{
 const {DomainError}=await import('../shared/workspace-contracts');const home=mkdtempSync(join(tmpdir(),'mana-native-background-work-')),store=openStore(home);cleanups.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});const scoped=structuredClone(config);scoped.agents[0].runtime={codex:{fullAccess:false}};let options!:CodexOptions,starts=0,closes=0;
 const manager=createSessionManager(store,async()=>scoped,async o=>{options=o;return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],requiresRuntimeReload:async()=>true,assertReloadable:async()=>{throw new DomainError('native_background_active',409,'Background commands are still running; wait and retry.');},startThread:async()=> 'native',resumeThread:async()=>{},startTurn:async()=>`t${++starts}`,interrupt:async()=>{},replyApproval(){},close(){closes++;}} as CodexClient;},undefined,home);cleanups.push(()=>manager.close());const chat=await manager.create('p','a');await manager.send(chat.id,'Original background work');
 const queued=route==='queued-input'?manager.enqueueUserInput(chat.id,'Keep this queued question','background-queued'):null;options.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'t1',status:'completed'}}});
 if(queued){await vi.waitFor(()=>expect(manager.listUserInputs(chat.id).find(input=>input.id===queued.id)?.state).toBe('cancelled'));expect(store.listEvents(chat.id,0).some(event=>event.kind==='user'&&(event.data as any).text==='Keep this queued question')).toBe(true);expect(store.listOutbox(0).some(event=>event.type==='task.user_input_cancelled'&&(event.payload as any).reason==='native_background_active')).toBe(true);}
 else {const task=manager.taskService.createTask({userId:'local'},{goal:'New Task while original background lives',projectId:'p',assigneeAgentId:'a'},'new-unsubmitted');const run=await manager.startDurableTask(task.id,1,'blocked-task-start',chat.id);await vi.waitFor(()=>expect(manager.taskService.getRun({userId:'local'},run.id).state).toBe('interrupted'));expect(manager.taskService.getTask({userId:'local'},task.id)).toMatchObject({state:'waiting',waitingReason:'input'});expect(manager.taskService.getRun({userId:'local'},run.id)).toMatchObject({nativeSessionId:null,nativeTurnId:null});expect(manager.taskService.listReceipts({userId:'local'},task.id)[0].summary).toContain('Task was not submitted');}
 expect(starts).toBe(1);expect(closes).toBe(0);expect(store.getConversation(chat.id)?.status).toBe('error');expect(store.listEvents(chat.id,0).filter(event=>event.kind==='error').at(-1)?.data).toMatchObject({code:'native_background_active',nativeTurnSubmitted:false});
});

test("workspace-write mailbox rotation reloads the real adapter, retains native history and expires old authority", async () => {
  const home = mkdtempSync(join(tmpdir(), "mana-cli-rotated-adapter-")), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const scoped = structuredClone(config); scoped.agents[0].runtime = { codex: { fullAccess: false } };
  const nativeConfig = { sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false } };
  const contexts: ReturnType<typeof businessCliContext>[] = [], loadedRoots: string[][] = [];
  const history: string[] = [], lifecycle: string[] = [];
  let options!: CodexOptions, factories = 0, turns = 0;
  const manager = createSessionManager(store, async () => scoped, async o => {
    options = o; const client = ++factories; let roots: string[] | undefined;
    return connectCodex({ request: async (method, params: any) => {
      if (method === "initialize") return { userAgent: "codex/0.160.0" };
      if (method === "config/read") return { config: structuredClone(nativeConfig) };
      if (method === "thread/backgroundTerminals/list") { lifecycle.push("check-background"); return { data: [], nextCursor: null }; }
      if (["thread/start", "thread/resume"].includes(method)) {
        if (method === "thread/resume") expect(params.threadId).toBe("same-native");
        // Loaded native threads retain their original roots; only a fresh client loads overrides.
        roots ??= params.runtimeWorkspaceRoots; loadedRoots.push(roots!);
        contexts.push(businessCliContext(params.developerInstructions));
        return { thread: { id: "same-native" } };
      }
      if (method === "turn/start") { history.push(params.input[0].text); return { turn: { id: `turn-${++turns}` } }; }
      return {};
    }, notify() {}, reply() {}, close() { lifecycle.push(`close-${client}`); } }, o.cwd, o.fullAccess);
  }, undefined, home);
  cleanups.push(() => manager.close());
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "first");
  options.onEvent({ method: "turn/completed", params: { threadId: "same-native", turn: { id: "turn-1", status: "completed" } } });
  await manager.send(chat.id, "second");
  expect(factories).toBe(2);
  expect(lifecycle).toEqual(["check-background", "close-1"]);
  expect(store.getConversation(chat.id)?.nativeId).toBe("same-native");
  expect(history).toEqual(["first", "second"]);
  const first = contexts[0], second = contexts[1];
  expect(second.mailboxPath).not.toBe(first.mailboxPath);
  expect(loadedRoots[1]).toContain(second.mailboxPath);
  expect(loadedRoots[1]).not.toContain(first.mailboxPath);
  expect(existsSync(first.contextFile)).toBe(false);
  await expect(manager.callBoundTool(first.token, "task_context", {}, "expired")).rejects.toMatchObject({ status: 403 });
  expect(spawnSync(first.launcher, ["tasks", "context"], { encoding: "utf8" })).toMatchObject({ error: { code: "ENOENT" } });
  expect(await manager.callBoundTool(second.token, "task_context", {}, "current")).toMatchObject({ conversationId: chat.id });
  expect(nativeConfig.sandbox_workspace_write.network_access).toBe(false);
});
