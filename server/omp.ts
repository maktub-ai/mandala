import { skillResources } from "../shared/skills";
import { spawn } from "./native-spawn";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CodexClient, CodexOptions } from "./codex";
import type { McpServer, Skill, ApprovalMode } from "../shared/types";
import { runtimeError } from "./runtime";
import { createRpcClient } from "./rpc";

export async function prepareCapabilityRuntime(home: string, conversationId: string,
  mcp: McpServer[], skills: Skill[], instructions = "", validateHandoff?: () => void | Promise<void>): Promise<string> {
  const root = join(home, "runtime", conversationId);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "skills"), { recursive: true, mode: 0o700 });
  if (instructions) { await validateHandoff?.(); await writeFile(join(root, "instructions.md"), instructions, { mode: 0o600 }); }
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "mandala-runtime",
  }), { mode: 0o600 });
  if (mcp.length) {
    for (const server of mcp)
      for (const reference of Object.values(server.env ?? {})) {
        const name = reference.slice(2, -1);
        if (process.env[name] === undefined) throw new Error(`Missing environment variable: ${name}`);
      }
    const wrapper = join(root, "mcp-stdio.mjs");
    await writeFile(wrapper, `${process.platform === "win32" ? `import spawn from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("cross-spawn")).href)};` : 'import { spawn } from "node:child_process";'}\nconst [command, argsText, refsText] = process.argv.slice(2);\nconst refs = JSON.parse(refsText);\nconst env = { ...process.env };\nfor (const [key, ref] of Object.entries(refs)) {\n  const name = ref.slice(2, -1);\n  if (process.env[name] === undefined) { console.error("Missing environment variable: " + name); process.exit(1); }\n  env[key] = process.env[name];\n}\nconst child = spawn(command, JSON.parse(argsText), { env, stdio: "inherit", shell: false });\nchild.on("exit", (code) => process.exit(code ?? 1));\nchild.on("error", (error) => { console.error(error.message); process.exit(1); });\nprocess.on("SIGTERM", () => child.kill("SIGTERM"));\n`, { mode: 0o600 });
    const servers = Object.fromEntries(mcp.map((m) => [m.name,
      m.transport === "stdio"
        ? { type: "stdio", command: "node",
            args: [wrapper, m.command, JSON.stringify(m.args ?? []), JSON.stringify(m.env ?? {})] }
        : { url: m.url, type: "streamable-http" },
    ]));
    await writeFile(join(root, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: servers,
    }), { mode: 0o600 });
  }
  for (const skill of skills) {
    const directory = join(root, "skills", skill.name);
    if (skill.content !== undefined) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "SKILL.md"), skill.content, { mode: 0o600 });
      for(const file of skill[skillResources]??[]){
        await validateHandoff?.();const target=join(directory,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await cp(file.blobPath,target);if(file.executable)await (await import('node:fs/promises')).chmod(target,0o700);
      }
    } else await cp(skill.path, directory, { recursive: true, dereference: true });
  }
  return root;
}

export type OmpOptions = CodexOptions & {
  validateHandoff?: () => void | Promise<void>;
  resume?: string;
  instructions?: string;
  model?: string;
  directories?: string[];
  pluginDir?: string;
  ephemeral?: boolean;
  approvalMode?: ApprovalMode;
};

export async function startOmp(options: OmpOptions): Promise<CodexClient> {
  const args = ["--mode=rpc", `--cwd=${options.cwd}`, `--approval-mode=${options.approvalMode === "auto" ? "yolo" : options.approvalMode === "strict" ? "always-ask" : "write"}`];
  if (options.ephemeral) args.push("--no-session");
  if (options.resume) args.push(`--resume=${options.resume}`);
  if (options.instructions) args.push(`--append-system-prompt=${options.instructions}`);
  if (options.model) args.push(`--model=${options.model}`);
  for (const dir of options.directories ?? []) args.push(`--add-dir=${dir}`);
  if (options.pluginDir) args.push("--plugin-dir", options.pluginDir);
  args.push(...(options.extraArgs ?? []));
  await options.validateHandoff?.();
  const child = spawn("omp", args, { cwd: options.cwd, stdio: "pipe", shell: false,
    signal: options.signal, env: { ...process.env, ...options.env } });
  const stopped = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
  child.stderr.resume();
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const uiRequests = new Map<string, "confirm" | "select">();
  const toolOutput = new Map<string, string>();
  let sessionId = options.resume ?? "";
  let turnId = "";
  let messageSequence = 0;
  let messageId = "";
  const messageBlocks = new Set<number>();
  const phaseOf = (content: any) => {
    try {
      const signature = JSON.parse(content?.textSignature ?? "null");
      return ["commentary", "final_answer"].includes(signature?.phase) ? signature.phase : undefined;
    } catch { return undefined; }
  };
  const emitItem = (method: string, item: Record<string, unknown>) => options.onEvent({ method,
    params: { threadId: sessionId, turnId, item } });
  const beginMessage = (message: any) => {
    messageId = `${turnId}:message:${++messageSequence}`;
    messageBlocks.clear();
    emitItem("item/started", { id: messageId, type: "modelCall", model: message?.model, status: "inProgress" });
  };
  let interrupted = false;
  let closed = false;
  let exited = false;
  const terminate = () => {
    child.kill("SIGTERM");
    if (!exited) {
      const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2000);
      timer.unref();
    }
  };
  options.signal?.addEventListener("abort", terminate, { once: true });
  let ready!: () => void, failReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
  const startupTimer = setTimeout(() => { terminate(); failReady(new Error("OMP startup timed out")); }, 15000);
  let started = false;
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = async (type: string, values: Record<string, unknown> = {}) => {
    await readyPromise;
    if (closed || exited) throw new Error("OMP exited");
    const id = randomUUID();
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`OMP ${type} timed out`)); }, 30000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    send({ id, type, ...values });
    return response;
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "ready") { started = true; clearTimeout(startupTimer); ready(); return; }
    if (event.type === "response" && event.id) {
      const waiter = pending.get(event.id);
      pending.delete(event.id);
      if (event.success) waiter?.resolve(event.data);
      else waiter?.reject(new Error(event.error || "OMP request failed"));
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "confirm" || event.method === "select" &&
          Array.isArray(event.options) && event.options.length === 2 &&
          event.options[0] === "Approve" && event.options[1] === "Deny") {
        uiRequests.set(String(event.id), event.method);
        options.onApproval({ id: event.id, method: "omp/confirm", params: {
          threadId: sessionId, turnId, title: event.method === "select" ? "OMP tool approval" : event.title,
          message: event.method === "select" ? event.title : event.message,
          toolApproval: event.method === "select",
        } });
      } else if (event.method === "cancel") {
        uiRequests.delete(String(event.targetId));
        options.onEvent({ method: "serverRequest/resolved", params: { threadId: sessionId, requestId: event.targetId } });
      } else if (["select", "input", "editor"].includes(event.method)) {
        // Unsupported interactive inputs must not leave the native turn waiting forever.
        send({ type: "extension_ui_response", id: String(event.id), cancelled: true });
        options.onEvent({ method: "error", params: { threadId: sessionId,
          error: { message: `OMP requested an unsupported interactive ${event.method}; the request was cancelled. Use the native CLI for this interaction.` } } });
      }
      return;
    }
    if (event.type === "extension_error") {
      options.onEvent({ method: "omp/extension_error", params: {
        id: randomUUID(), threadId: sessionId, ...(turnId ? { turnId } : {}),
        extensionPath: event.extensionPath, event: event.event, error: event.error,
      } });
      return;
    }
    if(event.type==='auto_compaction_end'&&event.action==='context-full'&&!event.result&&!event.aborted)options.onEvent({method:'mandala/contextLimitReached',params:{threadId:sessionId,turnId}});
    if(event.type==='auto_compaction_end'&&event.result&&!event.aborted){options.onEvent({method:'mandala/contextCompacted',params:{threadId:sessionId,turnId}});return;}
    if (event.type === "agent_start") {
      interrupted = false;
      options.onEvent({ method: "turn/started", params: {
        threadId: sessionId, turn: { id: turnId, status: "inProgress" },
      } });
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      beginMessage(event.message);
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!["text_delta", "thinking_delta"].includes(update?.type)) return;
      if (!messageId) beginMessage(event.message);
      const index = update.contentIndex ?? 0;
      const content = event.message?.content?.[index];
      const itemId = `${messageId}:${index}`;
      if (update.type === "text_delta") {
        if (!messageBlocks.has(index)) {
          messageBlocks.add(index);
          emitItem("item/started", { id: itemId, type: "agentMessage", text: "", phase: phaseOf(content) });
        }
        options.onEvent({ method: "item/agentMessage/delta", params: {
          threadId: sessionId, turnId, itemId, delta: update.delta,
        } });
      } else options.onEvent({ method: "item/reasoning/textDelta", params: {
        threadId: sessionId, turnId, itemId, delta: update.delta,
      } });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      // OMP 18.6.1 messageId belongs to the envelope, not message.id.
      options.onEvent({method:'mandala/usageMessage',params:{threadId:sessionId,turnId,messageId:event.messageId,model:message.model,usage:message.usage}});
      if (!messageId) beginMessage(message);
      for (const [index, content] of (message.content ?? []).entries()) {
        if (content.type === "text") emitItem("item/completed", {
          id: `${messageId}:${index}`, type: "agentMessage", text: content.text,
          phase: phaseOf(content), stopReason: message.stopReason,
        });
        if (content.type === "thinking") emitItem("item/completed", {
          id: `${messageId}:${index}`, type: "reasoning", content: [content.thinking], summary: [],
        });
      }
      emitItem("item/completed", { id: messageId, type: "modelCall", model: message.model,
        status: ["error", "aborted"].includes(message.stopReason) ? "failed" : "completed",
        durationMs: message.duration, ttftMs: message.ttft });
      messageId = "";
      if (message.stopReason === "error") options.onEvent({ method: "error", params: { threadId: sessionId,
        error: { message: message.errorMessage || "OMP model request failed" } } });
    } else if (event.type === "tool_execution_update") {
      const output = (event.partialResult?.content ?? []).filter((part: any) => part.type === "text")
        .map((part: any) => part.text).join("\n");
      const previous = toolOutput.get(event.toolCallId) ?? "";
      const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
      toolOutput.set(event.toolCallId, output);
      if (delta) options.onEvent({ method: "item/commandExecution/outputDelta", params: {
        threadId: sessionId, turnId, itemId: event.toolCallId, delta,
      } });
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      toolOutput.delete(event.toolCallId);
      options.onEvent({ method: event.type === "tool_execution_start" ? "item/started" : "item/completed",
        params: { threadId: sessionId, turnId,
          item: { type: "mcpToolCall", id: event.toolCallId, server: "OMP", tool: event.toolName,
            status: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "inProgress",
            arguments: event.args, result: event.result } } });
    } else if (event.type === "agent_end" && event.isTerminal !== false) {
      const lastAssistant = event.messages?.filter((message: any) => message.role === "assistant").at(-1);
      options.onEvent({ method: "turn/completed", params: {
        threadId: sessionId, turn: { id: turnId,
          status: interrupted || lastAssistant?.stopReason === "aborted" ? "interrupted" :
            lastAssistant?.stopReason === "error" ? "failed" : "completed" },
      } });
    } else if (event.type === "notice" && event.level === "error") {
      options.onEvent({ method: "error", params: { error: { message: event.message }, threadId: sessionId } });
    }
  });
  child.on("exit", (code) => {
    exited = true;
    options.signal?.removeEventListener("abort", terminate);
    clearTimeout(startupTimer);
    for (const waiter of pending.values()) waiter.reject(new Error("OMP exited"));
    pending.clear();
    if (!started) failReady(new Error(runtimeError(`OMP exited before ready (${code ?? "unknown"})`, stderr, options.env)));
    if (!closed) options.onExit(runtimeError(`OMP exited (${code ?? "unknown"})`, stderr, options.env));
  });
  child.on("error", (error) => {
    const wasClosed = closed;
    closed = true;
    clearTimeout(startupTimer);
    failReady(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    if (started && !wasClosed) options.onExit(runtimeError("OMP process error", error.message, options.env));
  });
  try {
    const state = await request("get_state");
    sessionId = state.sessionFile ?? state.sessionId;
    if (!sessionId) throw new Error("OMP did not provide a session identifier");
  } catch (error) {
    closed = true;
    clearTimeout(startupTimer);
    options.signal?.removeEventListener("abort", terminate);
    terminate();
    await stopped;
    throw error;
  }
  return {
    async inspectContext(){const state=await request('get_state');return {settled:state.isSettled===true&&state.isStreaming===false&&state.isCompacting===false&&state.hasPendingAsyncWork===false&&state.queuedMessageCount===0};},
    async compactThread(){
      try{await request('compact');return 'completed';}
      catch(error){if(error instanceof Error&&error.message==='Nothing to compact (session too small)')return 'noop';throw error;}
    },
    async getStatus() {
      const current = await request("get_state");
      return { status: current.model ? "ready" : "login-required", version: null };
    },
    async listModels() {
      const result = await request("get_available_models");
      const current = await request("get_state");
      return (result.models ?? []).map((m: any) => ({ id: `${m.provider}/${m.id}`, label: `${m.provider} / ${m.name ?? m.id}`,
        isDefault: current.model?.provider === m.provider && current.model?.id === m.id,
        ...(m.thinking?.defaultLevel || current.thinkingLevel ? { defaultReasoningEffort: m.thinking?.defaultLevel ?? (current.thinkingLevel === "off" ? "none" : current.thinkingLevel) } : {}),
        supportedReasoningEfforts: m.thinking?.efforts ? ["none", ...m.thinking.efforts] : [],
      }));
    },
    async startThread() { return sessionId; },
    async resumeThread() {},
    async forkThread(nativeId, userTexts, beforeIndex) {
      if (nativeId !== sessionId) throw new Error("Native session does not match");
      const { messages } = await request("get_branch_messages");
      if (beforeIndex < 0 || beforeIndex > userTexts.length || !Array.isArray(messages) ||
          messages.length !== userTexts.length || messages.some((message: any, index: number) => message.text !== userTexts[index]))
        throw new Error("Native message history does not match; branching unavailable");
      if (beforeIndex === userTexts.length) {
        const original = await request("get_messages");
        const source = await request("get_state");
        const acp = createRpcClient(spawn("omp", ["acp", ...args.filter(arg =>
          !arg.startsWith("--mode=") && !arg.startsWith("--resume=") && arg !== "--no-session")], {
          cwd: options.cwd, stdio: "pipe", shell: false, signal: options.signal,
          env: { ...process.env, ...options.env },
        }), { jsonRpc: true });
        let forkId: string;
        try {
          const initialized = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {},
            clientInfo: { name: "mandala", version: "0.1.0" } });
          if (!initialized.agentCapabilities?.sessionCapabilities?.fork)
            throw new Error("Native reply branching unavailable");
          const fork = await acp.request("session/fork", {
            sessionId: source.sessionId, cwd: options.cwd, mcpServers: [],
          });
          if (!fork.sessionId || fork.sessionId === source.sessionId)
            throw new Error("Native branch did not create a new conversation");
          forkId = fork.sessionId;
        } finally { await acp.close(); }
        // Resolve the native UUID through the CLI rather than assuming its storage layout.
        const fork = await startOmp({ ...options, resume: forkId, onEvent() {}, onApproval() {}, onExit() {} });
        let forkPath: string;
        try { forkPath = await fork.startThread({ cwd: options.cwd, instructions: "" }); }
        finally { await fork.close(); }
        const switched = await request("switch_session", { sessionPath: forkPath });
        if (switched.cancelled) throw new Error("Native branch was cancelled");
        const active = await request("get_messages");
        const current = await request("get_state");
        if (current.sessionId !== forkId || JSON.stringify(active.messages) !== JSON.stringify(original.messages))
          throw new Error("Native branch prefix could not be verified");
        sessionId = current.sessionFile;
        return sessionId;
      }
      const result = await request("branch", { entryId: messages[beforeIndex].entryId });
      if (result.cancelled) throw new Error("Native branch was cancelled");
      const state = await request("get_state");
      if (!state.sessionFile || state.sessionFile === sessionId)
        throw new Error("Native branch did not create a new conversation");
      const active = await request("get_messages");
      const prefix = (active.messages ?? []).filter((message: any) => message.role === "user")
        .map((message: any) => typeof message.content === "string" ? message.content :
          message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
      if (prefix.length !== beforeIndex || prefix.some((text: string, index: number) => text !== userTexts[index]))
        throw new Error("Native branch prefix could not be verified");
      sessionId = state.sessionFile;
      return sessionId;
    },
    async listMcpStatus() { return {}; },
    async listSkills() {
      const result = await request("get_available_commands");
      return (result.commands ?? []).filter((x: any) => x.source === "skill")
        .map((x: any) => ({ name: x.name.replace(/^skill:/, ""), path: "" }));
    },
    async startTurn(_threadId, text, _approvalMode, _roots, turnOptions = {}) {
      if (turnOptions.model) {
        const slash = turnOptions.model.indexOf("/");
        if (slash < 1) throw new Error("invalid OMP model: provider/model required");
        await request("set_model", { provider: turnOptions.model.slice(0, slash), modelId: turnOptions.model.slice(slash + 1) });
      }
      if (turnOptions.effort) await request("set_thinking_level", { level: turnOptions.effort === "none" ? "off" : turnOptions.effort });
      const images = await Promise.all((turnOptions.images ?? []).map(async image => ({ type: "image", mimeType: image.mimeType, data: (await readFile(image.path)).toString("base64") })));

      turnId = randomUUID();
      messageId = "";
      const result = await request("prompt", { message: text, ...(images.length ? { images } : {}) });
      if (result?.agentInvoked === false) {
        // This response is correlated to the prompt even though no agent_start event is emitted.
        options.onEvent({ method: "turn/started", params: {
          threadId: sessionId, turn: { id: turnId, status: "inProgress" },
        } });
        options.onEvent({ method: "turn/completed", params: {
          threadId: sessionId, turn: { id: turnId, status: "completed" },
        } });
      }
      return turnId;
    },
    async interrupt() { interrupted = true; await request("abort"); },
    replyApproval(id, result) {
      const accepted = (result as { decision?: string }).decision === "accept";
      const method = uiRequests.get(String(id));
      uiRequests.delete(String(id));
      send({ type: "extension_ui_response", id: String(id),
        ...(method === "select" ? { value: accepted ? "Approve" : "Deny" } : { confirmed: accepted }) });
    },
    close() {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error("OMP closed"));
      pending.clear();
      child.stdin.end();
      terminate();
      return stopped;
    },
  };
}
