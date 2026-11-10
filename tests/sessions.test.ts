import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../server/store";
import { createSessionManager, type SessionManager } from "../server/sessions";
import type { CodexOptions, CodexClient } from "../server/codex";
import type { Config } from "../shared/types";
import type { OmpOptions } from "../server/omp";
import { createKnowledge, updateKnowledge } from "../server/knowledge";
import { getUsage } from '../server/usage';
import { groupChatTurns } from '../src/chatTurns';

it('records conversation usage with actual invocation identity and preserves consumed tokens on interruption',async()=>{
 const c=await manager.create('p','a');await manager.send(c.id,'Use native accounting');
 options.onEvent({method:'openmana/usageBaseline',params:{threadId:'native-1',fresh:true}});
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onEvent({method:'thread/tokenUsage/updated',params:{threadId:'native-1',turnId:'turn-1',tokenUsage:{total:{inputTokens:120,outputTokens:10,cachedInputTokens:30,cacheWriteInputTokens:0,reasoningOutputTokens:5,totalTokens:130},last:{inputTokens:120,outputTokens:10,cachedInputTokens:30,cacheWriteInputTokens:0,reasoningOutputTokens:5,totalTokens:130}}}});
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'interrupted'}}});
 const value=getUsage(store,{period:'today',timeZone:'UTC'});
 expect(value.totals.totalTokens).toBe(130);expect(value.recent[0]).toMatchObject({category:'conversation',conversationId:c.id,projectId:'p',agentId:'a',nativeSessionId:'native-1',nativeTurnId:'turn-1',status:'interrupted'});
 expect(store.listEvents(c.id,0).some(e=>(e.data as any).method==='openmana/usageBaseline')).toBe(false);
});

it("persists run identity and authoritative native completion timing for replay", async () => {
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "Inspect");
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  options.onEvent({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn-1", itemId: "reply", delta: "Done" } });
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: {
    id: "turn-1", status: "completed", durationMs: 420, startedAt: 10, completedAt: 10.42,
  } } });
  const events = store.listEvents(chat.id, 0);
  const start = events.find(e => e.kind === "metadata" && (e.data as any).execution === "started")!;
  expect((start?.data as any)?.runId).toEqual(expect.any(String));
  expect(events.filter(e => ["user", "text", "status"].includes(e.kind)).every(e =>
    (e.data as any).runId === (start.data as any).runId)).toBe(true);
  expect(events.find(e => e.kind === "tool" && (e.data as any).method === "turn/completed")?.data)
    .toMatchObject({ params: { turn: { durationMs: 420 } } });
});
let home: string, store: Store, manager: SessionManager, options: CodexOptions;
let turns: string[],
  resumed: string[],
  replies: unknown[],
  model: string | undefined;
const config: Config = {runtimes:['codex','omp'],
  version: 2,
  projects: [{ id: "p", name: "Project", cwd: "/tmp", agentIds: ["a"], resources: [], mcp: [], skills: [] }],
  agents: [
    {
      id: "a",
      name: "Agent",
      instructions: "Review",
      defaultCli: "codex",
      models: { codex: "default-model" },
      mcp: [],
      skills: [],
    },
  ],
};
const factory = async (o: CodexOptions): Promise<CodexClient> => {
  options = o;
  return {
    getStatus: async () => ({ status: "ready", version: "0.154.0" }),
    listModels: async () => [{ id: "native-model", label: "Native" }],
    startThread: async (p) => {
      model = p.model;
      return "native-1";
    },
    resumeThread: async (id) => {
      resumed.push(id);
    },
    startTurn: async (_, text) => {
      turns.push(text);
      return "turn-1";
    },
    interrupt: async () => {
      o.onEvent({
        method: "turn/completed",
        params: {
          threadId: "native-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
    },
    replyApproval: (id, result) => {
      replies.push({ id, result });
    },
    close: () => {},
  };
};
it('rejects a stale remote stop without interrupting a later invocation', async () => {
  const chat = await manager.create('p', 'a');
  await manager.send(chat.id, 'first');
  options.onEvent({method: 'turn/started', params: {threadId: 'native-1', turn: {id: 'turn-1'}}});
  const first = manager.executionId(chat.id);
  expect(first).toEqual(expect.any(String));
  await manager.stop(chat.id, first);
  await manager.continue(chat.id, 'second');
  expect(manager.executionId(chat.id)).not.toBe(first);
  await expect(manager.stop(chat.id, first)).rejects.toMatchObject({status: 409});
  expect(store.getConversation(chat.id)?.status).toBe('running');
});

it("uses an invocation CLI instead of injecting the built-in task MCP", async () => {
  await manager.close();
  const scoped = structuredClone(config);
  scoped.agents[0].mcp = [{ name: "reader", transport: "stdio", command: "node" }];
  let instructions = "", servers: string[] = [];
  manager = createSessionManager(store, async () => scoped, async o => ({ ...await factory(o),
    startThread: async p => { instructions = p.instructions; servers = p.mcp?.map(m => m.name) ?? []; return "native-1"; },
  }), undefined, home);
  const c = await manager.create("p", "a");
  await manager.send(c.id, "Inspect");
  expect(servers).toEqual(["reader"]);
  expect(instructions).toContain("Mandala CLI command:");
  expect(instructions).toContain("project agents");
  expect(instructions).not.toContain("openmana_tasks");
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mana-session-"));
  store = openStore(home);
  turns = [];
  resumed = [];
  replies = [];
  manager = createSessionManager(
    store,
    async () => structuredClone(config),
    factory,
  );
});
afterEach(async () => {
  await manager?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  store.close();
  rmSync(home, { recursive: true, force: true });
});
it("rejects_busy_message_and_stop_requires_explicit_continuation", async () => {
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "first");
  await expect(manager.send(chat.id, "second")).rejects.toThrow(
    "conversation busy",
  );
  expect(turns).toEqual(["first"]);
  options.onEvent({
    method: "turn/started",
    params: {
      threadId: "native-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  await manager.stop(chat.id);
  expect(store.getConversation(chat.id)?.status).toBe("interrupted");
  await manager.continue(chat.id, "continue");
  expect(turns).toEqual(["first", "continue"]);
});
it("rejects an agent outside the selected project", async () => {
  const restricted = structuredClone(config);
  restricted.projects[0].agentIds = [];
  const isolated = createSessionManager(store, async () => restricted, factory);
  await expect(isolated.create("p", "a")).rejects.toThrow("invalid project or agent");
  isolated.close();
});
it("defaults delegation to resume and returns its result to the busy source chat", async () => {
  manager.close(); let clientNumber=0;
  manager=createSessionManager(store,async()=>structuredClone(config),async o=>{const client=await factory(o);const nativeId=`native-${++clientNumber}`;return {...client,startThread:async()=>nativeId};});
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "plan the work");
  const sourceEvents = options;
  const task = await manager.createTask(source.id, "a", "review the files");
  await new Promise((resolve) => setImmediate(resolve));
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  const targetEvents = options;
  expect(task.targetConversationId).not.toBe(source.id);
  await vi.waitFor(()=>expect(manager.listTasks().find(item => item.id === task.id)?.status).toBe("running"));
  expect(turns).toContain("review the files");
  targetEvents.onEvent({ method: "item/agentMessage/delta", params: {
    threadId: "native-2", turnId: "turn-1", itemId: "answer", delta: "Found the issue",
  } });
  targetEvents.onEvent({ method: "turn/completed", params: {
    threadId: "native-2", turn: { id: "turn-1", status: "completed" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === task.id)?.result).toBe("Found the issue");
  const receipt = manager.listTasks("p").find((item) => item.kind === "return");
  expect(receipt?.status).toBe("queued");
  sourceEvents.onEvent({ method: "turn/completed", params: {
    threadId: "native-1", turn: { id: "turn-1", status: "completed" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  await vi.waitFor(()=>expect(turns.some((text) => text.includes("Found the issue"))).toBe(true));
  expect(manager.listTasks().find(item => item.id === receipt!.id)?.status).toBe("running");
  expect(turns.at(-1)).toContain("plan the work");
  expect(turns.at(-1)).toContain("Task receipts (data)");
  const input = store.listEvents(source.id, 0).filter(e => e.kind === "user").at(-1)!;
  expect(input.data).toMatchObject({ task: { id: receipt!.id, kind: "return", sourceConversationId: task.targetConversationId } });
  await expect(manager.edit(source.id, input.id, "overwrite the receipt")).rejects.toThrow("conversation busy");
  sourceEvents.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  expect(manager.listTasks().find(item => item.id === receipt!.id)?.status).toBe("completed");
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(manager.taskService.listReceipts({userId:store.ownerUserId},task.id)).toHaveLength(1);
  expect(manager.taskService.listRunControls({userId:store.ownerUserId},task.id)).toHaveLength(2);
  await expect(manager.edit(source.id, input.id, "overwrite the receipt")).rejects.toThrow("cannot edit task input");
});
it("returns the helper's final answer without its progress text, even without streamed deltas", async () => {
  const source = await manager.create("p", "a");
  const task = await manager.createTask(source.id, "a", "Find the cause", undefined, {policy:"notify"});
  await new Promise(resolve => setImmediate(resolve));
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  const helper = options;
  helper.onEvent({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn-1", itemId: "progress", delta: "Still investigating" } });
  helper.onEvent({ method: "item/completed", params: { threadId: "native-1", turnId: "turn-1", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "Still investigating" } } });
  helper.onEvent({ method: "item/completed", params: { threadId: "native-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "The version probe is missing" } } });
  helper.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === task.id)?.result).toBe("The version probe is missing");
  expect(manager.listTasks().find(item => item.kind === "return")?.result).toContain("The version probe is missing");
  expect(turns.at(-1)).not.toContain("Still investigating");
});
it("rejects_expired_approval_and_preserves_numeric_native_request_id", async () => {
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "first");
  options.onApproval({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "native-1", turnId: "turn-1", command: "echo ok" },
  });
  const approval = manager.getApprovals(chat.id)[0];
  expect(approval.nativeRequestId).toBe(42);
  await manager.approve(chat.id, approval.id, "approve");
  expect(replies).toEqual([{ id: 42, result: { decision: "accept" } }]);
  expect(store.listEvents(chat.id,0).filter(event=>event.kind==='metadata'&&(event.data as any).approvalDecision).map(event=>(event.data as any).approvalDecision))
    .toEqual([{approvalId:approval.id,decision:'approve'}]);
  await expect(
    manager.approve(chat.id, approval.id, "approve"),
  ).rejects.toThrow("approval expired");
});
it.each(["approve", "reject", "approve-session", "approve-always"] as const)("replies to MCP tool approvals with an elicitation response: %s", async decision => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "List synthetic project agents");
  options.onApproval({id:0,method:"mcpServer/elicitation/request",params:{threadId:"native-1",turnId:"turn-1",serverName:"reader",
    mode:"form",message:'Allow the reader MCP server to run tool "read"?',
    requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",persist:["session","always"]}}});
  const a = manager.getApprovals(c.id)[0];
  await manager.approve(c.id,a.id,decision);
  expect(replies).toEqual([{id:0,result:{action:decision === "reject" ? "decline" : "accept",content:null,
    ...(decision === "approve-session" || decision === "approve-always" ? {_meta:{persist:decision === "approve-session" ? "session" : "always"}} : {})}}]);
  expect(manager.getApprovals(c.id)).toEqual([]);
  expect(store.getConversation(c.id)?.status).toBe("running");
  await expect(manager.approve(c.id,a.id,decision)).rejects.toThrow("approval expired");
});
it("correlates MCP elicitation without a turn ID and rejects another thread's request", async () => {
  const c = await manager.create("p", "a");
  await manager.send(c.id,"Inspect synthetic data");
  const params={threadId:"native-1",turnId:null,mode:"form",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call"}};
  options.onApproval({id:0,method:"mcpServer/elicitation/request",params:{...params,threadId:"other-thread"}});
  expect(manager.getApprovals(c.id)).toEqual([]);
  options.onApproval({id:0,method:"mcpServer/elicitation/request",params});
  expect(manager.getApprovals(c.id)).toHaveLength(1);
  await manager.approve(c.id,manager.getApprovals(c.id)[0].id,"approve");
  expect(replies).toEqual([{id:0,result:{action:"accept",content:null}}]);
});
it("marks_cli_exit_interrupted_and_keeps_explicit_resume_queued_until_native_proof", async () => {
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "first");
  options.onExit("CLI exited (3)");
  expect(store.getConversation(chat.id)?.status).toBe("interrupted");
  expect(turns).toEqual(["first"]);
  await manager.continue(chat.id, "resume");
  expect(resumed).toEqual([]);
  expect(turns).toEqual(["first"]);
  expect(manager.listUserInputs(chat.id)).toMatchObject([{text:"resume",state:"queued"}]);
});
it("marks_restart_interrupted_without_running_a_turn", async () => {
  const chat = await manager.create("p", "a");
  store.updateConversation(chat.id, {
    status: "running",
    nativeId: "original",
  });
  manager.close();
  manager = createSessionManager(store, async () => config, factory);
  expect(store.getConversation(chat.id)?.status).toBe("interrupted");
  expect(turns).toEqual([]);
});
it('persists interruption and a reason before shutdown even if the native close has no exit callback',async()=>{
 const c=await manager.create('p','a');await manager.send(c.id,'unfinished');
 const native=store.getConversation(c.id)!.nativeId;await manager.close();
 expect(store.getConversation(c.id)).toMatchObject({status:'interrupted',nativeId:native});
 expect(getUsage(store,{period:'today',timeZone:'UTC'}).recent[0].reasons).toContain('service_closed');
 expect(store.listEvents(c.id,0).filter(e=>e.kind==='error').map(e=>(e.data as any).message).join(' ')).toContain('service');
 expect(turns).toEqual(['unfinished']);
});
it('reconciles stale running usage and explains restart without retrying native work',async()=>{
 const c=await manager.create('p','a');await manager.send(c.id,'before crash');
 await manager.close();
 // Simulate the persisted state left by a hard process loss rather than graceful close.
 store.updateConversation(c.id,{status:'running'});
 store.database.prepare("UPDATE usage_executions SET data=json_set(data,'$.status','running')").run();
 manager=createSessionManager(store,async()=>config,factory,undefined,home);
 expect(store.getConversation(c.id)?.status).toBe('interrupted');
 const row=getUsage(store,{period:'today',timeZone:'UTC'}).recent[0];
 expect(row.status).toBe('interrupted');expect(row.reasons).toContain('service_restarted');
 expect(store.listEvents(c.id,0).filter(e=>e.kind==='error').map(e=>(e.data as any).message).join(' ')).toContain('restart');
 expect(turns).toEqual(['before crash']);
});
it("selects_model_without_changing_agent_and_lists_without_a_turn", async () => {
  expect(await manager.listModels("p")).toEqual([
    { id: "native-model", label: "Native" },
  ]);
  expect(turns).toEqual([]);
  const chat = await manager.create("p", "a", "chosen-model");
  await manager.send(chat.id, "test");
  expect(model).toBe("chosen-model");
  expect(config.agents[0].models.codex).toBe("default-model");
});
it.each([false, true])("keeps accepted Stop authoritative when a pending native request rejects (stopped=%s)", async stopped => {
  await manager.close();
  let rejectTurn!: (error: Error) => void, entered!: () => void;
  const pending = new Promise<string>((_resolve, reject) => { rejectTurn = reject; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  manager = createSessionManager(store, async () => config, async o => ({
    ...await factory(o), startTurn: async () => { entered(); return pending; },
  }));
  const chat = await manager.create("p", "a");
  const sent = manager.send(chat.id, "Synthetic pending request");
  const rejected = expect(sent).rejects.toThrow("Synthetic native rejection");
  await started;
  const stopping = stopped ? manager.stop(chat.id) : undefined;
  rejectTurn(new Error("Synthetic native rejection"));
  await rejected;
  if (stopping) expect(await stopping).toBe(false); // A rejection is not native completion proof.
  expect(store.getConversation(chat.id)?.status).toBe(stopped ? "interrupted" : "error");
  expect(store.listEvents(chat.id, 0)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "error", data: expect.objectContaining({ message: "Synthetic native rejection", nativeTurnSubmitted: true }) }),
  ]));
  expect(getUsage(store, { period: "today", timeZone: "UTC" }).recent.find(item => item.conversationId === chat.id)?.status).toBe(stopped ? "interrupted" : "failed");
});

it("defers_stop_until_native_turn_has_actually_started", async () => {
  let callbacks!: CodexOptions,
    interrupted = 0;
  manager.close();
  manager = createSessionManager(
    store,
    async () => config,
    async (o) => {
      callbacks = o;
      const client = await factory(o);
      return {
        ...client,
        interrupt: async () => {
          interrupted++;
          o.onEvent({
            method: "turn/completed",
            params: {
              threadId: "native-1",
              turn: { id: "turn-1", status: "interrupted" },
            },
          });
        },
      };
    },
  );
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "queued");
  const stopping = manager.stop(chat.id);
  expect(interrupted).toBe(0);
  callbacks.onEvent({
    method: "turn/started",
    params: {
      threadId: "native-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  await stopping;
  await expect.poll(() => interrupted).toBe(1);
  expect(store.getConversation(chat.id)?.status).toBe("interrupted");
});
it("invalidates_approval_when_native_request_is_resolved", async () => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "approval");
  options.onApproval({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "native-1", turnId: "turn-1" },
  });
  const a = manager.getApprovals(c.id)[0];
  options.onEvent({
    method: "serverRequest/resolved",
    params: { threadId: "native-1", requestId: 42 },
  });
  expect(manager.getApprovals(c.id)).toHaveLength(0);
  expect(store.listEvents(c.id,0).find(event=>event.kind==='metadata'&&(event.data as any).resolvedRequestId===42)?.data)
    .toMatchObject({resolvedApprovalIds:[a.id]});
  await expect(manager.approve(c.id, a.id, "approve")).rejects.toThrow(
    "approval expired",
  );
  expect(replies).toEqual([]);
});
it("reinitializes_client_after_thread_creation_fails", async () => {
  manager.close();
  let attempts = 0,
    closedClients = 0;
  manager = createSessionManager(
    store,
    async () => config,
    async (o) => {
      const client = await factory(o);
      return {
        ...client,
        startThread: async () => {
          if (++attempts === 1) throw new Error("thread setup failed");
          return "native-1";
        },
        close: () => {
          closedClients++;
        },
      };
    },
  );
  const c = await manager.create("p", "a");
  await expect(manager.send(c.id, "first")).rejects.toThrow(
    "thread setup failed",
  );
  await manager.continue(c.id, "retry");
  expect(attempts).toBe(2);
  expect(closedClients).toBe(1);
  expect(store.getConversation(c.id)?.nativeId).toBe("native-1");
});
it("closes_late_client_without_starting_work_after_shutdown", async () => {
  manager.close();
  let release!: () => void,
    enter!: () => void,
    started = 0,
    closedClients = 0;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  manager = createSessionManager(
    store,
    async () => config,
    async (o) => {
      enter();
      await gate;
      const client = await factory(o);
      return {
        ...client,
        startThread: async () => {
          started++;
          return "native-1";
        },
        close: () => {
          closedClients++;
        },
      };
    },
  );
  const c = await manager.create("p", "a");
  const result = manager.send(c.id, "first").then(
    () => null,
    (e) => e as Error,
  );
  await entered;
  manager.close();
  release();
  expect((await result)?.message).toBe("service closed");
  expect(started).toBe(0);
  expect(closedClients).toBe(1);
});
it("keeps_timed_out_turn_submission_busy_until_native_completion", async () => {
  manager.close();
  let submissions = 0;
  manager = createSessionManager(
    store,
    async () => config,
    async (o) => {
      const client = await factory(o);
      return {
        ...client,
        startTurn: async () => {
          submissions++;
          throw Object.assign(new Error("CLI request timed out: turn/start"), {
            name: "RpcTimeoutError",
          });
        },
      };
    },
  );
  const c = await manager.create("p", "a");
  await expect(manager.send(c.id, "first")).rejects.toThrow("timed out");
  expect(store.getConversation(c.id)?.status).toBe("running");
  await expect(manager.send(c.id, "second")).rejects.toThrow(
    "conversation busy",
  );
  expect(submissions).toBe(1);
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  options.onEvent({
    method: "turn/completed",
    params: {
      threadId: "native-1",
      turn: { id: "turn-1", status: "failed", error: { message: "failed" } },
    },
  });
  expect(store.getConversation(c.id)?.status).toBe("error");
});
it("retries_native_resume_after_failed_recovery_without_creating_another_thread", async () => {
  manager.close();
  let attempts = 0,
    starts = 0;
  manager = createSessionManager(
    store,
    async () => config,
    async (o) => {
      const client = await factory(o);
      return {
        ...client,
        startThread: async () => {
          starts++;
          return "wrong";
        },
        resumeThread: async (id) => {
          resumed.push(id);
          if (++attempts === 1) throw new Error("resume failed");
        },
      };
    },
  );
  const c = store.createConversation({
    projectId: "p",
    agentId: "a",
    cli: "codex",
    model: null,
  });
  store.updateConversation(c.id, {
    nativeId: "original",
    status: "interrupted",
  });
  await expect(manager.continue(c.id, "first")).rejects.toThrow(
    "resume failed",
  );
  await manager.continue(c.id, "retry");
  expect(resumed).toEqual(["original", "original"]);
  expect(starts).toBe(0);
  expect(store.getConversation(c.id)?.nativeId).toBe("original");
});
it("keeps_other_pending_approvals_when_one_request_resolves", async () => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  for (const id of [42, 43])
    options.onApproval({
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native-1", turnId: "turn-1" },
    });
  options.onEvent({
    method: "serverRequest/resolved",
    params: { threadId: "native-1", requestId: 42 },
  });
  expect(manager.getApprovals(c.id).map((a) => a.nativeRequestId)).toEqual([
    43,
  ]);
  expect(store.getConversation(c.id)?.status).toBe("approval");
});
it("checks_cli_readiness_without_starting_work_and_filters_connection_errors", async () => {
  expect(await manager.getCliStatus("p")).toEqual({
    status: "ready",
    version: "0.154.0",
  });
  expect(turns).toEqual([]);
  expect(store.listConversations()).toEqual([]);
  manager.close();
  manager = createSessionManager(
    store,
    async () => config,
    async () => {
      throw new Error("private account details");
    },
  );
  expect(await manager.getCliStatus()).toEqual({
    status: "unavailable",
    version: null,
  });
});
it.each(["codex", "omp"] as const)("applies %s runtime changes at the next turn by restarting and resuming its native session", async (cli) => {
  manager.close();
  const scoped = structuredClone(config);
  scoped.agents[0].runtime = { [cli]: { args: cli === "codex" ? ["--strict-config"] : ["--thinking", "high"] } };
  const launches: (CodexOptions & { resume?: string })[] = [];
  let exits = 0;
  const runtimeFactory = async (o: CodexOptions) => {
    launches.push(o);
    return { ...await factory(o),
      close() { exits++; o.onExit("previous CLI closed"); },
    };
  };
  manager = createSessionManager(store, async () => structuredClone(scoped), runtimeFactory, runtimeFactory, home);
  const c = await manager.create("p", "a", undefined, cli);
  await manager.send(c.id, "first");
  scoped.agents[0].runtime = { [cli]: { args: cli === "codex" ? ["--analytics-default-enabled"] : ["--thinking", "medium"] } };
  await expect(manager.send(c.id, "while busy")).rejects.toThrow("conversation busy");
  expect(launches).toHaveLength(1);
  launches[0].onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await manager.send(c.id, "second");
  expect(launches).toHaveLength(2);
  expect(exits).toBe(1);
  expect(launches[1].extraArgs).toEqual(cli === "codex" ? ["--analytics-default-enabled"] : ["--thinking", "medium"]);
  expect(store.getConversation(c.id)).toMatchObject({ nativeId: "native-1", status: "running" });
  if (cli === "codex") expect(resumed).toEqual(["native-1"]);
  else expect(launches[1].resume).toBe("native-1");
  launches[0].onExit("late old-process exit");
  expect(store.getConversation(c.id)?.status).toBe("running");
});

it("notifies the settled observer only after a successful turn is saved", async () => {
  manager.close();
  const observations: string[] = [];
  manager = createSessionManager(store, async () => structuredClone(config), factory, undefined, home, (id) => {
    observations.push(`${id}:${store.getConversation(id)?.status}`);
  });
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "interrupted" } } });
  expect(observations).toEqual([]);
  await manager.continue(c.id, "second");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  expect(observations).toEqual([`${c.id}:idle`]);
});
it("reads Agent model catalogs without a Project and ignores legacy Project runtime", async () => {
  manager.close();
  const scoped = structuredClone(config);
  scoped.projects[0].runtime = { codex: { args: ["--strict-config"] } };
  scoped.agents[0].runtime = { codex: { args: ["--strict-config"] } };
  manager = createSessionManager(store, async () => scoped, factory);
  expect(await manager.listModels(undefined, "codex", { agentId: "a" })).toEqual([{ id: "native-model", label: "Native" }]);
  expect(options.extraArgs).toEqual(["--strict-config"]);
  await manager.getCliStatus("p", "codex", {agentId:"a"});
  expect(options.extraArgs).toEqual(["--strict-config"]);
  expect(turns).toEqual([]);
});

it("persists native Codex hook progress and results independently of conversation status", async () => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  const run = { id: "hook-1", eventName: "preToolUse", sourcePath: "/tmp/hooks/check.sh",
    handlerType: "command", status: "running", entries: [], durationMs: null };
  options.onEvent({ method: "hook/started", params: { threadId: "native-1", turnId: "turn-1", run } });
  options.onEvent({ method: "hook/completed", params: { threadId: "native-1", turnId: "turn-1",
    run: { ...run, status: "failed", durationMs: 25, entries: [{ kind: "error", text: "Check failed" }] } } });
  options.onEvent({ method: "hook/completed", params: { threadId: "another-thread", run } });
  const hooks = store.listEvents(c.id, 0).filter((event) => event.kind === "hook");
  expect(hooks.map((event) => event.data)).toEqual([
    { runId: expect.any(String), id: "hook-1", name: "check.sh", event: "preToolUse", status: "running", source: "codex", turnId: "turn-1" },
    { runId: expect.any(String), id: "hook-1", name: "check.sh", event: "preToolUse", status: "failed", source: "codex",
      turnId: "turn-1", durationMs: 25, output: "Check failed" },
  ]);
  expect(store.getConversation(c.id)?.status).toBe("running");
  expect(store.listEvents(c.id, 0).some((event) => event.kind === "tool")).toBe(false);
  manager.close();
  store.close();
  store = openStore(home);
  expect(store.listEvents(c.id, 0).filter((event) => event.kind === "hook")).toEqual(hooks);
});

it("persists only a real OMP extension failure without inventing hook progress", async () => {
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), factory, factory, home);
  const c = await manager.create("p", "a", undefined, "omp");
  await manager.send(c.id, "first");
  options.onEvent({ method: "omp/extension_error", params: { threadId: "native-1", turnId: "turn-1",
    id: "extension-failure-1", extensionPath: "/tmp/extensions/audit.ts", event: "tool_call", error: "Policy rejected" } });
  expect(store.listEvents(c.id, 0).filter((event) => event.kind === "hook").map((event) => event.data))
    .toEqual([{ runId: expect.any(String), id: "extension-failure-1", name: "audit.ts", event: "tool_call", status: "failed",
      source: "omp", turnId: "turn-1", output: "Policy rejected" }]);
  expect(store.getConversation(c.id)?.status).toBe("running");
});

it("branches at a historical user message with a verified native prefix and preserves the source", async () => {
  manager.close();
  const forks: unknown[] = [];
  const branchFactory = async (o: CodexOptions): Promise<CodexClient> => ({
    ...await factory(o),
    forkThread: async (nativeId, texts, index) => { forks.push({ nativeId, texts, index }); return "native-branch"; },
  });
  manager = createSessionManager(store, async () => structuredClone(config), branchFactory);
  const source = await manager.create("p", "a");
  await manager.send(source.id, "first question");
  options.onEvent({ method: "item/agentMessage/delta", params: { threadId: "native-1", itemId: "answer", delta: "first answer" } });
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await manager.send(source.id, "second question");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const originalEvents = store.listEvents(source.id, 0);
  const target = originalEvents.filter(e => e.kind === "user")[1];
  const branch = await manager.branch(source.id, target.id, "revised question");
  expect(branch.id).not.toBe(source.id);
  expect(branch.nativeId).toBe("native-branch");
  expect(branch.branchedFrom).toEqual({ conversationId: source.id, eventId: target.id });
  expect(forks).toEqual([{ nativeId: "native-1", texts: ["first question", "second question"], index: 1 }]);
  expect(store.listEvents(source.id, 0)).toEqual(originalEvents);
  expect(store.listEvents(branch.id, 0).filter(e => e.kind === "user").map(e => (e.data as { text: string }).text))
    .toEqual(["first question", "revised question"]);
  expect(resumed).toContain("native-branch");
});

it("edits in the same conversation, replaces only the selected suffix and resumes the verified native prefix", async () => {
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), forkThread: async () => "native-revised",
  }));
  const source = await manager.create("p", "a");
  for (const text of ["prefix", "old request", "later request"]) {
    await manager.send(source.id, text);
    options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  }
  const original = store.listEvents(source.id, 0);
  const message = original.filter(e => e.kind === "user")[1];
  const revised = await manager.edit(source.id, message.id, "new request");
  expect(revised.id).toBe(source.id);
  expect(revised.nativeId).toBe("native-revised");
  expect(store.listConversations()).toHaveLength(1);
  expect(store.listEvents(source.id, 0).filter(e => e.kind === "user").map(e => (e.data as any).text))
    .toEqual(["prefix", "new request"]);
  const from = original.find(e => (e.data as any).runId === (message.data as any).runId)!.id;
  expect(store.listEvents(source.id, 0).filter(e => e.id < message.id)).toEqual(original.filter(e => e.id < from));
  expect(resumed).toContain("native-revised");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-revised", turn: { id: "turn-1", status: "completed" } } });
  await manager.send(source.id, "follow up");
  expect(turns).toEqual(["prefix", "old request", "later request", "new request", "follow up"]);
  manager.close(); store.close(); store = openStore(home);
  expect(store.listEvents(source.id, 0).filter(e => e.kind === "user").map(e => (e.data as any).text))
    .toEqual(["prefix", "new request", "follow up"]);
});

it.each(["edit", "branch"] as const)("releases the native writer before %s resumes the revised thread", async action => {
  manager.close();
  let held = false, releases = 0;
  manager = createSessionManager(store, async () => structuredClone(config), async o => {
    let ownsWriter = false;
    return { ...await factory(o),
    forkThread: async () => { held = true; ownsWriter = true; return "revised-native"; },
    resumeThread: async nativeId => { if (nativeId === "revised-native" && held) throw new Error("active writer"); },
    close: async () => { await Promise.resolve(); if (ownsWriter) held = false; releases++; },
  }; });
  const source = await manager.create("p", "a");
  await manager.send(source.id, "old request");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const user = store.listEvents(source.id, 0).find(e => e.kind === "user")!;
  const revised = await manager[action](source.id, user.id, "new request");
  expect(store.listEvents(revised.id, 0).filter(e => e.kind === "error")).toHaveLength(0);
  expect(releases).toBeGreaterThan(0);
  expect(turns).toContain("new request");
});

it.each(["branch", "edit"] as const)("does not change history when %s cannot verify its native prefix", async action => {
  const source = await manager.create("p", "a");
  await manager.send(source.id, "question");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const user = store.listEvents(source.id, 0).find(e => e.kind === "user")!;
  await expect(manager[action](source.id, user.id, "edited")).rejects.toThrow("Native message branching unavailable");
  expect(store.listConversations()).toHaveLength(1);
});

it.each(["branch", "edit"] as const)("rejects busy %s and another conversation's message before launching a CLI", async action => {
  const source = await manager.create("p", "a");
  await manager.send(source.id, "question");
  const user = store.listEvents(source.id, 0).find(e => e.kind === "user")!;
  await expect(manager[action](source.id, user.id, "edited")).rejects.toThrow("conversation busy");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const other = await manager.create("p", "a");
  const otherUser = store.appendEvent(other.id, "user", { text: "other" });
  await expect(manager[action](source.id, otherUser.id, "edited")).rejects.toThrow("invalid branch message");
  await expect(manager[action](source.id, user.id, " ")).rejects.toThrow("invalid empty message");
  expect(store.listConversations()).toHaveLength(2);
});

it("locks the source while branching so a concurrent message cannot change the verified prefix", async () => {
  manager.close();
  let release!: (nativeId: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), forkThread: async () => { entered(); return await new Promise<string>(resolve => { release = resolve; }); },
  }));
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "original");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const event = store.listEvents(source.id, 0).find(e => e.kind === "user")!;
  const pending = manager.branch(source.id, event.id, "edited");
  await started;
  await expect(manager.send(source.id, "racing message")).rejects.toThrow("conversation busy");
  await expect(manager.branch(source.id, event.id, "other edit")).rejects.toThrow("conversation busy");
  release("new-native");
  await pending;
  await manager.send(source.id, "next message");
  expect(turns).toEqual(["original", "edited", "next message"]);
});

it("returns the persisted branch when sending its edited turn fails", async () => {
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), forkThread: async () => "new-native",
    startTurn: async (nativeId, text) => { if (nativeId === "new-native") throw new Error("provider unavailable"); turns.push(text); return "turn-1"; },
  }));
  const source = await manager.create("p", "a");
  await manager.send(source.id, "original");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const event = store.listEvents(source.id, 0).find(e => e.kind === "user")!;
  const branch = await manager.branch(source.id, event.id, "edited");
  expect(branch.status).toBe("error");
  expect(store.listEvents(branch.id, 0).filter(e => e.kind === "error").at(-1)?.data).toMatchObject({ message: "provider unavailable" });
  expect(store.getConversation(source.id)?.status).toBe("idle");
});

it("loads confirmed memory through Codex instructions and records completion only after native acknowledgement", async () => {
  manager.close();
  const memory = await createKnowledge(home, { kind: "memory", scope: "agent", agentId: "a", projectId: "p",
    level: "L3", status: "active", title: "Reading convention", content: "Use lowercase article tags." }, config);
  await createKnowledge(home, { kind: "memory", scope: "global", level: "L4", status: "candidate",
    title: "Unconfirmed", content: "Never load this candidate." }, config);
  const instructions: string[] = [];
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), startThread: async (p) => {
      instructions.push(p.instructions);
      enter();
      await new Promise<void>((resolve) => { release = resolve; });
      return "native-1";
    },
  }), undefined, home);
  const c = await manager.create("p", "a");
  const sent = manager.send(c.id, "review the reading list");
  await entered;
  expect(store.listEvents(c.id, 0).filter((event) => event.kind === "metadata")
    .some((event) => (event.data as { status: string }).status === "completed")).toBe(false);
  release();
  await sent;
  expect(instructions[0]).toContain(memory.content);
  expect(instructions[0]).toContain("untrusted reference data");
  expect(instructions[0]).not.toContain("Never load this candidate");
  expect(turns).toEqual(["review the reading list"]);
  const userEvents=store.listEvents(c.id, 0).filter((event) => event.kind === "user").map((event) => event.data as {text:string;runId:string;invocationId:string});
  expect(userEvents).toEqual([{text:"review the reading list",runId:expect.any(String),invocationId:expect.any(String)}]);
  expect(userEvents[0].invocationId).toBe(userEvents[0].runId);
  const grouped=groupChatTurns(store.listEvents(c.id,0)),owner=grouped.find(turn=>turn.events.some(event=>event.kind==='user'))!;
  expect(owner.events.filter(event=>event.kind==='metadata'&&'memoryRecall' in (event.data as object))).toHaveLength(2);
  const recall = store.listEvents(c.id, 0).filter((event) => event.kind === "metadata" && "memoryRecall" in (event.data as object)).map((event) => event.data);
  expect(recall).toEqual([
    { runId:expect.any(String), memoryRecall: expect.any(String), status: "running", count: 1, entryIds: [memory.id], entries: [{ title: memory.title, kind: "memory" }] },
    { runId:expect.any(String), memoryRecall: (recall[0] as { memoryRecall: string }).memoryRecall, status: "completed", count: 1, entryIds: [memory.id], entries: [{ title: memory.title, kind: "memory" }] },
  ]);
});

it("refreshes Codex instructions when confirmed memory changes or is no longer active", async () => {
  manager.close();
  const memory = await createKnowledge(home, { kind: "memory", scope: "global", level: "L4", status: "active",
    title: "Writing convention", content: "Use the first convention." }, config);
  const loaded: string[] = [];
  let clients = 0;
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => {
    clients++;
    return { ...await factory(o),
      startThread: async (p) => { loaded.push(p.instructions); return "native-1"; },
      resumeThread: async (id, _mcp, instructions) => { resumed.push(id); loaded.push(instructions ?? ""); },
    };
  }, undefined, home);
  const c = await manager.create("p", "a");
  const finish = () => options.onEvent({ method: "turn/completed", params: {
    threadId: "native-1", turn: { id: "turn-1", status: "completed" },
  } });
  await manager.send(c.id, "first");
  finish();
  await updateKnowledge(home, memory.id, { content: "Use the updated convention." }, config);
  await updateKnowledge(home, memory.id, { status: "active" }, config);
  await manager.send(c.id, "second");
  finish();
  await updateKnowledge(home, memory.id, { status: "candidate" }, config);
  await manager.send(c.id, "third");
  expect(clients).toBe(1);
  expect(loaded).toHaveLength(3);
  expect(loaded[0]).toContain("Use the first convention.");
  expect(loaded[1]).toContain("Use the updated convention.");
  expect(loaded[1]).not.toContain("Use the first convention.");
  expect(loaded[2]).toContain("Review\n\nMandala CLI command:");
  expect(resumed).toEqual(["native-1", "native-1"]);
  expect(turns).toEqual(["first", "second", "third"]);
});

it("restarts OMP with updated memory instructions while restoring its native session and runtime parameters", async () => {
  manager.close();
  const scoped = structuredClone(config);
  scoped.agents[0].runtime = { omp: { args: ["--no-title"] } };
  scoped.agents[0].mcp = [{ name: "reader", transport: "stdio", command: "node", args: ["reader.mjs"] }];
  const memory = await createKnowledge(home, { kind: "memory", scope: "project", projectId: "p", level: "L3",
    status: "active", title: "Reading convention", content: "Use the first convention." }, scoped);
  const starts: { resume?: string; instructions: string; args?: string[]; servers: string[] }[] = [];
  let closedClients = 0;
  manager = createSessionManager(store, async () => scoped, factory, async (o: OmpOptions) => {
    starts.push({ resume: o.resume, instructions: o.instructions ? readFileSync(o.instructions, "utf8") : "",
      args: o.extraArgs, servers: Object.keys(JSON.parse(readFileSync(join(o.pluginDir!, "mcp.json"), "utf8")).mcpServers) });
    return { ...await factory(o), close: () => { closedClients++; } };
  }, home);
  const c = await manager.create("p", "a", undefined, "omp");
  await manager.send(c.id, "first");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await updateKnowledge(home, memory.id, { content: "Use the updated convention." }, scoped);
  await updateKnowledge(home, memory.id, { status: "active" }, scoped);
  await manager.send(c.id, "second");
  expect(starts).toHaveLength(2);
  expect(starts[0].instructions).toContain("Use the first convention.");
  expect(starts[1]).toMatchObject({ resume: "native-1", args: ["--no-title"], servers: ["reader"] });
  expect(starts[1].instructions).toContain("Use the updated convention.");
  expect(starts[1].instructions).not.toContain("Use the first convention.");
  expect(closedClients).toBe(1);
  expect(store.getConversation(c.id)?.nativeId).toBe("native-1");
  expect(turns).toEqual(["first", "second"]);
});

it("fails before submitting a new user turn when confirmed memory cannot be read instead of reusing stale instructions", async () => {
  manager.close();
  await createKnowledge(home, { kind: "memory", scope: "global", level: "L4", status: "active",
    title: "Convention", content: "Use the confirmed convention." }, config);
  let closedClients = 0;
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), close: () => { closedClients++; },
  }), undefined, home);
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  writeFileSync(join(home, "knowledge.json"), "{private corrupt memory");
  await expect(manager.send(c.id, "second")).rejects.toThrow("Cannot load confirmed memory");
  expect(closedClients).toBe(1);
  expect(turns).toEqual(["first"]);
  expect(store.listEvents(c.id, 0).filter((event) => event.kind === "user").map(event => (event.data as { text: string }).text)).toEqual(["first", "second"]);
  const failed = store.listEvents(c.id, 0).filter((event) => event.kind === "metadata").at(-1)?.data;
  expect(failed).toMatchObject({ status: "failed", count: 0, entryIds: [], message: expect.stringContaining("Cannot load confirmed memory") });
  expect(JSON.stringify(failed)).not.toContain("private corrupt memory");
  expect(store.getConversation(c.id)?.status).toBe("error");
});

it("does not report memory loaded when native instruction acknowledgement fails", async () => {
  manager.close();
  const memory = await createKnowledge(home, { kind: "memory", scope: "global", level: "L4", status: "active",
    title: "Convention", content: "Use the confirmed convention." }, config);
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o), startThread: async () => { throw new Error("native load failed"); },
  }), undefined, home);
  const c = await manager.create("p", "a");
  await expect(manager.send(c.id, "first")).rejects.toThrow("native load failed");
  const grouped=groupChatTurns(store.listEvents(c.id,0)),owner=grouped.find(turn=>turn.events.some(event=>event.kind==='user'))!;
  expect(owner.events.filter(event=>event.kind==='metadata'&&'memoryRecall' in (event.data as object))).toHaveLength(2);
  const recall = store.listEvents(c.id, 0).filter((event) => event.kind === "metadata" && "memoryRecall" in (event.data as object)).map((event) => event.data);
  expect(recall).toEqual([
    { runId:expect.any(String), memoryRecall: expect.any(String), status: "running", count: 1, entryIds: [memory.id], entries: [{ title: memory.title, kind: "memory" }] },
    { runId:expect.any(String), memoryRecall: (recall[0] as { memoryRecall: string }).memoryRecall, status: "failed", count: 1, entryIds: [memory.id], entries: [{ title: memory.title, kind: "memory" }],
      message: expect.stringContaining("CLI did not acknowledge") },
  ]);
  expect(turns).toEqual([]);
});

it("keeps an empty knowledge library quiet and reloads short-lived memory only for a relevant turn", async () => {
  manager.close();
  const loaded: string[] = [];
  manager = createSessionManager(store, async () => structuredClone(config), async (o) => ({
    ...await factory(o),
    startThread: async (p) => { loaded.push(p.instructions); return "native-1"; },
    resumeThread: async (_id, _mcp, instructions) => { loaded.push(instructions ?? ""); },
  }), undefined, home);
  const c = await manager.create("p", "a");
  const finish = () => options.onEvent({ method: "turn/completed", params: {
    threadId: "native-1", turn: { id: "turn-1", status: "completed" },
  } });
  await manager.send(c.id, "hello");
  expect(store.listEvents(c.id, 0).filter((event) => event.kind === "metadata" && "memoryRecall" in (event.data as object))).toEqual([]);
  finish();
  const memory = await createKnowledge(home, { kind: "memory", scope: "agent", agentId: "a", level: "L1",
    status: "active", title: "Article tags", content: "Use lowercase article tags." }, config);
  await manager.send(c.id, "article tags");
  finish();
  await manager.send(c.id, "flight planning");
  finish();
  await manager.send(c.id, "hello again");
  const completed = store.listEvents(c.id, 0).filter((event) => event.kind === "metadata" &&
    (event.data as { status: string }).status === "completed").map((event) => event.data);
  expect(completed).toEqual([
    { runId:expect.any(String), memoryRecall: expect.any(String), status: "completed", count: 1, entryIds: [memory.id], entries: [{ title: memory.title, kind: "memory" }] },
    { runId:expect.any(String), memoryRecall: expect.any(String), status: "completed", count: 0, entryIds: [], entries: [] },
  ]);
  expect(loaded).toHaveLength(4);
  expect(loaded[0]).toContain("Review\n\nMandala CLI command:");
  expect(loaded[1]).toContain(memory.content);
  expect(loaded[2]).toContain("Review\n\nMandala CLI command:");
  expect(turns).toEqual(["hello", "article tags", "flight planning", "hello again"]);
});


it.each(["codex", "omp"] as const)("reads the %s system model catalog without Project or Agent runtime overrides", async (cli) => {
  manager.close();
  const isolated = structuredClone(config);
  isolated.projects[0].runtime = { codex: { env: { UNDEFINED_PROJECT_ONLY: "${MISSING_CATALOG_SOURCE}" } } };
  let launched: any, closed = false;
  const catalogFactory = async (o: any) => {
    launched = o;
    expect(existsSync(o.cwd)).toBe(true);
    return { ...await factory(o), close: () => { closed = true; } };
  };
  manager = createSessionManager(store, async () => isolated, catalogFactory, catalogFactory);
  expect(await manager.listModels(undefined, cli)).toEqual([{ id: "native-model", label: "Native" }]);
  expect(launched.extraArgs).toEqual([]);
  expect(launched.env).toEqual({});
  expect(launched.cwd).not.toBe(process.cwd());
  expect(existsSync(launched.cwd)).toBe(false);
  expect(closed).toBe(true);
  expect(turns).toEqual([]);
});

it("stopping Runtime access rejects new chats while preserving existing sessions", async () => {
  manager.close();
  const isolated = structuredClone(config);
  manager = createSessionManager(store, async () => isolated, factory);
  const chat = await manager.create("p", "a");
  isolated.runtimes = ["omp"];
  await expect(manager.create("p", "a", undefined, "codex")).rejects.toThrow("Runtime disabled");
  await manager.send(chat.id, "Continue existing native execution");
  expect(turns).toEqual(["Continue existing native execution"]);
  expect(store.getConversation(chat.id)?.cli).toBe("codex");
});

it.each(["no reply", "acknowledgement only"])("forces a bounded stop when native interrupt gives %s", async (mode) => {
  vi.useFakeTimers();
  manager.close();
  const close = vi.fn();
  manager = createSessionManager(store, async () => config, async o => ({
    ...await factory(o), close,
    interrupt: () => mode === "no reply" ? new Promise<void>(() => {}) : Promise.resolve(),
  }));
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  const old = options;
  old.onEvent({method:'openmana/usageBaseline',params:{threadId:'native-1',fresh:true}});
  old.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  if(mode==='no reply')old.onEvent({method:'thread/tokenUsage/updated',params:{threadId:'native-1',turnId:'turn-1',tokenUsage:{total:{inputTokens:400,outputTokens:20,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:420},last:{inputTokens:400,outputTokens:20,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:420}}}});
  const stopping = manager.stop(c.id);
  await vi.advanceTimersByTimeAsync(3500);
  expect(store.getConversation(c.id)).toMatchObject({ status: "interrupted", turnId: null, nativeId: "native-1" });
  await stopping;
  expect(getUsage(store,{period:'today',timeZone:'UTC'}).recent[0]).toMatchObject({status:'interrupted',coverage:mode==='no reply'?'partial':'unknown'});
  expect(getUsage(store,{period:'today',timeZone:'UTC'}).totals.totalTokens).toBe(mode==='no reply'?420:null);
  expect(close).toHaveBeenCalledOnce();
  await manager.continue(c.id, "continue");
  old.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  expect(store.getConversation(c.id)?.status).toBe("interrupted");
  expect(resumed).toEqual([]);
  expect(manager.listUserInputs(c.id)).toMatchObject([{text:"continue",state:"queued"}]);
});

it("can stop during startup without submitting a late turn", async () => {
  vi.useFakeTimers();
  manager.close();
  let release!: (value: CodexClient) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  manager = createSessionManager(store, async () => config, o => {
    options = o; entered();
    return new Promise<CodexClient>(resolve => { release = resolve; });
  });
  const c = await manager.create("p", "a");
  const sending = manager.send(c.id, "first");
  await started;
  const stopping = manager.stop(c.id);
  await vi.advanceTimersByTimeAsync(3500);
  expect(store.getConversation(c.id)?.status).toBe("interrupted");
  await stopping;
  expect(options.signal?.aborted).toBe(true);
  const close = vi.fn();
  release({ ...await factory(options), close });
  await sending;
  expect(close).toHaveBeenCalledOnce();
  expect(turns).toEqual([]);
});

it.each([["", ""], ["", "a"], ["p", ""], ["p", "a"]])("runs optional Project=%s and Agent=%s without inventing an identity", async (projectId, agentId) => {
  const c = await manager.create(projectId, agentId, undefined, "codex", { workspaceId: null });
  expect(c).toMatchObject({ projectId, agentId, workspaceId: null });
  await manager.send(c.id, "Personal discussion");
  expect(turns).toEqual(["Personal discussion"]);
  expect(options.cwd).not.toBe(config.projects[0].cwd);
  expect(options.cwd).not.toBe(process.env.HOME);
});
it("selects independent Workspaces within one Project and rejects an unknown selection", async () => {
  manager.close();
  const c = structuredClone(config);
  c.projects[0].workspaces = [{ id: "writing", name: "Writing", cwd: "/tmp", resources: [] },
    { id: "reading", name: "Reading", cwd: home, resources: [] }];
  manager = createSessionManager(store, async () => c, factory, undefined, home);
  const reading = await manager.create("p", "a", undefined, "codex", { workspaceId: "reading" });
  await manager.send(reading.id, "Read the personal sample");
  expect(options.cwd).toBe(home);
  expect(reading.workspaceId).toBe("reading");
  await expect(manager.create("p", "a", undefined, "codex", { workspaceId: "missing" })).rejects.toThrow("invalid workspace");
});

it("forks after a completed reply without rerunning it or changing the source", async () => {
  manager.close();
  const forks: unknown[] = [];
  manager = createSessionManager(store, async () => structuredClone(config), async o => ({
    ...await factory(o), forkThread: async (nativeId, texts, index) => { forks.push({nativeId, texts, index}); return "native-reply-fork"; },
  }));
  const source = await manager.create("p", "a");
  await manager.send(source.id, "first question");
  options.onEvent({method: "item/agentMessage/delta", params: {threadId: "native-1", turnId:"turn-1", itemId: "answer", delta: "first answer"}});
  options.onEvent({method: "turn/completed", params: {threadId: "native-1", turn: {id: "turn-1", status: "completed"}}});
  const checkpoint = store.listEvents(source.id, 0).find(e => e.kind === "status" && (e.data as any).status === "idle")!;
  await manager.send(source.id, "later question");
  options.onEvent({method: "turn/completed", params: {threadId: "native-1", turn: {id: "turn-1", status: "completed"}}});
  const before = store.listEvents(source.id, 0), sent = [...turns];
  const fork = await manager.fork(source.id, checkpoint.id);
  expect(fork.status).toBe("idle");
  expect(fork.nativeId).toBe("native-reply-fork");
  expect(forks).toEqual([{nativeId: "native-1", texts: ["first question", "later question"], index: 1}]);
  expect(turns).toEqual(sent);
  expect(store.listEvents(source.id, 0)).toEqual(before);
  expect(store.listEvents(fork.id, 0).filter(e => e.kind === "user").map(e => (e.data as any).text)).toEqual(["first question"]);
  expect(store.listEvents(fork.id, 0).filter(e => e.kind === "text").map(e => (e.data as any).text)).toEqual(["first answer"]);
  await manager.send(fork.id, "continue fork");
  expect(resumed).toContain("native-reply-fork");
});

it.each(["approve-session", "approve-rule"] as const)("forwards %s using the pending native request's scope", async decision => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "approval");
  options.onApproval({id:42,method:"item/commandExecution/requestApproval",params:{threadId:"native-1",turnId:"turn-1",proposedExecpolicyAmendment:["git","status"]}});
  const approval = manager.getApprovals(c.id)[0];
  await manager.approve(c.id, approval.id, decision);
  expect(replies).toEqual([{id:42,result:{decision:decision === "approve-session" ? "acceptForSession" : {acceptWithExecpolicyAmendment:{execpolicy_amendment:["git","status"]}}}}]);
  expect(manager.getApprovals(c.id)).toEqual([]);
  expect(store.getConversation(c.id)?.approvalMode).not.toBe("auto");
});

it("rejects unsupported remembered approval without resolving the pending request", async () => {
  const c = await manager.create("p", "a");
  await manager.send(c.id, "approval");
  options.onApproval({id:42,method:"omp/confirm",params:{threadId:"native-1",turnId:"turn-1"}});
  const approval = manager.getApprovals(c.id)[0];
  await expect(manager.approve(c.id, approval.id, "approve-session")).rejects.toThrow("unsupported approval decision");
  expect(replies).toEqual([]);
  expect(manager.getApprovals(c.id)).toHaveLength(1);
  await manager.approve(c.id, approval.id, "approve");
  expect(replies).toEqual([{id:42,result:{decision:"accept"}}]);
});


it("ignores previous terminal after next queued task starts", async () => {
  const clients = new Map<string, CodexOptions>();
  const nativeTurns: { threadId: string; turnId: string; text: string }[] = [];
  const distinctFactory = async (o: CodexOptions): Promise<CodexClient> => {
    const client = await factory(o);
    const threadId = `native-${clients.size + 1}`;
    clients.set(threadId, o);
    return { ...client, startThread: async () => threadId,
      startTurn: async (_, text) => {
        const turnId = `turn-${nativeTurns.length + 1}`;
        nativeTurns.push({ threadId, turnId, text });
        o.onEvent({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
        return turnId;
      } };
  };
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), distinctFactory);
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "source goal");
  const first = await manager.createTask(source.id, "a", "first task");
  await vi.waitFor(() => expect(manager.listTasks().find(item => item.id === first.id)?.status).toBe("running"));
  await vi.waitFor(() => expect(nativeTurns.some(turn => turn.text === "first task")).toBe(true));
  const turn = nativeTurns.find(turn => turn.text === "first task")!;
  const finish = (turnId: string) => clients.get(turn.threadId)!.onEvent({ method: "turn/completed", params: {
    threadId: turn.threadId, turn: { id: turnId, status: "completed" },
  } });
  finish(turn.turnId);
  const second = await manager.createTask(source.id, "a", "second task", first.targetConversationId);
  await vi.waitFor(() => expect(nativeTurns.some(turn => turn.text === "second task")).toBe(true));
  finish("unknown-turn");
  finish(turn.turnId);
  expect(manager.listTasks().find(item => item.id === second.id)?.status).toBe("running");
  expect(manager.listTasks().filter(task => task.kind === "return")).toHaveLength(1);
  expect(store.getConversation(first.targetConversationId)?.turnId).toBe(nativeTurns.find(turn => turn.text === "second task")!.turnId);
});

it("scopes identical native turn strings to their session and invocation", async () => {
  const clients: CodexOptions[] = [];
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async o => {
    const client = await factory(o);
    const threadId = `native-${clients.length + 1}`;
    clients.push(o);
    return { ...client, startThread: async () => threadId };
  });
  const first = await manager.create("p", "a", undefined, undefined, {workspaceId:null}), second = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(first.id, "first");
  await manager.send(second.id, "second");
  const finish = (client: number, threadId: string) => clients[client].onEvent({ method: "turn/completed", params: {
    threadId, turn: { id: "turn-1", status: "completed" },
  } });
  finish(1, "native-1");
  expect(store.getConversation(second.id)?.status).toBe("running");
  finish(0, "native-1");
  expect(store.getConversation(first.id)?.status).toBe("idle");
  expect(store.getConversation(second.id)?.status).toBe("running");
  finish(1, "native-2");
  expect(store.getConversation(second.id)?.status).toBe("idle");
});

it("ignores stopped invocation completion while continuation is starting", async () => {
  let active = "turn-1";
  let release!: (id: string) => void;
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async o => {
    const client = await factory(o);
    return { ...client, startTurn: async () => {
      if (active === "turn-2") return new Promise<string>(resolve => { release = resolve; });
      o.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: active } } });
      return active;
    }, interrupt: async () => o.onEvent({ method: "turn/completed", params: {
      threadId: "native-1", turn: { id: active, status: "interrupted" },
    } }) };
  });
  const c = await manager.create("p", "a");
  await manager.send(c.id, "first");
  await manager.stop(c.id);
  active = "turn-2";
  const continuing = manager.continue(c.id, "continue");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  expect(store.getConversation(c.id)?.status).toBe("running");
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: active } } });
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: active, status: "completed" } } });
  release(active);
  await continuing;
  expect(store.getConversation(c.id)).toMatchObject({ status: "idle", turnId: null });
});

it("isolates OMP turns by process generation when events lack request correlation", async () => {
  const callbacks: OmpOptions[] = [], closed: number[] = [];
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), factory, async o => {
    const client = await factory(o);
    const index = callbacks.length;
    callbacks.push(o);
    return { ...client, close: () => { closed.push(index); } };
  }, home);
  const c = await manager.create("p", "a", undefined, "omp");
  await manager.send(c.id, "first");
  const finish = (index: number) => callbacks[index].onEvent({ method: "turn/completed", params: {
    threadId: "native-1", turn: { id: "turn-1", status: "completed" },
  } });
  finish(0);
  expect(closed).toEqual([0]);
  await manager.send(c.id, "second");
  expect(callbacks).toHaveLength(2);
  expect(callbacks[1].resume).toBe("native-1");
  callbacks[0].onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  finish(0);
  expect(store.getConversation(c.id)?.status).toBe("running");
  finish(1);
  expect(store.getConversation(c.id)?.status).toBe("idle");
});

it("keeps accepted OMP completion when retiring client rejects its pending prompt", async () => {
  let rejectPrompt!: (error: Error) => void;
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), factory, async o => {
    const client = await factory(o);
    return { ...client, startTurn: async () => new Promise<string>((_, reject) => { rejectPrompt = reject; }),
      close: () => rejectPrompt?.(new Error("OMP closed")) };
  }, home);
  const c = await manager.create("p", "a", undefined, "omp");
  const sending = manager.send(c.id, "first");
  const outcome = sending.then(() => "resolved", error => error.message);
  await vi.waitFor(() => expect(rejectPrompt).toBeTypeOf("function"));
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  expect(await outcome).toBe("resolved");
  expect(store.getConversation(c.id)).toMatchObject({ status: "idle", turnId: null });
  expect(store.listEvents(c.id, 0).filter(event => event.kind === "error")).toEqual([]);
});

it("does not fail queued OMP successor when completed predecessor prompt rejects late", async () => {
  const callbacks: OmpOptions[] = [];
  let rejectFirst!: (error: Error) => void;
  manager.close();
  const isolatedConfig = structuredClone(config);
  isolatedConfig.projects[0].cwd = join(home, "project");
  mkdirSync(isolatedConfig.projects[0].cwd);
  manager = createSessionManager(store, async () => structuredClone(isolatedConfig), factory, async o => {
    const client = await factory(o);
    const index = callbacks.length;
    callbacks.push(o);
    return { ...client, startTurn: async () => {
      const turnId = `turn-${index + 1}`;
      o.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: turnId } } });
      return index === 0 ? new Promise<string>((_, reject) => { rejectFirst = reject; }) : turnId;
    }, close: () => {} };
  }, home);
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "source");
  const target = await manager.create("p", "a", undefined, "omp");
  const first = await manager.createTask(source.id, "a", "first", target.id);
  await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
  callbacks[0].onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const second = await manager.createTask(source.id, "a", "second", target.id);
  await vi.waitFor(() => expect(callbacks).toHaveLength(2));
  rejectFirst(new Error("OMP closed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(manager.taskService.listRunControls({userId:store.ownerUserId},first.id).map(run=>run.state)).toEqual(["succeeded","running"]);
  expect(manager.listTasks().find(item => item.id === second.id)?.status).toBe("running");
  expect(store.getConversation(target.id)).toMatchObject({ status: "running", turnId: "turn-2" });
  expect(manager.listTasks().filter(task => task.kind === "return")).toHaveLength(1);
});

for (const restart of [false, true]) it(`parks old receipts after stopped source and unrelated continue (restart=${restart})`, async () => {
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "original goal");
  options.onEvent({method:"turn/started",params:{threadId:"native-1",turn:{id:"turn-1"}}});
  const sourceEvents=options;
  const task = await manager.createTask(source.id, "a", "independent helper", undefined, {policy:"resume"});
  await new Promise(resolve => setImmediate(resolve));
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  const helper = options;
  await manager.stop(source.id);
  await vi.waitFor(()=>expect(manager.listTasks().find(item => item.id === task.id)?.status).toBe("running"));
  helper.onEvent({ method: "item/agentMessage/delta", params: { threadId: "native-1", turnId: "turn-1", itemId: "answer", delta: "Saved helper result" } });
  helper.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === task.id)).toMatchObject({ status: "completed", result: "Saved helper result" });
  const receipt = manager.listTasks().find(task => task.kind === "return")!;
  if (restart) {
    manager.close(); store.close(); store = openStore(home);
    manager = createSessionManager(store, async () => structuredClone(config), factory);
    await new Promise(resolve => setImmediate(resolve));
  }
  await manager.continue(source.id, "unrelated question");
  await vi.waitFor(()=>expect(store.getConversation(source.id)?.turnId).toBeTruthy());
  (restart?options:sourceEvents).onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === receipt.id)?.status).toBe("queued");
  expect(turns.some(text => text.startsWith("系统任务回执"))).toBe(false);
  await expect(manager.send(source.id, "next user question")).resolves.toBeUndefined();
});

for (const restart of [false, true]) it(`exposes resumable dispatch waiting until source stops or runtime restarts (restart=${restart})`, async () => {
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "original goal");
  const sourceEvents = options;
  const task = await manager.createTask(source.id, "a", "independent helper");
  sourceEvents.onEvent({method:"turn/completed",params:{threadId:"native-1",turn:{id:"turn-1",status:"completed"}}});
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  expect(store.getConversation(source.id)?.status).toBe("idle");
  expect(manager.listTasks(undefined,true).find(item=>item.id===task.id)).toMatchObject({status:"running",autoResume:true});
  if (restart) {
    manager.close(); store.close(); store = openStore(home);
    manager = createSessionManager(store, async () => structuredClone(config), factory);
  } else await manager.stop(source.id);
  expect(manager.listTasks(undefined,true).find(item=>item.id===task.id)).toMatchObject({autoResume:false});
});

it("stopping one helper leaves other independent helpers running", async () => {
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "goal");
  const first = await manager.createTask(source.id, "a", "first helper");
  await new Promise(resolve => setImmediate(resolve));
  const second = await manager.createTask(source.id, "a", "second helper");
  await new Promise(resolve => setImmediate(resolve));
  await vi.waitFor(()=>expect(store.getConversation(first.targetConversationId)?.turnId).toBeTruthy());
  await vi.waitFor(()=>expect(store.getConversation(second.targetConversationId)?.turnId).toBeTruthy());
  await manager.stop(first.targetConversationId);
  expect(manager.listTasks().find(item => item.id === first.id)?.status).toBe("failed");
  expect(manager.listTasks().find(item => item.id === second.id&&item.targetConversationId===second.targetConversationId)?.status).toBe("running");
  expect(store.getConversation(source.id)?.status).toBe("running");
});

for (const restart of [false, true]) it(`parks an already queued receipt at ${restart ? "restart" : "source stop"}`, async () => {
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "original goal");
  options.onEvent({method:"turn/started",params:{threadId:"native-1",turn:{id:"turn-1"}}});
  const sourceEvents=options;
  const task = await manager.createTask(source.id, "a", "helper", undefined, {policy:"resume"});
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  const receipt = manager.listTasks().find(task => task.kind === "return")!;
  expect(manager.listTasks().find(item => item.id === receipt.id)).toMatchObject({ status: "queued", autoResume: true });
  if (restart) {
    manager.close(); store.close(); store = openStore(home);
    manager = createSessionManager(store, async () => structuredClone(config), factory);
    await new Promise(resolve => setImmediate(resolve));
  } else await manager.stop(source.id);
  expect(manager.listTasks().find(item => item.id === receipt.id)).toMatchObject({ status: "queued", autoResume: false });
  expect(manager.listTasks().find(item => item.id === task.id)?.status).toBe("completed");
  await manager.continue(source.id, "new question");
  if(restart){expect(manager.listUserInputs(source.id)).toMatchObject([{state:"queued",text:"new question"}]);expect(turns.some(text=>text.startsWith("系统任务回执"))).toBe(false);return;}
  await vi.waitFor(()=>expect(store.getConversation(source.id)?.turnId).toBeTruthy());
  (restart?options:sourceEvents).onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(turns.some(text => text.startsWith("系统任务回执"))).toBe(false);
  await expect(manager.send(source.id, "next question")).resolves.toBeUndefined();
});

for (const continueBeforeDispatch of [false, true]) it(`revokes pending dispatch across source stop (continue before publish=${continueBeforeDispatch})`, async () => {
  manager.close();
  let gateNextSelection = false;
  let release!: () => void;
  manager = createSessionManager(store, async () => {
    if (gateNextSelection) {
      gateNextSelection = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return structuredClone(config);
  }, factory);
  const source = await manager.create("p", "a", undefined, undefined, {workspaceId:null});
  await manager.send(source.id, "original goal");
  options.onEvent({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn-1" } } });
  gateNextSelection = true;
  const pendingDispatch = manager.createTask(source.id, "a", "helper for original goal", undefined, {policy:"resume"});
  await manager.stop(source.id);
  if (continueBeforeDispatch) await manager.continue(source.id, "unrelated question");
  const sourceEvents = options;
  release();
  const task = await pendingDispatch;
  await new Promise(resolve => setImmediate(resolve));
  await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
  const helperEvents = options;
  await vi.waitFor(()=>expect(manager.listTasks().find(item => item.id === task.id)?.status).toBe("running"));
  helperEvents.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === task.id)?.status).toBe("completed");
  const receipt = manager.listTasks().find(task => task.kind === "return")!;
  if (!continueBeforeDispatch) await manager.continue(source.id, "unrelated question");
  sourceEvents.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(manager.listTasks().find(item => item.id === receipt.id)).toMatchObject({ status: "queued", autoResume: false });
  expect(turns.some(text => text.startsWith("系统任务回执"))).toBe(false);
  await expect(manager.send(source.id, "next question")).resolves.toBeUndefined();
});

it('answers a native question by request id without adding a queued message', async () => {
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onApproval({id:42,method:'item/tool/requestUserInput',params:{threadId:'native-1',turnId:'turn-1',itemId:'question',isBlocking:true,questions:[{id:'choice',header:'Preview',question:'Where?',options:[{label:'In app',description:'Preview here'}]}]}});
 const approval=manager.getApprovals(chat.id)[0];
 await manager.answerQuestions(chat.id,approval.id,{choice:{answers:['In app']}});
 expect(replies).toEqual([{id:42,result:{answers:{choice:{answers:['In app']}}}}]);
 expect(manager.listUserInputs(chat.id)).toEqual([]);
 expect(manager.getApprovals(chat.id)).toEqual([]);
 expect(store.getConversation(chat.id)?.status).toBe('running');
 await expect(manager.answerQuestions(chat.id,approval.id,{choice:{answers:['Again']}})).rejects.toThrow();
});
it('rejects missing, foreign and expired question answers', async () => {
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onApproval({id:43,method:'item/tool/requestUserInput',params:{threadId:'native-1',turnId:'turn-1',itemId:'question',isBlocking:true,questions:[{id:'choice',header:'Preview',question:'Where?'}]}});
 const approval=manager.getApprovals(chat.id)[0];
 for(const answers of [{},{other:{answers:['x']}},{choice:{answers:['']}}])await expect(manager.answerQuestions(chat.id,approval.id,answers)).rejects.toThrow();
 const other=await manager.create('p','a');
 await expect(manager.answerQuestions(other.id,approval.id,{choice:{answers:['x']}})).rejects.toThrow();
 await manager.stop(chat.id);
 await expect(manager.answerQuestions(chat.id,approval.id,{choice:{answers:['x']}})).rejects.toThrow();
 expect(replies).toEqual([]);
});
it('interrupt and explicit continuation send the new draft ahead of existing queued messages', async () => {
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const queued=manager.enqueueUserInput(chat.id,'later','later');
 expect(await manager.stop(chat.id)).toBe(true);
 await manager.continue(chat.id,'urgent');
 expect(turns).toEqual(['first','urgent']);
 expect(manager.listUserInputs(chat.id)).toEqual([expect.objectContaining({id:queued.id,state:'queued'})]);
});
it('a stop timeout does not claim native termination is confirmed', async () => {
 vi.useFakeTimers();
 manager.close();manager=createSessionManager(store,async()=>structuredClone(config),async o=>({...await factory(o),interrupt:async()=>{}}));
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const stop=manager.stop(chat.id);await vi.advanceTimersByTimeAsync(3000);
 expect(await stop).toBe(false);expect(turns).toEqual(['first']);
});
it('keeps running when a blocking approval resolves but an asynchronous question remains', async () => {
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onApproval({id:51,method:'item/tool/requestUserInput',params:{threadId:'native-1',turnId:'turn-1',isBlocking:false,questions:[{id:'choice',header:'Preview',question:'Where?'}]}});
 expect(store.getConversation(chat.id)?.status).toBe('running');
 for(const nativeId of [52,53]) {
  options.onApproval({id:nativeId,method:'item/commandExecution/requestApproval',params:{threadId:'native-1',turnId:'turn-1',command:'echo fixture'}});
  expect(store.getConversation(chat.id)?.status).toBe('approval');
  if(nativeId===52)await manager.approve(chat.id,manager.getApprovals(chat.id).find(a=>a.nativeRequestId===52)!.id,'approve');
  else options.onEvent({method:'serverRequest/resolved',params:{threadId:'native-1',turnId:'turn-1',requestId:53}});
  expect(store.getConversation(chat.id)?.status).toBe('running');
 }
 expect(manager.getApprovals(chat.id)).toHaveLength(1);
});
it('routes question answers through same-origin and conversation-scoped HTTP', async () => {
 const {Readable}=await import('node:stream');const {createHttpServer}=await import('../server/http');
 const server=createHttpServer({requireIdentity:false,home,store,manager});
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onApproval({id:61,method:'item/tool/requestUserInput',params:{threadId:'native-1',turnId:'turn-1',isBlocking:true,questions:[{id:'choice',header:'Preview',question:'Where?'}]}});
 const approval=manager.getApprovals(chat.id)[0];
 const call=(id:string,origin='http://127.0.0.1')=>new Promise<number>(resolve=>{
  let status=0;server.emit('request',Object.assign(Readable.from([JSON.stringify({answers:{choice:{answers:['In app']}}})]),{url:`/api/conversations/${id}/questions/${approval.id}`,method:'POST',headers:{host:'127.0.0.1',origin,'content-type':'application/json'}}),{writeHead(code:number){status=code;},end(){resolve(status);}});
 });
 try {
  expect(await call(chat.id,'https://foreign.example')).toBe(403);
  expect(await call((await manager.create('p','a')).id)).toBe(409);
  expect(replies).toEqual([]);
  expect(await call(chat.id)).toBe(200);
  expect(replies).toEqual([{id:61,result:{answers:{choice:{answers:['In app']}}}}]);
  expect(store.listEvents(chat.id,0).some(e=>JSON.stringify(e.data).includes('In app'))).toBe(false);
 } finally {server.close();}
});

it('submits a durable async question answer whose id contains a colon over HTTP', async () => {
 const {Readable}=await import('node:stream');const {createHttpServer}=await import('../server/http');
 const server=createHttpServer({requireIdentity:false,home,store,manager});
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 const runId=(store.listEvents(chat.id,0).find(e=>e.kind==='metadata'&&(e.data as {execution?:string}).execution==='started')!.data as {runId:string}).runId;
 store.appendEvent(chat.id,'tool',{runId,method:'item/completed',params:{threadId:'native-1',turnId:'turn-1',item:{
  id:'q-async',type:'agentMessage',delivery:'async',questions:[{title:'你感觉主要慢在哪里？',options:['发消息后等很久','切换会话卡顿','输出慢']}],
 }}});
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 const approval=manager.getApprovals(chat.id).find(a=>a.id.startsWith('async:'))!;
 expect(approval.id).toContain(':');
 const custom='前两种都存在，发消息后，等很久才开始回复/切换会话、打开页面或点击操作卡顿';
 const call=(origin='http://127.0.0.1')=>new Promise<number>(resolve=>{
  let status=0;server.emit('request',Object.assign(Readable.from([JSON.stringify({answers:{0:{answers:[custom]}}})]),{url:`/api/conversations/${chat.id}/questions/${approval.id}`,method:'POST',headers:{host:'127.0.0.1',origin,'content-type':'application/json'}}),{writeHead(code:number){status=code;},end(){resolve(status);}});
 });
 try {
  expect(await call()).toBe(200);
  expect(manager.listUserInputs(chat.id).some(i=>i.text.includes(custom))).toBe(true);
  expect(store.listEvents(chat.id,0).some(e=>e.kind==='metadata'&&(e.data as {answeredQuestionId?:string}).answeredQuestionId===approval.id)).toBe(true);
 } finally {server.close();}
});

it('publishes removal of an asynchronously resolved question for UI refresh', async () => {
 const chat=await manager.create('p','a');await manager.send(chat.id,'ask');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 options.onApproval({id:71,method:'item/tool/requestUserInput',params:{threadId:'native-1',turnId:'turn-1',isBlocking:false,questions:[{id:'choice',header:'Preview',question:'Where?'}]}});
 const cursor=store.listEvents(chat.id,0).at(-1)!.id;
 options.onEvent({method:'serverRequest/resolved',params:{threadId:'native-1',turnId:'turn-1',requestId:71}});
 expect(manager.getApprovals(chat.id)).toEqual([]);
 expect(store.listEvents(chat.id,cursor).some(e=>e.kind==='metadata'&&(e.data as any).resolvedRequestId===71)).toBe(true);
 expect(store.getConversation(chat.id)?.status).toBe('running');
});


it("preserves a queued request when native resume reports an active writer", async () => {
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async o => ({
    ...await factory(o),
    resumeThread: async () => { throw new Error("thread native-1 already has an active writer"); },
  }));
  const chat = await manager.create("p", "a");
  store.updateConversation(chat.id, { nativeId: "native-1" });
  manager.enqueueUserInput(chat.id, "Keep this request for another conversation", "writer-conflict-request");
  await vi.waitFor(() => expect(store.getConversation(chat.id)?.status).toBe("error"));
  expect(turns).toEqual([]);
  const saved = store.listEvents(chat.id, 0).filter(event => event.kind === "user");
  expect(saved).toHaveLength(1);
  expect(saved[0].data).toMatchObject({ text: "Keep this request for another conversation" });
  manager.close(); store.close(); store = openStore(home);
  expect(store.listEvents(chat.id, 0).filter(event => event.kind === "user")).toEqual(saved);
});


it("exposes legacy requests that failed before a transcript or native invocation was recorded", async () => {
  manager.close();
  manager = createSessionManager(store, async () => structuredClone(config), async o => ({
    ...await factory(o), resumeThread: async () => { throw new Error("thread native-1 already has an active writer"); },
  }));
  const chat = await manager.create("p", "a");
  store.updateConversation(chat.id, { nativeId: "native-1" });
  const input = manager.enqueueUserInput(chat.id, "Legacy saved request", "legacy-request");
  await vi.waitFor(() => expect(store.getConversation(chat.id)?.status).toBe("error"));
  expect(manager.listUserInputs(chat.id)[0].unrecorded).toBeUndefined();
  store.database.prepare("DELETE FROM events WHERE conversationId=? AND kind='user'").run(chat.id);
  expect(manager.listUserInputs(chat.id)).toMatchObject([{ id: input.id, text: "Legacy saved request", unrecorded: true }]);
  expect(turns).toEqual([]);
});

it("waits for a cancelled preparation's native writer to close before confirming stop", async () => {
  manager.close();
  let releaseClose!: () => void, releaseResume!: () => void, entered!: () => void;
  const closing = new Promise<void>(resolve => { releaseClose = resolve; });
  const resuming = new Promise<void>(resolve => { releaseResume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  manager = createSessionManager(store, async () => structuredClone(config), async o => ({
    ...await factory(o), resumeThread: async () => { entered(); await resuming; }, close: () => closing,
  }));
  const chat = await manager.create("p", "a");
  await manager.send(chat.id, "first");
  options.onEvent({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn-1", status: "completed" } } });
  const pending = manager.send(chat.id, "next");
  await started;
  let stopped = false;
  const stop = manager.stop(chat.id).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  const stoppedBeforeClose = stopped;
  releaseClose(); releaseResume();
  await Promise.all([stop, pending]);
  expect(stoppedBeforeClose).toBe(false);
});


it('excludes saved but unsubmitted requests from native fork verification', async () => {
  manager.close();
  let rejectResume = false;
  const forks: { texts: string[]; index: number }[] = [];
  manager = createSessionManager(store, async () => structuredClone(config), async o => ({
    ...await factory(o), resumeThread: async () => { if (rejectResume) throw new Error('thread native-1 already has an active writer'); },
    forkThread: async (_id, texts, index) => { forks.push({ texts, index }); return 'forked'; },
  }));
  const chat = await manager.create('p', 'a');
  await manager.send(chat.id, 'first');
  options.onEvent({ method: 'turn/completed', params: { threadId: 'native-1', turn: { id: 'turn-1', status: 'completed' } } });
  rejectResume = true;
  await expect(manager.send(chat.id, 'not submitted')).rejects.toThrow('active writer');
  rejectResume = false;
  await manager.continue(chat.id, 'third');
  options.onEvent({ method: 'turn/completed', params: { threadId: 'native-1', turn: { id: 'turn-1', status: 'completed' } } });
  const user = store.listEvents(chat.id, 0).filter(event => event.kind === 'user')[1];
  await manager.branch(chat.id, user.id, 'revised');
  expect(forks).toEqual([{ texts: ['first', 'third'], index: 1 }]);
});
it('ordinary configured Agent publishes declared output and reads pinned inputs with captured invocation identity',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 const {createAssetFiles}=await import('../server/asset-files'),{createAssets}=await import('../server/assets');
 const files=createAssetFiles(home),assets=createAssets(store,files),user=(await import('../server/workspace-identity')).workspacePrincipal(store);
 writeFileSync(join(home,'source.txt'),'pinned input');const staged=await files.stageFiles(user,null,[{allowedRoot:home,relativePath:'source.txt',manifestPath:'source.txt'}]);
 const source=assets.importAsset(user,{kind:'file',title:'Input',submissionId:staged.submissionId},'input');assets.setAccess(user,source.asset.id,{mode:'selected',projectIds:['p']},source.asset.revision);assets.bind(user,{ownerType:'project',ownerId:'p',assetId:source.asset.id,versionPolicy:'pinned',versionId:source.version.id});
 const c=await manager.create('p','a');await manager.send(c.id,'Write a file');
 const invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(c.id)!.invocation_id as string;
 const binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',c.id,invocation,'result.txt'),'output');
 const read=await manager.callBoundTool(binding.token,'artifact_read',{assetId:source.asset.id,versionId:source.version.id,fileId:'0'},'read');expect(read).toMatchObject({text:'pinned input'});
 const result=await manager.callBoundTool(binding.token,'artifact_publish',{title:'Output',files:[{path:'result.txt'}]},'publish') as any;expect(result.version.provenance).toMatchObject({runId:invocation,sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}]});
 expect(assets.listBindings(user,'project','p').map(b=>b.assetId)).toContain(result.asset.id);expect(assets.getAuthorizedAsset(user,result.asset.id).accessPolicy).toEqual({mode:'owner'});
 await manager.stop(c.id);await expect(manager.callBoundTool(binding.token,'artifact_publish',{title:'Late',files:[{path:'result.txt'}]},'late')).rejects.toThrow();
});
it('preserves accepted attachment request before import failure and never trusts supplied path or filename',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 const {saveAttachment,loadAttachments}=await import('../server/attachments');
 const c=await manager.create('p','a'),uploaded=await saveAttachment(home,c.id,'input.txt',Buffer.from('input'));
 const [attachment]=await loadAttachments(home,c.id,[uploaded.id]);
 await manager.send(c.id,'Accepted first',[{...attachment,name:'forged.txt',path:'/etc/passwd'}]);
 const assets=(await import('../server/assets')).createAssets(store,(await import('../server/asset-files')).createAssetFiles(home));
 expect(assets.listAssets((await import('../server/workspace-identity')).workspacePrincipal(store))).toMatchObject([{title:'input.txt',owner:{agentId:'a'}}]);
 await manager.stop(c.id);
 const missing=await saveAttachment(home,c.id,'missing.txt',Buffer.from('bytes'));const [native]=await loadAttachments(home,c.id,[missing.id]);rmSync(native.path);
 await expect(manager.continue(c.id,'Keep this prompt',[native])).rejects.toThrow();
 expect(store.listEvents(c.id,0).filter(e=>e.kind==='user').map(e=>(e.data as any).text)).toEqual(['Accepted first','Keep this prompt']);
 expect(store.listEvents(c.id,0).some(e=>e.kind==='error')).toBe(true);
 expect(store.database.prepare('SELECT state FROM attachment_asset_links WHERE attachment_id=?').get(missing.id)!.state).toBe('pending');
});
it('ordinary file tools reject removed membership and unconfigured chat cannot manufacture an Agent publisher',async()=>{
 await manager.close();const scoped=structuredClone(config);manager=createSessionManager(store,async()=>structuredClone(scoped),factory,undefined,home);
 const c=await manager.create('p','a');await manager.send(c.id,'write');const row=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(c.id)!;const invocation=row.invocation_id as string;
 const binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',c.id,invocation,'a.txt'),'body');scoped.projects[0].agentIds=[];
 await expect(manager.callBoundTool(binding.token,'artifact_publish',{title:'Denied',files:[{path:'a.txt'}]},'revoked')).rejects.toMatchObject({code:'forbidden'});
 expect(store.database.prepare('SELECT id FROM assets').all()).toHaveLength(0);await manager.stop(c.id);
 const personal=await manager.create('','',undefined,'codex',{cwd:home});await manager.send(personal.id,'personal');expect(store.database.prepare('SELECT * FROM file_execution_scopes WHERE conversation_id=?').get(personal.id)).toBeUndefined();
});
it('branch reuses submitted attachment identity and original bytes without importing a missing branch upload',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),async o=>({...await factory(o),forkThread:async()=> 'native-branch'}),undefined,home);
 const {saveAttachment,loadAttachments}=await import('../server/attachments');const c=await manager.create('p','a');const item=await saveAttachment(home,c.id,'source.txt',Buffer.from('source input'));const attachments=await loadAttachments(home,c.id,[item.id]);
 await manager.send(c.id,'original',attachments);options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 const user=store.listEvents(c.id,0).find(e=>e.kind==='user')!;const branch=await manager.branch(c.id,user.id,'revised');
 expect(store.getConversation(branch.id)).toMatchObject({status:'running',nativeId:'native-branch',turnId:'turn-1'});expect((store.listEvents(branch.id,0).find(e=>e.kind==='user')!.data as any).text).toBe('revised');expect((store.listEvents(c.id,0).find(e=>e.kind==='user')!.data as any).text).toBe('original');expect(store.listEvents(branch.id,0).filter(e=>e.kind==='error')).toHaveLength(0);
 expect(store.database.prepare('SELECT id FROM assets').all()).toHaveLength(1);expect(store.database.prepare('SELECT conversation_id FROM attachment_asset_links').all()).toEqual([{conversation_id:c.id}]);
 expect(turns.at(-1)).toContain(attachments[0].path);
});
it('ordinary publisher includes lazily imported historical private attachment lineage and blocks unresolved history',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 const {saveAttachment}=await import('../server/attachments'),{createAssetFiles}=await import('../server/asset-files'),{createAssets}=await import('../server/assets'),{createAttachmentAssets}=await import('../server/attachment-assets');
 const c=await manager.create('p','a'),item=await saveAttachment(home,c.id,'old.txt',Buffer.from('private history'));store.appendEvent(c.id,'user',{text:'historical input',attachments:[item]});
 const service=createAttachmentAssets(home,store,createAssetFiles(home),createAssets(store,createAssetFiles(home))),root=(await import('../server/workspace-identity')).workspacePrincipal(store);await service.reconcileSubmitted(root,()=>{});
 await manager.send(c.id,'publish');let invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(c.id)!.invocation_id as string;let binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',c.id,invocation,'a.txt'),'potential private derivative');
 await expect(manager.callBoundTool(binding.token,'artifact_publish',{title:'Denied',files:[{path:'a.txt'}]},'private-history')).rejects.toMatchObject({code:'attachment_source_forbidden',message:expect.stringContaining('Grant this Agent access')});options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 const missing=await saveAttachment(home,c.id,'missing.txt',Buffer.from('gone'));store.appendEvent(c.id,'user',{text:'accepted missing input',attachments:[missing]});rmSync(join(home,'attachments',c.id,missing.id,'files',missing.name));
 await manager.send(c.id,'new turn');expect(store.getConversation(c.id)!.status).toBe('running');invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=? ORDER BY rowid DESC').get(c.id)!.invocation_id as string;binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',c.id,invocation,'a.txt'),'body');
 await expect(manager.callBoundTool(binding.token,'artifact_publish',{title:'Blocked',files:[{path:'a.txt'}]},'incomplete-history')).rejects.toMatchObject({code:'attachment_lineage_pending'});
});
it('unavailable historical attachment origin keeps a normal chat running but blocks publication with recovery guidance',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);const {saveAttachment}=await import('../server/attachments');
 const source=await manager.create('p','a'),attachment=await saveAttachment(home,source.id,'old.txt',Buffer.from('history'));const event=store.appendEvent(source.id,'user',{text:'old request',attachments:[attachment]});
 const branch=store.createConversation({projectId:'p',agentId:'a',cli:'codex',model:null,branchedFrom:{conversationId:source.id,eventId:event.id}});store.appendEvent(branch.id,'user',event.data);store.database.prepare('DELETE FROM conversations WHERE id=?').run(source.id);
 await manager.send(branch.id,'Continue normal chat');expect(store.getConversation(branch.id)!.status).toBe('running');expect((store.listEvents(branch.id,0).filter(e=>e.kind==='user').at(-1)!.data as any).text).toBe('Continue normal chat');
 const invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(branch.id)!.invocation_id as string,binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',branch.id,invocation,'a.txt'),'body');
 await expect(manager.callBoundTool(binding.token,'artifact_publish',{title:'Blocked',files:[{path:'a.txt'}]},'missing-origin')).rejects.toMatchObject({code:'attachment_lineage_pending',message:expect.stringContaining('Recover submitted attachments')});
});
it('ordinary bound assets update honors enabled file policy and preserves actual invocation identity',async()=>{
 await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 const {createAssetFiles}=await import('../server/asset-files'),{createAssets}=await import('../server/assets');
 const files=createAssetFiles(home),assets=createAssets(store,files),user=(await import('../server/workspace-identity')).workspacePrincipal(store);
 writeFileSync(join(home,'maintained'),'计划：待验证');const stage=await files.stageFiles(user,null,[{allowedRoot:home,relativePath:'maintained',manifestPath:'notes/roadmap.md'}]);const imported=assets.importAsset(user,{kind:'file',title:'Maintained',submissionId:stage.submissionId},'maintained');
 await manager.fileMaintenance.configure(user,imported.asset.id,{enabled:true,agentId:'a',projectId:'p',expectedRevision:0});
 const c=await manager.create('p','a');await manager.send(c.id,'Update maintained file');const invocation=store.database.prepare('SELECT invocation_id FROM file_execution_scopes WHERE conversation_id=?').get(c.id)!.invocation_id as string;
 const binding=JSON.parse(readFileSync(join(home,'runtime','cli',invocation,'context.json'),'utf8'));writeFileSync(join(home,'outputs','conversations',c.id,invocation,'updated.md'),'计划：交互更新');
 const args={assetId:imported.asset.id,expectedHeadVersionId:imported.version.id,path:'updated.md'};const result=await manager.callBoundTool(binding.token,'artifact_update',args,'update') as any;
 expect(result.version.provenance.runId).toBe(invocation);expect(result.version.files[0].path).toBe('notes/roadmap.md');expect((await manager.callBoundTool(binding.token,'artifact_update',args,'update') as any).version.id).toBe(result.version.id);
 await manager.stop(c.id);await expect(manager.callBoundTool(binding.token,'artifact_update',args,'late')).rejects.toThrow();
});

it('uses effective defaults for actual execution, changed next sends and matching probes', async () => {
 manager.close(); const scoped=structuredClone(config);
 scoped.runtimeDefaults={codex:{args:['--strict-config'],env:{SERVICE:'${DEFAULT_SOURCE}',SHARED:'${DEFAULT_SOURCE}'},fullAccess:false,approvalMode:'auto'}};
 scoped.agents[0].runtime={codex:{env:{SHARED:'${AGENT_SOURCE}'}}};
 vi.stubEnv('DEFAULT_SOURCE','default-test-value');vi.stubEnv('AGENT_SOURCE','agent-test-value');
 const approvals: unknown[]=[]; const launches:CodexOptions[]=[];
 manager=createSessionManager(store,async()=>scoped,async(o)=>{launches.push(o);const client=await factory(o);return {...client,startTurn:async(...args)=>{approvals.push(args[2]);return client.startTurn(...args);}};});
 const chat=await manager.create('p','a');await manager.send(chat.id,'default run');
 expect(options).toMatchObject({extraArgs:['--strict-config'],env:{SERVICE:'default-test-value',SHARED:'agent-test-value'},fullAccess:false});
 expect(approvals).toEqual(['auto']);
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 scoped.agents[0].runtime.codex={args:[],approvalMode:'default',fullAccess:true};
 await manager.send(chat.id,'Agent override');
 expect(launches).toHaveLength(2);expect(options.extraArgs).toEqual([]);expect(options.fullAccess).toBe(true);expect(approvals).toEqual(['auto','default']);
 await manager.listModels(undefined,'codex',{agentId:'a'});expect(options.extraArgs).toEqual([]);
 await manager.getCliStatus(undefined,'codex');expect(options.extraArgs).toEqual(['--strict-config']);
 await manager.listModels(undefined,'codex',undefined,'system');expect(options.env).toEqual({SERVICE:'default-test-value',SHARED:'default-test-value'});expect(options).not.toHaveProperty('fullAccess');expect(options).not.toHaveProperty('extraArgs');
});
it('restricted OMP model/status probes inherit credential routing and exclude interactive execution defaults',async()=>{
 manager.close();const scoped=structuredClone(config);scoped.runtimeDefaults={omp:{args:['--skills','interactive'],env:{SERVICE:'${OMP_SYSTEM_SOURCE}'}}};
 vi.stubEnv('OMP_SYSTEM_SOURCE','synthetic-auth-route');
 manager=createSessionManager(store,async()=>scoped,factory,async o=>factory(o));
 await manager.listModels(undefined,'omp',undefined,'system');expect(options.extraArgs).toEqual(['--no-tools']);expect(options.env).toEqual({SERVICE:'synthetic-auth-route'});
 expect(await manager.getCliStatus(undefined,'omp',undefined,'system')).toMatchObject({status:'ready'});expect(options.extraArgs).toEqual(['--no-tools']);
});

it('keeps queued input directory claims stable when configured Agent output is prepared',async()=>{
 await manager.close();const scoped=structuredClone(config);scoped.projects[0].cwd=home;
 let declaredRoots:string[]=[];
 manager=createSessionManager(store,async()=>scoped,async o=>({...await factory(o),startThread:async params=>{declaredRoots=params.runtimeWorkspaceRoots??[];return 'native-1';}}),undefined,home);
 const chat=await manager.create('p','a');
 const input=manager.enqueueUserInput(chat.id,'first queued request','first-queued');
 await expect.poll(()=>turns).toEqual(['first queued request']);
 const held=store.database.prepare("SELECT paths FROM task_directory_claims WHERE kind='input' AND owner_id=?").get(input.id)!;
 expect(JSON.parse(held.paths as string)).toEqual([home,join(home,'outputs','conversations',chat.id)].map(path=>realpathSync(path)).sort());
 const invocation=(store.listEvents(chat.id,0).find(e=>e.kind==='user')!.data as {runId:string}).runId;
 expect(declaredRoots).toContain(join(home,'outputs','conversations',chat.id,invocation));
 expect(declaredRoots).not.toContain(join(home,'outputs','conversations',chat.id));
 const later=manager.enqueueUserInput(chat.id,'queued while busy','second-queued');expect(manager.listUserInputs(chat.id).find(i=>i.id===later.id)?.state).toBe('queued');
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 await expect.poll(()=>turns).toEqual(['first queued request','queued while busy']);
 expect(store.listEvents(chat.id,0).filter(e=>e.kind==='error')).toEqual([]);
});

it('passes OMP workspace defaults and effective approval into the actual native launcher',async()=>{
 await manager.close();const scoped=structuredClone(config);scoped.agents[0].defaultCli='omp';
 scoped.runtimeDefaults={omp:{args:['--thinking','high'],env:{SERVICE:'${OMP_DEFAULT_SOURCE}'},approvalMode:'auto'}};
 vi.stubEnv('OMP_DEFAULT_SOURCE','synthetic-omp-default');let launched:OmpOptions|undefined;
 manager=createSessionManager(store,async()=>scoped,factory,async o=>{launched=o;return factory(o);});
 try {
  const chat=await manager.create('p','a');await manager.send(chat.id,'OMP defaults');
  expect(launched).toMatchObject({extraArgs:['--thinking','high'],env:{SERVICE:'synthetic-omp-default'},approvalMode:'auto'});
  await manager.listModels(undefined,'omp',{agentId:'a'});expect(launched?.extraArgs).toEqual(['--thinking','high']);expect(launched?.env).toEqual({SERVICE:'synthetic-omp-default'});
 }finally{vi.unstubAllEnvs();}
});

it('close waits for an in-flight queue pump before callers remove its HOME',async()=>{
 await manager.close();let blocked=false,entered=false,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 manager=createSessionManager(store,async()=>{if(blocked){entered=true;await gate;}return structuredClone(config);},factory,undefined,home);
 const chat=await manager.create('p','a');blocked=true;manager.enqueueUserInput(chat.id,'waiting on config','close-pump');
 await expect.poll(()=>entered).toBe(true);
 let closed=false;const closing=manager.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,20));expect(closed).toBe(false);
 release();await closing;expect(turns).toEqual([]);expect(existsSync(join(home,'outputs','conversations',chat.id))).toBe(false);
});

it('requeues a keyed continuation with its original identity behind a delegated directory owner',async()=>{
 const {createTaskResources}=await import('../server/task-resources');
 const resources=createTaskResources(store);
 resources.claimDirectory('held-delegated-run','/tmp','write');
 const second=await manager.create('p','a');
 store.updateConversation(second.id,{status:'interrupted'});
 await manager.continue(second.id,'resume after owner finishes',[],[],'continue-contention');
 expect(manager.listUserInputs(second.id)).toMatchObject([{commandKey:'continue-contention',state:'queued'}]);
 expect(manager.listUserInputs(second.id)).toHaveLength(1);
 resources.releaseUnsubmitted('run','held-delegated-run');
 manager.enqueueUserInput(second.id,'later input','later-key');
 await expect.poll(()=>turns).toEqual(['resume after owner finishes']);
 expect(manager.listUserInputs(second.id).filter(input=>input.commandKey==='continue-contention')).toHaveLength(1);
});

it('persists a keyed continuation for receipt readback and deduplicates an accepted command',async()=>{
 const chat=await manager.create('p','a');
 store.updateConversation(chat.id,{status:'interrupted'});
 await manager.continue(chat.id,'resume once',[],[],'resume-key');
 expect(manager.listUserInputs(chat.id)).toMatchObject([{commandKey:'resume-key',state:'running'}]);
 await manager.continue(chat.id,'resume once',[],[],'resume-key');
 expect(turns).toEqual(['resume once']);
 expect(manager.listUserInputs(chat.id)).toHaveLength(1);
});

it('starts an existing queued user input ahead of older inputs without duplicating acceptance',async()=>{
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const older=manager.enqueueUserInput(chat.id,'older','older'),priority=manager.enqueueUserInput(chat.id,'priority','priority');
 await manager.sendQueuedInput(chat.id,priority.id,manager.executionId(chat.id));expect(turns).toEqual(['first','priority']);expect(manager.listUserInputs(chat.id)).toMatchObject([{id:older.id,state:'queued'},{id:priority.id,state:'running'}]);
 await manager.sendQueuedInput(chat.id,priority.id);expect(turns).toEqual(['first','priority']);
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});await manager.stop(chat.id);await manager.continue(chat.id,'new work');
 await manager.sendQueuedInput(chat.id,priority.id);expect(turns).toEqual(['first','priority','new work']);expect(store.getConversation(chat.id)?.status).toBe('running');
});
it('resumes the next human queued input only when the composer explicitly requests it',async()=>{
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const next=manager.enqueueUserInput(chat.id,'next','next');expect(await manager.stop(chat.id,manager.executionId(chat.id),true)).toBe(true);expect(turns).toEqual(['first','next']);expect(manager.listUserInputs(chat.id)).toMatchObject([{id:next.id,state:'running'}]);
});
it('rejects stale queued-send controls and cancelled inputs without stopping current work',async()=>{
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');const input=manager.enqueueUserInput(chat.id,'queued','key');
 await expect(manager.sendQueuedInput(chat.id,input.id,'old-execution')).rejects.toMatchObject({code:'execution_changed'});expect(turns).toEqual(['first']);expect(store.getConversation(chat.id)?.status).toBe('running');
 manager.cancelUserInput(input.id);await expect(manager.sendQueuedInput(chat.id,input.id)).rejects.toMatchObject({code:'input_not_queued'});expect(turns).toEqual(['first']);
});
it('keeps queued messages paused when stopping has no native terminal proof',async()=>{
 vi.useFakeTimers();await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),async o=>({...await factory(o),interrupt:async()=>{}}));
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const next=manager.enqueueUserInput(chat.id,'next','next');const stopped=manager.stop(chat.id,manager.executionId(chat.id),true);await vi.advanceTimersByTimeAsync(3000);expect(await stopped).toBe(false);expect(turns).toEqual(['first']);expect(manager.listUserInputs(chat.id)).toMatchObject([{id:next.id,state:'queued'}]);
 await expect(manager.sendQueuedInput(chat.id,next.id)).rejects.toMatchObject({code:'stop_unconfirmed'});
});
it('sends the original queued attachment without accepting another message',async()=>{
 const {saveAttachment}=await import('../server/attachments');await manager.close();manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 const chat=await manager.create('p','a');await manager.send(chat.id,'first');options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const file=await saveAttachment(home,chat.id,'note.txt',Buffer.from('Queued attachment evidence'));const input=manager.enqueueUserInput(chat.id,'read this','attachment-key',[file.id]);
 await manager.sendQueuedInput(chat.id,input.id,manager.executionId(chat.id));expect(manager.listUserInputs(chat.id)).toMatchObject([{id:input.id,attachments:[file.id],state:'running'}]);expect(store.listEvents(chat.id,0).filter(e=>e.kind==='user'&&(e.data as {queuedInputId?:string}).queuedInputId===input.id)).toHaveLength(1);
});
for(const cli of ['codex','omp'] as const)it(`stops then sends a queued question through ${cli} without stale output entering the new reply`,async()=>{
 await manager.close();const callbacks:CodexOptions[]=[];let turn=0;const create=async(o:CodexOptions)=>{callbacks.push(o);const client=await factory(o);return {...client,startTurn:async(...args:Parameters<CodexClient['startTurn']>)=>{await client.startTurn(...args);return 'turn-'+(++turn);}};};manager=createSessionManager(store,async()=>structuredClone(config),create,create,home);
 const chat=await manager.create('p','a',undefined,cli);await manager.send(chat.id,'first');callbacks[0].onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});const next=manager.enqueueUserInput(chat.id,'next','queue-'+cli);
 await manager.sendQueuedInput(chat.id,next.id,manager.executionId(chat.id));expect(turns).toEqual(['first','next']);
 callbacks[0].onEvent({method:'item/agentMessage/delta',params:{threadId:'native-1',turnId:'turn-1',itemId:'late',delta:'Stale stopped reply'}});expect(JSON.stringify(store.listEvents(chat.id,0))).not.toContain('Stale stopped reply');
});

it('queues a concurrent continuation behind the explicitly selected input without losing or duplicating either',async()=>{
 await manager.close();
 let release!:()=>void,preparing!:()=>void,other:Promise<void>|undefined,conversationId='';
 const gate=new Promise<void>(resolve=>{release=resolve;}),resuming=new Promise<void>(resolve=>{preparing=resolve;});
 manager=createSessionManager(store,async()=>structuredClone(config),async o=>{
  const client=await factory(o);
  return {...client,resumeThread:async()=>{preparing();await gate;},
   startTurn:async(...args)=>{await client.startTurn(...args);return 'turn-'+turns.length;},
   interrupt:async(...args)=>{await client.interrupt(...args);other=manager.continue(conversationId,'Concurrent new request');}};
 },undefined,home);
 const chat=await manager.create('p','a');conversationId=chat.id;await manager.send(chat.id,'Original');
 options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const selected=manager.enqueueUserInput(chat.id,'Selected queued request','race-key');
 const sending=manager.sendQueuedInput(chat.id,selected.id,manager.executionId(chat.id));
 // Observe preparation independently: awaiting the send before releasing this gate deadlocks the test.
 try{
  await Promise.race([resuming,sending]);await other;
  expect(turns).toEqual(['Original']);
  expect(manager.listUserInputs(chat.id)).toMatchObject([
   {id:selected.id,text:'Selected queued request',state:'running'},
   {text:'Concurrent new request',state:'queued'},
  ]);
 }finally{release();await sending;}
 expect(turns).toEqual(['Original','Selected queued request']);
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-2',status:'completed'}}});
 await expect.poll(()=>turns).toEqual(['Original','Selected queued request','Concurrent new request']);
 expect(manager.listUserInputs(chat.id)).toMatchObject([{id:selected.id,state:'completed'},{text:'Concurrent new request',state:'running'}]);
 const accepted=store.listEvents(chat.id,0).filter(event=>event.kind==='user').map(event=>(event.data as {text:string}).text);
 expect(accepted).toEqual(['Original','Selected queued request','Concurrent new request']);
});

it('preserves a concurrently accepted preparation during composer stop',async()=>{
 await manager.close();let release!:()=>void,other:Promise<void>|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});let conversationId='';
 manager=createSessionManager(store,async()=>structuredClone(config),async o=>{const client=await factory(o);return {...client,resumeThread:async()=>{await gate;},interrupt:async(...args)=>{void client.interrupt(...args);other=manager.continue(conversationId,'Concurrent new request');}};},undefined,home);
 const chat=await manager.create('p','a');conversationId=chat.id;await manager.send(chat.id,'Original');options.onEvent({method:'turn/started',params:{threadId:'native-1',turn:{id:'turn-1'}}});
 const queued=manager.enqueueUserInput(chat.id,'Selected queued request','race-key'),original=manager.executionId(chat.id);
 try {
  await expect(manager.stop(chat.id,original,true)).rejects.toMatchObject({code:'execution_changed'});
  expect(manager.listUserInputs(chat.id)).toMatchObject([{id:queued.id,state:'queued'}]);expect(manager.listUserInputs(chat.id)[0].unrecorded).not.toBe(true);
  expect(manager.executionId(chat.id)).not.toBe(original);
 }finally{release();await other;}
 expect(turns).toEqual(['Original','Concurrent new request']);expect(store.getConversation(chat.id)?.status).toBe('running');
});

it('recovers the original coordinator context after restart without adopting a delegate prompt',async()=>{
 const source=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(source.id,'Original coordinator objective');
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 const dispatch=await manager.createTask(source.id,'a','Delegate-only investigation');
 await vi.waitFor(()=>expect(store.getConversation(dispatch.targetConversationId)?.turnId).toBeTruthy());
 store.updateConversation(source.id,{status:'running'});
 options.onEvent({method:'item/agentMessage/delta',params:{threadId:'native-1',turnId:'turn-1',itemId:'answer',delta:'Worker evidence'}});
 options.onEvent({method:'turn/completed',params:{threadId:'native-1',turn:{id:'turn-1',status:'completed'}}});
 await manager.close();store.updateConversation(source.id,{status:'idle',turnId:null});
 manager=createSessionManager(store,async()=>structuredClone(config),factory);
 await manager.reconcileRuns('local');
 await vi.waitFor(()=>expect(manager.taskService.listRunControls({userId:store.ownerUserId},dispatch.id).some(run=>run.routing?.executionConversationId===source.id)).toBe(true));
 const coordinator=manager.taskService.listRunControls({userId:store.ownerUserId},dispatch.id).find(run=>run.routing?.executionConversationId===source.id)!;
 expect(manager.taskService.getContextSnapshot({userId:store.ownerUserId},coordinator.id)?.input).toMatch(/^Original coordinator objective/);
 expect(manager.taskService.getContextSnapshot({userId:store.ownerUserId},coordinator.id)?.requiredOutputAssetIds).toEqual([]);
});
