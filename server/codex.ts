import type { TurnOptions } from "../shared/chat-input";
import type { RunIdentity } from '../shared/tasks';
import { spawn } from "./native-spawn";
import { createHash } from "node:crypto";
import { lstat, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRpcClient } from "./rpc";
import type { CliStatus, ModelChoice, McpServer, ApprovalMode } from "../shared/types";
import type { RpcClient, RpcMessage } from "./rpc";
import { runtimeError, validateRuntimeArgs } from "./runtime";
import {DomainError} from '../shared/workspace-contracts';
import { windowsSystemBinary } from '../cli/windows-system.mjs';
import { codexMailboxSid, ownedPrivatePath } from '../cli/private-path.mjs';

let mailboxPreparations = Promise.resolve();
type WorkspaceSandbox = {
  type: 'workspaceWrite';
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
};
type MailboxPreparer = (path: string, sandbox?: WorkspaceSandbox) => Promise<void>;

function prepareWindowsMailbox(rpc: RpcClient, mailboxPath: string, launch: Parameters<typeof spawn>[2],
  profileArgs: string[], workspaceSandbox?: WorkspaceSandbox): Promise<void> {
  // The legacy Codex sandbox registers writable-root SIDs with a shared
  // read/modify/write. Register this root before parallel tools can enter it.
  const preparation = mailboxPreparations.then(async () => {
    const info = await lstat(mailboxPath);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Codex could not prepare the private Mandala mailbox.');
    const env = { ...launch.env };
    const codexHome = env.CODEX_HOME
      ? resolve(String(launch.cwd), env.CODEX_HOME) : join(homedir(), '.codex');
    env.CODEX_HOME = codexHome;
    const command = [windowsSystemBinary('cmd.exe'), '/d', '/c', 'exit', '0'];
    const scratch = await mkdtemp(join(mailboxPath, '.sandbox-setup-'));
    let exitCode: number | null;
    if (workspaceSandbox) {
      // Register all roots of the already-authorized workspace policy together.
      // Otherwise two cold commands can race on the project or temp root.
      const warm = (cwd: typeof launch.cwd) => rpc.request('command/exec', {
        command, cwd, sandboxPolicy: workspaceSandbox, timeoutMs: 10000,
      });
      exitCode = (await warm(launch.cwd))?.exitCode;
      // A command in a subdirectory uses the project's extra-root SID instead
      // of its cwd SID. Register both while preparing the same policy.
      if (exitCode === 0) exitCode = (await warm(scratch))?.exitCode;
    } else {
      // Never project a named or read-only profile to a workspace-write policy.
      const name = 'mandala-mailbox-setup-' + createHash('sha256').update(mailboxPath).digest('hex').slice(0, 24);
      const profile = 'permissions.' + name + '={extends=":read-only",filesystem={' + JSON.stringify(mailboxPath) + '="write"}}';
      const child = spawn('codex', ['sandbox', ...profileArgs, '-P', name, '--include-managed-config',
        '-c', profile, '-c', 'windows.sandbox="unelevated"', '-C', scratch, '--', ...command], { ...launch, cwd: scratch, env });
      child.stdout.resume();
      child.stderr.resume();
      exitCode = await new Promise<number | null>((done, reject) => {
        const timeout = setTimeout(() => child.kill(), 10000);
        child.once('error', reject);
        child.once('close', code => { clearTimeout(timeout); done(code); });
      });
    }
    const sid = exitCode === 0 ? await codexMailboxSid(join(codexHome, 'cap_sid'), mailboxPath) : undefined;
    if (!sid || !ownedPrivatePath(mailboxPath, info, Infinity, sid)) {
      throw new Error('Codex could not prepare the private Mandala mailbox.');
    }
  });
  mailboxPreparations = preparation.catch(() => {});
  return preparation;
}

const omitPermissionNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined).map(omitPermissionNulls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, omitPermissionNulls(item)]));
  return value;
};
export type CodexOptions = {
  signal?: AbortSignal;
  cwd: string;
  extraArgs?: string[];
  fullAccess?: boolean;
  safeSystem?: boolean;
  model?: string;
  gateway?: 'native' | 'unavailable';
  env?: Record<string, string>;
  onEvent: (event: RpcMessage) => void;
  onApproval: (request: RpcMessage) => void;
  onExit: (reason: string) => void;
};
export interface CodexClient {
  inspectContext?(nativeId:string):Promise<{settled:boolean;completedCompactions?:string[]}>;
  compactThread?(nativeId:string):Promise<'started'|'completed'|'noop'|'unsupported'>;
  getStatus(): Promise<CliStatus>;
  requiresRuntimeReload?(runtimeMailboxPath?:string):Promise<boolean>;
  assertReloadable?(nativeId:string):Promise<void>;
  inspectInvocation?(identity: RunIdentity): Promise<"running" | "succeeded" | "failed" | "unknown">;
  listModels(): Promise<ModelChoice[]>;
  startThread(options: {
    cwd: string;
    instructions: string;
    model?: string;
    mcp?: McpServer[];
    ephemeral?: boolean;
    safeSystem?: boolean;
    runtimeWorkspaceRoots?: string[];
    runtimeMailboxPath?: string;
  }): Promise<string>;
  resumeThread(nativeId: string, mcp?: McpServer[], instructions?: string, model?: string, runtimeWorkspaceRoots?: string[], runtimeMailboxPath?: string): Promise<void>;
  forkThread?(nativeId: string, userTexts: string[], beforeIndex: number, model?: string): Promise<string>;
  setSkillRoots?(roots: string[]): Promise<void>;
  listMcpStatus?(nativeId: string): Promise<Record<string, string | null>>;
  listSkills?(cwd: string): Promise<{ name: string; path: string }[]>;
  prepareTurn?(nativeId: string, options?: TurnOptions): Promise<void>;
  startTurn(nativeId: string, text: string, approvalMode?: ApprovalMode, runtimeWorkspaceRoots?: string[], options?: TurnOptions): Promise<string>;
  interrupt(nativeId: string, turnId: string): Promise<void>;
  replyApproval(id: string | number, result: unknown): void;
  close(): void | Promise<void>;
}
export async function connectCodex(rpc: RpcClient, cwd?: string, fullAccess = true, onUsageEvent: (event:RpcMessage)=>void = ()=>{},
  prepareMailbox?: MailboxPreparer): Promise<CodexClient> {
  let version: string | null = null;
  try {
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "mandala", title: "Mandala", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    version = initialized.userAgent?.match(/\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    rpc.notify("initialized");
  } catch (e) {
    await rpc.close();
    throw e;
  }
  let loadedPermissionsSignature:string|undefined,loadedMailboxProfile=false,loadedMailboxPath:string|undefined;
  const authorizedWorkspaceSandbox = (result: { cwd?: string; sandbox?: WorkspaceSandbox }, mailboxPath: string, namedProfile: boolean) => {
    const { sandbox } = result;
    if (!namedProfile && cwd && result.cwd && resolve(result.cwd) === resolve(cwd) &&
        sandbox?.type === 'workspaceWrite' && sandbox.writableRoots?.includes(mailboxPath)) return sandbox;
  };
  const readPermissions = async (mailboxPath?: string) => {
    const { config } = await rpc.request("config/read", { ...(cwd ? { cwd } : {}) });
    if (!config) throw new Error("Cannot read native permissions");
    const signature=createHash('sha256').update(JSON.stringify({mode:config.sandbox_mode,profile:config.default_permissions,profiles:config.permissions,workspace:config.sandbox_workspace_write,approval:config.approval_policy,reviewer:config.approvals_reviewer,windows:config.windows})).digest('hex');
    const windowsSandbox = config.windows?.sandbox ?? (config.features?.experimental_windows_sandbox || config.features?.enable_experimental_windows_sandbox
      ? (config.features?.elevated_windows_sandbox ? 'elevated' : 'unelevated') : undefined);
    const needsMailboxPreparation = process.platform === 'win32' && windowsSandbox === 'unelevated';
    const named = typeof config.default_permissions === "string" ? config.default_permissions : undefined;
    const base = named ?? (config.sandbox_mode === "read-only" ? ":read-only" : undefined);
    if (mailboxPath && base) {
      const name = "mandala-cli-" + createHash("sha256").update(mailboxPath).digest("hex").slice(0, 24);
      const profiles = omitPermissionNulls(config.permissions) as Record<string, unknown> | undefined;
      return { selection: { permissions: name }, profiles: { ...profiles, [name]: { extends: base, filesystem: { [mailboxPath]: "write" } } }, signature, needsMailboxPreparation };
    }
    return { selection: named !== undefined ? { permissions: named } : { sandbox: config.sandbox_mode ?? "workspace-write" }, profiles:undefined, signature, needsMailboxPreparation };
  };
  return {
    async inspectContext(threadId){
      const [{thread},terminals]=await Promise.all([rpc.request('thread/read',{threadId,includeTurns:true}),rpc.request('thread/backgroundTerminals/list',{threadId})]);
      return {settled:thread?.id===threadId&&['idle','notLoaded'].includes(thread.status?.type)&&Array.isArray(thread.turns)&&thread.turns.every((turn:any)=>['completed','failed','interrupted'].includes(turn.status))&&Array.isArray(terminals?.data)&&terminals.data.length===0&&!terminals.nextCursor,
        completedCompactions:(thread?.turns??[]).filter((turn:any)=>turn.status==='completed'&&turn.items?.some((item:any)=>item.type==='contextCompaction')).map((turn:any)=>turn.id)};
    },
    async compactThread(threadId){await rpc.request('thread/compact/start',{threadId});return 'started';},
    async requiresRuntimeReload(mailboxPath){
      if(fullAccess)return false;
      // Loaded native threads retain their original invocation roots even after resume.
      try{const next=await readPermissions(mailboxPath);return mailboxPath!==loadedMailboxPath||loadedMailboxProfile||!!next.profiles||next.signature!==loadedPermissionsSignature;}
      catch{throw new DomainError('native_background_check_failed',409,'Native permissions could not be checked. Retry later; the current conversation is preserved.');}
    },
    async assertReloadable(threadId){
      let terminals:any;
      try{terminals=await rpc.request('thread/backgroundTerminals/list',{threadId});if(!Array.isArray(terminals?.data))throw Error('Invalid background state');}
      catch{throw new DomainError('native_background_check_failed',409,'Background command status could not be checked. Retry later; the current conversation is preserved.');}
      if(terminals.data.length||terminals.nextCursor)throw new DomainError('native_background_active',409,'Background commands are still running. Let them finish, then retry; the current conversation is preserved.');
    },
    async inspectInvocation(identity) {
      try {
        const result = await rpc.request("thread/read", {threadId:identity.nativeSessionId,includeTurns:true});
        if (result.thread?.id !== identity.nativeSessionId) return "unknown";
        const turn = result.thread.turns?.find((turn: {id:string}) => turn.id === identity.nativeTurnId);
        return turn?.status === "completed" ? "succeeded" : ["failed","interrupted"].includes(turn?.status) ? "failed" : "unknown";
      } catch { return "unknown"; }
    },
    async getStatus() {
      const result = await rpc.request("account/read", { refreshToken: false });
      if (typeof result.requiresOpenaiAuth !== "boolean")
        throw new Error("Invalid native account status");
      return {
        status:
          result.requiresOpenaiAuth && !result.account
            ? "login-required"
            : "ready",
        version,
      };
    },
    async listModels() {
      const models: ModelChoice[] = [];
      const config = (await rpc.request("config/read", { ...(cwd ? { cwd } : {}) }).catch(() => ({}))).config;
      let cursor: string | null = null;
      do {
        const result = await rpc.request("model/list", { cursor, limit: 100 });
        models.push(
          ...result.data
            .filter((m: any) => !m.hidden)
            .map((m: any) => ({ id: m.model, label: m.displayName,
              ...(config?.model || m.isDefault !== undefined ? { isDefault: config?.model ? m.model === config.model : m.isDefault } : {}),
              ...(m.defaultReasoningEffort ? { defaultReasoningEffort: (config?.model ? config.model === m.model : m.isDefault) ? config?.model_reasoning_effort ?? m.defaultReasoningEffort : m.defaultReasoningEffort } : {}),
              ...(m.supportedReasoningEfforts ? { supportedReasoningEfforts: m.supportedReasoningEfforts.map((item: any) => item.reasoningEffort) } : {}),
            })),
        );
        cursor = result.nextCursor;
      } while (cursor);
      if (config?.model && !models.some(item => item.id === config.model))
        models.push({ id: config.model, label: config.model, isDefault: true,
          ...(config.model_reasoning_effort ? { defaultReasoningEffort: config.model_reasoning_effort } : {}) });
      return models;
    },
    async startThread({ cwd, instructions, model, mcp, ephemeral, safeSystem, runtimeWorkspaceRoots, runtimeMailboxPath }) {
      const permissions = !fullAccess && !safeSystem && runtimeMailboxPath ? await readPermissions(runtimeMailboxPath) : undefined;
      const result = await rpc.request("thread/start", {
          cwd,
          developerInstructions: instructions,
          ...(runtimeWorkspaceRoots?{runtimeWorkspaceRoots}:{}),
          ...(model ? { model } : {}),
          config: { mcp_servers: { ...codexMcp(mcp ?? []), mandala_tasks: { command: process.execPath, args: ['--version'], enabled: false }, openmana_tasks: { command: process.execPath, args: ['--version'], enabled: false } }, ...(permissions?.profiles ? { permissions: permissions.profiles } : {}) },
          ephemeral: ephemeral ?? false,
          ...(fullAccess ? { sandbox: "danger-full-access" } : {}),
          ...(permissions?.profiles ? permissions.selection : {}),
          ...(safeSystem ? { sandbox: "read-only", approvalPolicy: "never" } : {}),
        });
      if (permissions?.needsMailboxPreparation && runtimeMailboxPath)
        await prepareMailbox?.(runtimeMailboxPath, authorizedWorkspaceSandbox(result, runtimeMailboxPath, !!permissions.profiles));
      if(permissions){loadedPermissionsSignature=permissions.signature;loadedMailboxProfile=!!permissions.profiles;loadedMailboxPath=runtimeMailboxPath;}
      onUsageEvent({method:'mandala/usageBaseline',params:{threadId:result.thread.id,fresh:true,model:result.model??model}});
      return result.thread.id;
    },
    async resumeThread(threadId, mcp, instructions, model, runtimeWorkspaceRoots, runtimeMailboxPath) {
      const permissions = fullAccess ? { selection: { sandbox: "danger-full-access" }, profiles: undefined, signature:undefined, needsMailboxPreparation: false } : await readPermissions(runtimeMailboxPath);
      // Restored tokenUsage notifications can arrive before the resume reply.
      onUsageEvent({method:'mandala/usageBaseline',params:{threadId,fresh:false,model}});
      const result=await rpc.request("thread/resume", {
        ...permissions.selection,
        threadId,
        ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
        ...(model ? { model } : {}),
        ...(instructions !== undefined ? { developerInstructions: instructions } : {}),
        config: { mcp_servers: { ...codexMcp(mcp ?? []), mandala_tasks: { command: process.execPath, args: ['--version'], enabled: false }, openmana_tasks: { command: process.execPath, args: ['--version'], enabled: false } }, ...(permissions.profiles ? { permissions: permissions.profiles } : {}) },
      });
      if (permissions.needsMailboxPreparation && runtimeMailboxPath)
        await prepareMailbox?.(runtimeMailboxPath, authorizedWorkspaceSandbox(result, runtimeMailboxPath, !!permissions.profiles));
      // Codex 0.160 accepts resume overrides but ignores them on loaded threads.
      if(instructions!==undefined)await rpc.request('thread/inject_items',{threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'Current Mandala runtime instructions replace earlier Mandala invocation instructions. Earlier CLI launchers have expired.\n\n'+instructions}]}]});
      loadedPermissionsSignature=permissions.signature;loadedMailboxProfile=!!permissions.profiles;loadedMailboxPath=runtimeMailboxPath;
      if(result.model)onUsageEvent({method:'mandala/usageModel',params:{threadId,model:result.model}});
    },
    async forkThread(threadId, userTexts, beforeIndex, model) {
      const readMessages = (thread: any) => (thread.turns ?? []).flatMap((turn: any) =>
        (turn.items ?? []).filter((item: any) => item.type === "userMessage")
          .map((item: any) => ({ turnId: turn.id, text: item.content
            .filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") })));
      const originalThread = (await rpc.request("thread/read", { threadId, includeTurns: true })).thread;
      const original = readMessages(originalThread);
      if (beforeIndex < 0 || beforeIndex > userTexts.length || original.length !== userTexts.length ||
          original.some((message: any, index: number) => message.text !== userTexts[index]))
        throw new Error("Native message history does not match; branching unavailable");
      const result = await rpc.request("thread/fork", {
        threadId, ...(beforeIndex < original.length ? { beforeTurnId: original[beforeIndex].turnId } : {}), deferGoalContinuation: true,
        ...(model ? { model } : {}),
      });
      const forkId = result.thread?.id;
      if (!forkId || forkId === threadId) throw new Error("Native branch did not create a new conversation");
      onUsageEvent({method:'mandala/usageBaseline',params:{threadId:forkId,fresh:false,model:result.model??model}});
      const forkThread = (await rpc.request("thread/read", { threadId: forkId, includeTurns: true })).thread;
      const prefix = readMessages(forkThread);
      if (prefix.length !== beforeIndex || prefix.some((message: any, index: number) => message.text !== userTexts[index]))
        throw new Error("Native branch prefix could not be verified");
      const boundary = beforeIndex < original.length ? originalThread.turns.findIndex((turn: any) => turn.id === original[beforeIndex].turnId) : originalThread.turns.length;
      const messages = (turns: any[]) => turns.flatMap(turn => (turn.items ?? []).filter((item: any) => ["userMessage", "agentMessage"].includes(item.type))
        .map((item: any) => ({type: item.type, content: item.content, text: item.text})));
      if (JSON.stringify(messages(originalThread.turns.slice(0, boundary))) !== JSON.stringify(messages(forkThread.turns ?? [])))
        throw new Error("Native branch prefix could not be verified");
      return forkId;
    },
    async setSkillRoots(roots) {
      await rpc.request("skills/extraRoots/set", { extraRoots: roots });
    },
    async listMcpStatus(threadId) {
      const status: Record<string, string | null> = {};
      let cursor: string | null = null;
      do {
        const result = await rpc.request("mcpServerStatus/list", {
          threadId, cursor, limit: 100, detail: "toolsAndAuthOnly",
        });
        for (const item of result.data ?? []) status[item.name] = item.runtimeStatus ?? null;
        cursor = result.nextCursor ?? null;
      } while (cursor);
      return status;
    },
    async listSkills(cwd) {
      const result = await rpc.request("skills/list", { cwds: [cwd], forceReload: true });
      return (result.data ?? []).flatMap((entry: any) =>
        (entry.skills ?? []).map((skill: any) => ({ name: skill.name, path: skill.path })),
      );
    },
    async startTurn(threadId, text, approvalMode, runtimeWorkspaceRoots, options = {}) {
      if(options.model)onUsageEvent({method:'mandala/usageModel',params:{threadId,model:options.model}});
      let policy: unknown;
      if (approvalMode === "auto") policy = "never";
      else if (approvalMode === "default" || approvalMode === "strict") {
        const config = (await rpc.request("config/read", { ...(cwd ? { cwd } : {}) })).config;
        if (!config) throw new Error("Cannot read native approval policy; default mode was not applied");
        // Codex 0.154.0 thread/start resolves an unset policy to on-request.
        policy = approvalMode === "strict" ? "untrusted" : config.approval_policy ?? "on-request";
        if (!["untrusted", "on-request", "never"].includes(policy as string) &&
            !(policy && typeof policy === "object" && "granular" in policy))
          throw new Error("Cannot read native approval policy; default mode was not applied");
      }
      return (
        await rpc.request("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }, ...(options.images ?? []).map(image => ({ type: "localImage", path: image.path }))],
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(runtimeWorkspaceRoots?{runtimeWorkspaceRoots}:{}),
          ...(policy !== undefined ? { approvalPolicy: policy } : {}),
        })
      ).turn.id;
    },
    async interrupt(threadId, turnId) {
      await rpc.request("turn/interrupt", { threadId, turnId });
    },
    replyApproval: (id, result) => rpc.reply(id, result),
    close: () => rpc.close(),
  };
}
function codexMcp(servers: McpServer[]) {
  const env = (references: Record<string, string>) => Object.fromEntries(
    Object.entries(references).map(([key, ref]) => {
      const name = ref.slice(2, -1);
      if (process.env[name] === undefined) throw new Error(`Missing environment variable: ${name}`);
      return [key, process.env[name]];
    }),
  );
  return Object.fromEntries(servers.map((server) => [server.name,
    server.transport === "stdio"
      ? { command: server.command, args: server.args ?? [],
          env: env(server.env ?? {}) }
      : { url: server.url },
  ]));
}
export async function startCodex(options: CodexOptions): Promise<CodexClient> {
  const extraArgs = options.extraArgs ?? [];
  validateRuntimeArgs("codex", extraArgs);
  const profileArgs: string[] = [], serverArgs: string[] = [];
  for (let index = 0; index < extraArgs.length; index++) {
    const argument = extraArgs[index];
    if (argument === "--profile" || argument === "-p") profileArgs.push(argument, extraArgs[++index]);
    else if (argument.startsWith("--profile=") || argument.startsWith("-p") && !argument.startsWith("--"))
      profileArgs.push(argument);
    else serverArgs.push(argument);
  }
  const launch = {
    cwd: options.cwd,
    stdio: "pipe" as const,
    shell: false,
    signal: options.signal,
    env: { ...process.env, ...options.env },
    refreshWindowsPath: !Object.keys(options.env ?? {}).some(key => key.toUpperCase() === 'PATH'),
  };
  const child = spawn("codex", [...profileArgs, "app-server", "--stdio", ...serverArgs], launch);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8192); });
  try {
    const rpc = createRpcClient(child, {
        onNotification: options.onEvent,
        onRequest: options.onApproval,
        onExit: (reason) => options.onExit(runtimeError(reason, stderr, options.env)),
    });
    return await connectCodex(rpc, options.cwd, options.fullAccess, options.onEvent,
      (mailbox, workspaceSandbox) => prepareWindowsMailbox(rpc, mailbox, launch, profileArgs, workspaceSandbox),
    );
  } catch (error) {
    throw new Error(runtimeError((error as Error).message, stderr, options.env));
  }
}
