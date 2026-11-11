import { createConversationApprovals, type ConversationApprovalScope } from './conversation-approvals';
import { supportsConversationApproval } from '../shared/approvals';
import {mandalaDirectory} from './mandala-directory';
import {boundTaskCriteria} from './task-criteria';
import {hasOperationOutcome,projectOperationOutcome} from './operation-results';
import {isDeepStrictEqual} from 'node:util';
import type {OperationResult} from '../shared/operation-results';
import {discoverWorkDirectories,type WorkDiscoveryInput} from './work-directory-discovery';
import {discoverTeamCapabilities,type TeamCapabilityInput} from './team-capability-discovery';
import {mandalaPlanningSkill} from './mandala-planning-skill';
import {createMandalaContinuity} from './mandala-continuity';
import {isHumanInput} from '../shared/tasks';
import {createMandalaCoordination} from './mandala-coordination';
import { mandalaInstructions, mandalaContinuity, mandalaContextBoundary } from "./mandala";
import { effectiveResponseStyle } from "../shared/response-style";
import { responseStyleInstructions } from "./response-style";
import { createCodeGraph, type CodeGraphService } from './code-graph';
import type { CodeGraphReadScope } from '../shared/code-graph';
import { createKnowledgeBase, type KnowledgeBase } from './knowledge-base';
import { skillIdentity } from "../shared/skills";
import {createTaskMonitor} from './task-monitor';
import { createConversationReferences } from './conversation-references';
import type { ConversationReferenceSummary } from '../shared/conversation-references';
import type { CodexOptions } from "./codex";
import { startNativeRuntime } from "./native-runtime";
import { isCli } from "../shared/runtimes";
import { productEnv } from "../cli/product-env.mjs";
import {createAgentMessages} from './agent-messages';
import {markConversationProgress} from './conversation-progress';
import type {AgentMessage,AgentMessageInput} from '../shared/agent-messages';
import { workspacePrincipal } from "./workspace-identity";
import { attachmentText, loadAttachments } from "./attachments";
import type { ComposerReferenceItem, ComposerReferenceSelection } from "../shared/composer-references";
import { listComposerReferences, resolveComposerReferences, type ComposerReferencePreview } from "./composer-references";
import { createBusinessCliRuntime, businessCliInstructions, type BusinessCliRuntime } from "./business-cli-runtime";
import { invokeBusinessCli } from "./business-cli-http";
import { hasReceiptConversationHistory, registerSkillConversationRead } from './skill-evidence';
import { createSkillLearning } from "./skill-learning";
import { createSkillCatalog } from "./skill-catalog";
import type { SystemGenerator } from "./system-tasks";
import { createSkillService } from "./skill-service";
import { findCommand } from "../cli/commands.mjs";
import type { IncomingMessage } from "node:http";
import { validateEffort, type NativeAttachment, type ReasoningEffort } from "../shared/chat-input";
import { createTaskResources, type DirectoryOwner } from './task-resources';
import {createTaskRecovery, retainNativeOccupancy, canReleaseNativeOccupancy, hasUnprovenNativeOccupancy, type RecoveryReport} from './task-recovery';
import type {AutomationRun} from '../shared/automations';
import { questionResponse, hasBlockingApprovals } from "../shared/questions";
import { asyncQuestions, asyncQuestionReply, initializeAsyncQuestions } from './async-questions';
import { nativeApprovalResponse, type ApprovalDecision } from "../shared/approvals";
import { createAttachmentAssets } from "./attachment-assets";
import { createRunArtifacts, reconcileArtifactCommands } from "./run-artifacts";
import { createTasks, type TaskResolver } from "./tasks";
import { createTaskScheduler } from "./task-scheduler";
import { createAssets } from "./assets";
import { createFileMaintenance, type FileMaintenance } from './file-maintenance';
import { createAssetFiles } from "./asset-files";
import { DomainError, type VersionRef, type Principal } from "../shared/workspace-contracts";
import type { Run, QueuedInput, Continuation, RunContextTrace } from "../shared/tasks";
import { randomUUID } from "node:crypto";
import type {
  Approval,
  ApprovalMode,
  Config,
  Conversation,
  ModelChoice,
  CliStatus,
  Cli,
  McpServer,
  SkillDefinition,
  Task,
  EventKind,
} from "../shared/types";
import type { Store } from "./store";
import { startCodex, type CodexClient } from "./codex";
import { startOmp, prepareCapabilityRuntime, type OmpOptions } from "./omp";
import { workspaceExecutionLocation } from '../shared/execution-machines';
import { connectSshExecution, type SshExecution } from './ssh-execution';
import { isSystemAgent, assertExecutionAvailable, conversationContext, hostContextInstructions } from "./conversation-context";
import { join, isAbsolute, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { stat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { homedir, tmpdir } from "node:os";
import { enabledRuntimes } from "../shared/runtimes";
import { capabilitySignature } from "./capabilities";
import { configuredRuntime, executionRuntimePolicy, resolveRuntime, runtimeSignature, systemRuntime } from "./runtime";
import type { RpcMessage } from "./rpc";
import { normalizeHookEvent } from "../shared/hooks";
import { memoryHistoryReferences, type MemoryRuntime } from "./memory-runtime";
import { validateTaskConfiguration } from './task-input';
import { createUsageRecorder, recoverUsage } from './usage';
import type {TaskProgressRound} from './task-progress';
import type { MemoryHit } from "../shared/memory";
import { recallMemory } from "./knowledge";
import { planMemoryRecall } from "./memory-retrieval-policy";
import { buildMemoryContext, type MemoryChangeNotice } from "./memory-context";
import { summarizeMemoryHit } from "./memory-presentation";
type ActiveInvocation = {
  invocationId: string; conversationId: string; nativeSessionId: string;
  nativeTurnId: string | null; generation: number;
};
export interface SessionManager {
  maintainMandalaContext():Promise<void>;
  coordination: ReturnType<typeof createMandalaCoordination>;
  setAutomationService(service:import('./automations').Automations):void;
  reconcileRuns(hostId:string):Promise<RecoveryReport>;
  startAutomationTask(taskId:string,input:AutomationRun):Promise<Run>;
  retryTask(taskId:string,expectedRevision:number,commandKey:string):Promise<Run>;
  resolveUnknownInput(id:string,action:'dismiss'|'retry',commandKey:string):QueuedInput;
  taskService: ReturnType<typeof createTasks>;
  fileMaintenance: FileMaintenance;
  knowledgeBase: KnowledgeBase;
  codeGraph: CodeGraphService;
  listReferenceSummary(id:string,outputsOnly?:boolean):Promise<ConversationReferenceSummary>;
  startDurableTask(taskId:string,expectedRevision:number,commandKey:string,conversationId?:string|null,coordination?:{continuation:Continuation;assertActive:()=>void;agentId?:string;projectId?:string|null;request?:string;criteria?:import('../shared/tasks').Criterion[]}):Promise<Run>;
  stopDurableTask(taskId:string,expectedRevision?:number,cancel?:boolean):Promise<{taskId:string;status:'stopped'|'cancelled'|'already_finished';runId:string|null}>;
  getCliStatus(projectId?: string, cli?: Cli, environment?: { workspaceId?: string | null; cwd?: string; agentId?: string }, scope?: "runtime" | "system"): Promise<CliStatus>;
  listModels(projectId?: string, cli?: Cli, environment?: { workspaceId?: string | null; cwd?: string; agentId?: string }, scope?: "runtime" | "system"): Promise<ModelChoice[]>;
  create(
    projectId: string,
    agentId: string,
    model?: string,
    cli?: Cli,
    environment?: { workspaceId?: string | null; cwd?: string; approvalMode?: ApprovalMode; effort?: ReasoningEffort },
  ): Promise<Conversation>;
  getVerification(id: string): { mcp: Record<string, string | null>; skills: { name: string; path: string }[]; loadedSignature: string; loadedRuntimeSignature?: string } | null;
  askAgent(sourceId:string,input:AgentMessageInput,options:{commandKey:string;boundInvocationId?:string}):Promise<AgentMessage>;
  getAgentMessage(id:string,agentId?:string):AgentMessage;
  createTask(sourceId: string, targetAgentId: string, request: string, targetId?: string, options?: { policy?: "notify" | "resume"; commandKey?: string; boundInvocationId?: string }): Promise<Task>;
  enqueueUserInput(id: string, text: string, commandKey: string, attachments?: string[], references?: ComposerReferenceSelection[]): QueuedInput;
  enqueueTelegramInput(id:string,text:string,requestId:string,attachments:string[]):QueuedInput;
  listComposerReferences(id?: string, preview?: ComposerReferencePreview): Promise<ComposerReferenceItem[]>;
  listUserInputs(id: string): QueuedInput[];
  cancelUserInput(id: string): QueuedInput;
  interruptAndSend(id:string,text:string,commandKey:string,expectedExecutionId:string,attachments?:string[],references?:ComposerReferenceSelection[]):Promise<QueuedInput>;
  sendQueuedInput(id:string,inputId:string,expectedExecutionId?:string|null):Promise<void>;
  isDedicatedConversation(id: string): boolean;
  authorizeConversationRead(id:string):void;
  authorizeConversationReference(id:string,recipientAgentId:string):void;
  callBoundTool(token: string, name: string, args: Record<string, unknown>, commandKey: string): Promise<unknown>;
  listTasks(projectId?: string, controlOnly?: boolean): Task[];
  branch(id: string, eventId: number, text: string): Promise<Conversation>;
  edit(id: string, eventId: number, text: string): Promise<Conversation>;
  fork(id: string, eventId?: number): Promise<Conversation>;
  send(id: string, text: string, attachments?: NativeAttachment[], references?: ComposerReferenceSelection[]): Promise<void>;
  executionId(id: string): string | null;
  presentTaskDecision(taskId:string):void;
  stop(id: string, expectedExecutionId?: string | null, continueQueued?:boolean): Promise<boolean>;
  continue(id: string, text: string, attachments?: NativeAttachment[], references?: ComposerReferenceSelection[], commandKey?: string): Promise<void>;
  answerQuestions(id:string, approvalId:string, answers:unknown):Promise<void>;
  submitAsyncQuestion(id:string,approvalId:string,answers:unknown,telegramRequestId?:string):QueuedInput;
  approve(
    id: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  setModel(id: string, model: string, effort?: ReasoningEffort): Promise<void>;
  setApprovalMode(id: string, mode: ApprovalMode | null): Promise<void>;
  getApprovals(id: string): Approval[];
  conversationApproval(id:string):Promise<{granted:boolean}>;
  revokeConversationApproval(id:string):void;
  hasActiveWork(): boolean;
  checkNativeBackgroundWork(): Promise<'idle' | 'busy' | 'unknown'>;
  close(): Promise<void>;
}
export function createSessionManager(
  store: Store,
  loadConfig: (options?: { hydrateSkills?: boolean }) => Promise<Config>,
  clientFactory: typeof startCodex = startCodex,
  ompFactory: typeof startOmp = startOmp,
  home = productEnv('HOME') ?? "",
  onSettled?: (id: string, round?: TaskProgressRound) => void,
  onMessage?: (id: string) => void,
  memoryRuntime?: MemoryRuntime,
  skillOptions?: { generate?:SystemGenerator; wikiGenerate?:SystemGenerator },
): SessionManager {
  const skillTools = home ? createSkillService(home, store) : undefined;
  const skillCatalog=home?createSkillCatalog(home,store):undefined;
  const skillLearning=home?createSkillLearning({home,store,loadConfig,generate:skillOptions?.generate??(clientFactory===startCodex&&ompFactory===startOmp?undefined:async()=>{throw new Error('Restricted Skill generator unavailable in this runtime fixture');})}):undefined;
  skillLearning?.start();
  const live = new Map<
    string,
    {
      client?: CodexClient;
      approvals: Map<string, Approval>;
      approvalScope?: ConversationApprovalScope;
      stopRequested: boolean;
      preparing?: boolean;
      controller: AbortController;
      stopping?: Promise<void>;
      finishStop?: () => void;
      activeTurnId?: string;
      invocation?: ActiveInvocation;
      usage?: ReturnType<typeof createUsageRecorder>;
      completedTurns?: Set<string>;
      runId?: string;
      durableRun?: Run;
      queuedInputId?: string;
      humanEventId?: number;
      admitted?: boolean;
      directoryOwner?: DirectoryOwner;
      sourceVersions?: VersionRef[];
      toolToken?: string;
      businessCli?: BusinessCliRuntime;
      codeGraphScope?: CodeGraphReadScope;
      artifacts?: ReturnType<typeof createRunArtifacts>;
      loadedSignature?: string;
      loadedToolToken?: string;
      loadedRuntimeSignature?: string;
      loadedInstructions?: string;
      loadedMemoryCount?: number;
      generation: number;
      verification?: { mcp: Record<string, string | null>; skills: { name: string; path: string }[] };
    }
  >();
  const branching = new Set<string>();
  const root = workspacePrincipal(store);
  const prepared = new Map<string, ReturnType<TaskResolver>>();
  const coordinatorPrepared = new Map<string, ReturnType<TaskResolver>>();
  const routes = new Map<string, () => NonNullable<Run["routing"]>>();
  let automationService:import('./automations').Automations|undefined;
  const tools = new Map<string, { conversationId: string; invocationId: string; projectId:string; agentId:string }>();
  const revokeBusinessCli = (runtime: { toolToken?: string; businessCli?: BusinessCliRuntime }) => {
    if (runtime.toolToken) tools.delete(runtime.toolToken);
    runtime.businessCli?.dispose();
    runtime.businessCli = undefined;
  };
  const goalByInvocation = new Map<string, string>();
  const resources = createTaskResources(store,id=>store.getConversation(id)?.executionLocation?.host);
  const conversationApprovals = createConversationApprovals(store);
  initializeAsyncQuestions(store);
  const queuePumps = new Set<Promise<void>>();
  const queueStarts = new Set<string>();
  const backgroundSends = new Map<string,{inputId:string;timer:ReturnType<typeof setTimeout>}>();
  const queuedSendPending = (id:string) => queueStarts.has(id)||backgroundSends.has(id);
  const queuedSendUnavailable = (id:string,inputId='') => queuedSendPending(id) ||
    !live.get(id)?.preparing && !live.get(id)?.invocation &&
    Boolean(store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=0 AND owner_id<>?').get(id,inputId));
  const directoryRoots = new Map<string,{roots:string[];conversationOutputRoot?:string}>();
  const files = createAssetFiles(home);
  store.database.exec("CREATE TABLE IF NOT EXISTS file_execution_scopes(invocation_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT,conversation_id TEXT NOT NULL)");
  const assets = createAssets(store, files, p => {
    if (!p.runId || !p.agentId) return undefined;
    const row = store.database.prepare("SELECT e.project_id FROM task_runs r JOIN task_executions e ON e.id=r.execution_id JOIN work_tasks t ON t.id=r.task_id WHERE r.id=? AND e.agent_id=? AND t.owner_user_id=?").get(p.runId, p.agentId, p.userId);
    if(row)return row.project_id as string | undefined;
    const scope=store.database.prepare('SELECT project_id FROM file_execution_scopes WHERE invocation_id=? AND user_id=? AND agent_id=?').get(p.runId,p.userId,p.agentId);
    return scope?.project_id as string | undefined;
  });
  const authorizeKnowledgeConversation=(p:Principal,id:string,sharedProjectId?:string)=>{
    const c=chat(id);
    if(sharedProjectId){
      if(c.projectId!==sharedProjectId||memoryHistoryReferences(store,id).length||store.listConversationTaskRuns(id).length||hasReceiptConversationHistory(store,id))throw new DomainError('wiki_project_evidence_private',403,'Private Memory, inherited Task or receipt context cannot be shared through Project Wiki reception');
      if(!attachmentAssets.lineage(root,id,sourceId=>authorizeConversationRead(sourceId)).complete)throw new DomainError('wiki_project_evidence_private',403,'Unresolved attachment history cannot be shared through Project Wiki reception');
      return knownSources(id);
    }if(p.agentId!==undefined&&p.agentId!==c.agentId)throw new DomainError('forbidden',403,'Conversation unavailable to this Agent');
    authorizeConversationRuns(store.listConversationTaskRuns(id),p.agentId);
    if(p.agentId!==undefined)authorizeReceiptHistory(id,p.agentId);
    const history=memoryHistoryReferences(store,id);if(memoryRuntime)memoryRuntime.memory.history({userId:p.userId,...p.agentId?{agentId:p.agentId}:{}},{projectId:c.projectId||null,items:history});else if(history.length)throw new DomainError('wiki_evidence_unavailable',403,'Conversation history authority unavailable');
  };
  const releaseSkillAuthority=registerSkillConversationRead(store,authorizeKnowledgeConversation,memoryRuntime?.memory.withAuthorityQuery);
  const knowledgeBase=createKnowledgeBase({home,store,loadConfig,authorizeConversationRead:authorizeKnowledgeConversation,generate:skillOptions?.wikiGenerate??(clientFactory===startCodex&&ompFactory===startOmp?undefined:async()=>{throw new Error('Restricted Wiki generator unavailable in this runtime fixture');})});
  const codeGraph=createCodeGraph({home,store,loadConfig});
  const fileMaintenance=createFileMaintenance({home,store,loadConfig,memoryRuntime});
  const attachmentAssets=createAttachmentAssets(home,store,files,assets);
  // File bindings select immutable task resources; they do not inject file bodies or grant access.
  const boundFileVersions = (projectId: string, agentId: string): VersionRef[] => {
    const reader = {...root,agentId};
    const scoped = createAssets(store,files,p=>p.userId===reader.userId&&p.agentId===agentId?projectId:undefined);
    const selected = new Map<string,string|undefined>();
    for(const [type,id] of [['agent',agentId],['project',projectId]] as const){
      if(id)for(const binding of scoped.listBindings(reader,type,id))selected.set(binding.assetId,binding.versionPolicy==='pinned'?binding.versionId:undefined);
    }
    const refs:VersionRef[]=[];
    for(const [assetId,pinned] of selected){
      try{
        const asset=scoped.getAuthorizedAsset(reader,assetId);
        if(asset.kind!=='file'||!asset.headVersionId)continue;
        const version=scoped.getAuthorizedVersion(reader,{assetId,versionId:pinned??asset.headVersionId});
        refs.push({assetId,versionId:version.id});
      }catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;}
    }
    return refs;
  };
  const tasks = createTasks(store, { assets, async authorizeObservation(p) {
    const config=await loadConfig();if(p.userId!==store.ownerUserId||!isSystemAgent(config,p.agentId))throw new DomainError('forbidden',403,'System observation unavailable');
  }, authorizeConversation(p,id) {
    const c=chat(id);if(p.agentId!==undefined&&p.agentId!==c.agentId)throw new DomainError('forbidden',403,'Conversation unavailable to this Agent');
    authorizeConversationRuns(store.listConversationTaskRuns(id),p.agentId);
    if(p.agentId!==undefined)authorizeReceiptHistory(id,p.agentId);
    if(memoryRuntime)memoryRuntime.memory.history(p,{projectId:c.projectId||null,items:memoryHistoryReferences(store,id)});
  }, resolve: (_p, task) => {
    const selected = prepared.get(task.id);
    if (!selected) throw new Error("Task context preparation required");
    return selected;
  } });
  const coordination=createMandalaCoordination({home,store,tasks});
  let closed = false;
  let closing: Promise<void> | undefined;
  const initializations = new Set<Promise<CodexClient>>();
  const clients = new Set<CodexClient>();
  const initialize = async (create:()=>Promise<CodexClient>) => {
    if (closed) throw new Error("service closed");
    const pending = (async()=>{
      const client = await create(), nativeClose = client.close.bind(client);
      let cleanup:Promise<void>|undefined;
      client.close = () => {
        if (!cleanup) {
          try { cleanup = Promise.resolve(nativeClose()); } catch(error) { cleanup = Promise.reject(error); }
          cleanup = cleanup.finally(()=>clients.delete(client));
        }
        return cleanup;
      };
      clients.add(client);
      if (closed) { await client.close(); throw new Error("service closed"); }
      return client;
    })();
    initializations.add(pending);
    try { return await pending; } finally { initializations.delete(pending); }
  };
  const codexFactory = clientFactory, originalOmpFactory = ompFactory;
  clientFactory = options=>initialize(()=>codexFactory(options));
  ompFactory = options=>initialize(()=>originalOmpFactory(options));
  const factory = (cli: Cli) => cli === "codex" ? clientFactory : cli === "omp" ? ompFactory : (options: CodexOptions) => initialize(() => startNativeRuntime(cli, options));
  const remoteExecutions = new Map<string,Promise<SshExecution>>();
  const remoteFor = (context:ReturnType<typeof conversationContext>,id:string):Promise<SshExecution|undefined> => {
    const location=context.executionLocation;
    if(!location)return Promise.resolve(undefined);
    let pending=remoteExecutions.get(id);
    if(!pending){pending=connectSshExecution({id:location.machineId,name:location.machineName,host:location.host},{home,conversationId:id});remoteExecutions.set(id,pending);void pending.catch(()=>{if(remoteExecutions.get(id)===pending)remoteExecutions.delete(id);});}
    return pending;
  };
  const runtimeOptions = (cli:Cli,context:ReturnType<typeof conversationContext>|undefined,config:Config,scope:'runtime'|'system'='runtime'):Pick<CodexOptions,'extraArgs'|'env'|'fullAccess'|'gateway'|'safeSystem'> => {
    if(!context?.executionLocation)return scope==='system'?{...systemRuntime(cli,config.runtimeDefaults),...(cli==='omp'?{extraArgs:['--no-tools']}: {})}:resolveRuntime(cli,executionRuntimePolicy(cli,context?.agent,config.runtimeDefaults));
    const policy=configuredRuntime(cli,executionRuntimePolicy(cli,context.agent,config.runtimeDefaults));
    return {extraArgs:policy.args,...('fullAccess'in policy?{fullAccess:policy.fullAccess}:{}),...(policy.gateway?{gateway:policy.gateway}:{})};
  };
  const startClient = async(cli:Cli,options:CodexOptions|OmpOptions,context:ReturnType<typeof conversationContext>|undefined,id:string,config:Config,mode:'session'|'inspect'|'fork'='session') => {
    const isolated=mode!=='session',attachOnly=mode==='inspect',runtimeId=mode==='fork'?'fork-'+randomUUID():id;
    const location=context?.executionLocation;
    const remote=location&&isolated?await connectSshExecution({id:location.machineId,name:location.machineName,host:location.host},{home,conversationId:runtimeId}):context?await remoteFor(context,id):undefined;
    if(!remote)return factory(cli)(options);
    try{return await initialize(async()=>{
      const policy=executionRuntimePolicy(cli,context!.agent,config.runtimeDefaults);
      const client=await (attachOnly?remote.start(cli,options,policy,true):remote.start(cli,options,policy)),close=client.close.bind(client);
      client.close=async()=>{try{if(mode==='fork'&&!await remote.request<boolean>('runtime.release',{runtimeId}))throw new DomainError('native_background_active',409,'Remote fork writer could not be released.');}finally{if(!isolated)remoteExecutions.delete(id);await close();}};
      return client;
    });}catch(error){if(isolated)remote.close();throw error;}
  };
  const lifetime = new AbortController();
  const chat = (id: string) => {
    const c = store.getConversation(id);
    if (!c) throw new Error("conversation not found");
    return c;
  };
  const state = (id: string, status: Conversation["status"], diagnostic?:string) => {
    store.updateConversation(id, { status });
    appendEvent(id, "status", { status });
    const runtime=live.get(id),invocation=runtime?.invocation;
    if(['idle','interrupted','error'].includes(status)&&runtime)runtime.admitted=false;
    if(['idle','interrupted','error'].includes(status))runtime?.usage?.finish(status==='idle'?'completed':status==='error'?'failed':'interrupted',undefined,diagnostic);
    if(runtime?.durableRun&&invocation?.nativeTurnId&&(status==='approval'||status==='running'))tasks.setRunApproval({runId:runtime.durableRun.id,hostId:'local',nativeSessionId:invocation.nativeSessionId,nativeTurnId:invocation.nativeTurnId},status==='approval');
    if (status === "idle") queueMicrotask(() => { void pump(id); });
  };
  const appendEvent = (id: string, kind: EventKind, data: unknown) => store.appendEvent(id, kind, {
    ...(data as Record<string, unknown>), ...(live.get(id)?.runId ? { runId: live.get(id)!.runId } : {}),
  });
  recoverUsage(store);
  for (const c of store.listConversations())
    if (c.status === "running" || c.status === "approval") {
      store.appendEvent(c.id,'error',{message:'Mandala service restarted; native execution is unconfirmed. Continue only after checking its state.',code:'service_restarted'});
      state(c.id, "interrupted");
    }
  const selection = async (projectId: string, agentId?: string) => {
    if (closed) throw new Error("service closed");
    const config = await loadConfig();
    if (closed) throw new Error("service closed");
    assertExecutionAvailable(config,{projectId,agentId});
    return conversationContext(config, { projectId, agentId }, "");
  };
  const platformMcp = (project: Config["projects"][number], agent: Config["agents"][number]): McpServer[] =>
    [...new Map([...agent.mcp, ...project.mcp].map((m) => [m.name, m])).values()];
  const verify = async (runtime: { client?: CodexClient; verification?: { mcp: Record<string, string | null>; skills: { name: string; path: string }[] } },
    nativeId: string, cwd: string) => {
    const client = runtime.client;
    try {
      const mcp = await (client?.listMcpStatus?.(nativeId) ?? Promise.resolve({}));
      const skills = await (client?.listSkills?.(cwd) ?? Promise.resolve([]));
      if (runtime.client === client) runtime.verification = { mcp, skills };
    } catch {
      if (runtime.client === client) runtime.verification = undefined;
    }
  };
  const knownSources = (id: string): VersionRef[] => {
    const refs = [...(live.get(id)?.sourceVersions ?? []),...attachmentAssets.lineage(root,id,sourceId=>authorizeExecutionHistory(sourceId),mandalaContextBoundary(store,id)).refs];
    for (const event of store.listEvents(id,mandalaContextBoundary(store,id))) {
      const data=event.data as {memoryRecall?:string;status?:string;entries?:{assetId?:string;versionId?:string}[];actualUse?:string;sourceVersions?:VersionRef[]};
      if (event.kind !== "metadata") continue;
      if (data.memoryRecall && data.status === "completed") for (const entry of data.entries ?? []) if(entry.assetId && entry.versionId) refs.push({assetId:entry.assetId,versionId:entry.versionId});
      if (data.actualUse === "acknowledged") refs.push(...(data.sourceVersions ?? []));
    }
    return [...new Map(refs.map(ref=>[ref.versionId,ref])).values()];
  };
  const bindNative = (id: string, run: Run, nativeSessionId: string, nativeTurnId: string) => {
    if (tasks.bindRunIdentity({runId:run.id,hostId:"local",nativeSessionId,nativeTurnId}) === "applied")
      appendEvent(id,"metadata",{contextSnapshotId:run.contextSnapshotId!,actualUse:"acknowledged",sourceVersions:live.get(id)?.sourceVersions ?? [],nativeVisibility:"partial"} satisfies RunContextTrace);
    const runtime=live.get(id);
    for(const [key,approval] of runtime?.approvals??[]){const p=approval.params as {threadId?:string;turnId?:string};if(p.threadId!==nativeSessionId||p.turnId!=null&&p.turnId!==nativeTurnId)runtime!.approvals.delete(key);}
    if(chat(id).status==='approval'&&!hasBlockingApprovals(runtime?.approvals.values()??[]))state(id,'running');
    tasks.setRunApproval({runId:run.id,hostId:'local',nativeSessionId,nativeTurnId},hasBlockingApprovals(runtime?.approvals.values()??[]));
  };
  const inquiryTaskSource=(input:QueuedInput):string|null=>input.agentMessage?.direction==='reply'?
    store.database.prepare('SELECT r.id FROM agent_messages m JOIN task_runs r ON r.id=m.source_invocation_id WHERE m.id=? AND m.source_conversation_id=?').get(input.agentMessage.id,input.conversationId)?.id as string??null:null;
  const admissionConfig = new Map<string, Config>();
  // Count one execution per Chat across the existing claims/recovery records. Unknown native work retains its slot.
  const canAdmit = (id:string,config:Config) => {
    const target=chat(id);if(target.purpose==='mandala-main'||!target.agentId)return true;
    const occupied=new Set(store.database.prepare(`SELECT conversation_id AS id FROM task_directory_claims
      UNION SELECT json_extract(routing,'$.executionConversationId') FROM task_runs WHERE state IN ('starting','running','approval','unknown')
      UNION SELECT conversation_id FROM task_user_inputs WHERE state='unknown'
      UNION SELECT conversation_id FROM task_native_uncertainty`).all().map(row=>row.id as string).filter(Boolean));
    for(const [chatId,runtime] of live)if(runtime.admitted)occupied.add(chatId);
    if(occupied.has(id))return true;
    const active=[...occupied].map(id=>store.getConversation(id)).filter(c=>c&&c.purpose!=='mandala-main');
    if(config.agents.find(a=>a.id===target.agentId)?.systemRole!=='mandala'&&active.filter(c=>c!.agentId===target.agentId).length >= (config.agents.find(a=>a.id===target.agentId)?.maxParallel??3))return false;
    const managed=coordination.managedTaskIds();
    const managedChats=new Set(store.database.prepare("SELECT task_id,routing FROM task_runs WHERE routing IS NOT NULL").all().filter(r=>managed.has(r.task_id as string)).map(r=>JSON.parse(r.routing as string).executionConversationId));
    const coordinated=(c:Conversation)=>c.purpose==='mandala-background'||managedChats.has(c.id);
    return !coordinated(target)||active.filter(c=>coordinated(c!)).length < (config.mandala?.maxParallel??3);
  };
  const scheduler = createTaskScheduler(store, tasks, {
    principal: root,
    inputMetadata:id=>messages.metadata(id),
    inputEligible:input=>input.source?.kind!=='coordination'||!coordination.deliveryPaused(input.conversationId),
    tryClaimDirectory:work=>{
      const id=work.kind==='run'?work.run.routing!.executionConversationId:work.input.conversationId;
      if(!canAdmit(id,admissionConfig.get(id)!))return false;
      const owner={kind:work.kind,id:work.kind==='run'?work.run.id:work.input.id,conversationId:id,...(work.kind==='input'&&inquiryTaskSource(work.input)?{delegated:true}:{})};
      const directory=directoryRoots.get(id);if(!directory)return false;
      const outputRoot=work.kind==='run'&&home?join(home,'outputs',work.run.id):directory.conversationOutputRoot;
      // A Run may have been queued while the pump awaited directory preparation.
      if(outputRoot)mkdirSync(outputRoot,{recursive:true});
      const granted=resources.claim(owner,[...directory.roots,...(outputRoot?[outputRoot]:[])],'write')==='granted';
      if(!granted)store.appendEvent(id,'metadata',{execution:'queued',reason:'directory',...(work.kind==='run'?{taskId:work.run.taskId,runId:work.run.id}:{queuedInputId:work.input.id})});
      return granted;
    },
    coordinationContext:(task,id)=>coordinatorPrepared.get(task.id)??{agentId:chat(id).agentId,projectId:chat(id).projectId||null,hostId:'local',input:task.goal,sourceVersions:knownSources(id),requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'},
    routeTask: task => { const route = routes.get(task.id); if (!route) throw new Error("Task route missing"); return route(); },
    isConversationBusy: id => queuedSendPending(id) || continuity.blocked(id) || branching.has(id) || ["running", "approval", "interrupted"].includes(chat(id).status) || Boolean(live.get(id)?.invocation || live.get(id)?.preparing),
    execute: async work => {
      try {
        if (work.kind === "input") {
          if(work.input.agentMessage){
            if(!messages.eligible(work.input)){rejectMessageInput(work.input,'来源请求已失效');return;}
            try{await validateMessageInput(work.input);}catch{if(!closed)rejectMessageInput(work.input,'询问上下文或权限已失效');return;}
          }
          let resumed:Run|undefined;
          const sourceRunId=inquiryTaskSource(work.input);
          if(sourceRunId){
            try{
              const waiting=tasks.findInquiryWait(root,sourceRunId,work.input.conversationId)!;
              const next=tasks.prepareInquiryResume(root,waiting.runId,work.input.text,'inquiry:'+work.input.id);
              resumed=store.transaction(()=>{
                const queued=next.commit(),directory=directoryRoots.get(work.input.conversationId)!;
                const outputRoot=home?join(home,'outputs',queued.id):undefined;
                if(outputRoot)mkdirSync(outputRoot,{recursive:true});
                resources.releaseUnsubmitted('input',work.input.id);
                if(resources.claim({kind:'run',id:queued.id,conversationId:work.input.conversationId},[...directory.roots,...(outputRoot?[outputRoot]:[])],'write')!=='granted')throw new DomainError('inquiry_directory_changed',409,'Inquiry directory changed');
                store.database.prepare("UPDATE task_runs SET state='starting' WHERE id=? AND state='queued'").run(queued.id);
                store.enqueueOutbox({type:'task.run_starting',aggregateId:queued.id,aggregateRevision:1,causationId:queued.id,payload:{runId:queued.id,conversationId:work.input.conversationId}});
                return tasks.getRun(root,queued.id);
              });
            }catch(error){if(!(error instanceof DomainError))throw error;rejectMessageInput(work.input,'任务已变化或停止；询问回复已保留');return;}
          }
          await run(work.input.conversationId, work.input.text, false, false, resumed, work.input.id, await loadAttachments(home, work.input.conversationId, work.input.attachments ?? []), work.input.references);
        } else await run(work.run.routing!.executionConversationId, tasks.getContextSnapshot(root, work.run.id)!.input, false, false, work.run);
      } catch (error) { if (!closed) throw error; }
    },
  });
  const messages=createAgentMessages(store,(id,text,key)=>scheduler.enqueueUserInput(id,text,key));
  const rejectMessageInput=(input:QueuedInput,reason:string)=>{
    messages.finish(input.id,'failed',reason);
    if(scheduler.listUserInputs(input.conversationId).find(i=>i.id===input.id)?.state==='running')scheduler.rejectUnsubmittedInput(input.id);
    resources.releaseUnsubmitted('input',input.id);
    const source=messages.get(input.agentMessage!.id).sourceConversationId;
    messages.queueReplies(source);
    queueMicrotask(()=>{if(!closed){void pump(input.conversationId);if(source!==input.conversationId)void pump(source);}});
  };
  const validateMessageInput=async(input:QueuedInput)=>{
    const marker=input.agentMessage;if(!marker)return;
    const message=messages.get(marker.id),source=chat(message.sourceConversationId),target=chat(message.targetConversationId);
    const config=await loadConfig(),project=config.projects.find(p=>p.id===source.projectId);
    if(!project||!project.agentIds.includes(source.agentId)&&!isSystemAgent(config,source.agentId)||!project.agentIds.includes(target.agentId)&&!isSystemAgent(config,target.agentId)||target.projectId!==source.projectId)throw new DomainError('forbidden',403,'Message context unavailable');
    authorizeConversationRead(input.conversationId,true);
    if(!messages.eligible(input))throw new DomainError('message_stopped',409,'Message continuation stopped');
  };
  const invocationAnswer = (id:string,invocationId:string,completedOnly=false):string => {
    const messages = new Map<string, { text: string; phase?: string; stopReason?: string; completed?: boolean }>();
    for (const event of store.listEvents(id, 0).filter(e => (e.data as {runId?: string}).runId === invocationId)) {
      if (event.kind === "text") {
        const data = event.data as { itemId?: string; text?: string };
        const key = data.itemId ?? "reply";
        messages.set(key, { ...messages.get(key), text: (messages.get(key)?.text ?? "") + (data.text ?? "") });
      } else if (event.kind === "tool") {
        const data = event.data as { method?: string; params?: { item?: { id: string; type: string; text?: string; phase?: string; stopReason?: string; completed?: boolean } } };
        const item = data.params?.item;
        if (data.method === "item/completed" && item?.type === "agentMessage")
          messages.set(item.id, { text: item.text ?? messages.get(item.id)?.text ?? "", phase: item.phase, stopReason: item.stopReason, completed:true });
      }
    }
    const finals = [...messages.values()].filter(message => message.phase === "final_answer");
    const last = [...messages.values()].at(-1);
    return (finals.length ? finals.map(message => message.text).join("\n\n") :
      (!completedOnly || last?.completed) && last?.phase !== "commentary" && last?.stopReason !== "toolUse" ? last?.text ?? "" : "").trim();
  };
  const inquirySettlementCandidates=new Set<string>();
  const finishMessageInput=(inputId:string,outcome:'succeeded'|'failed'|'unknown',answer:string)=>{
    for(const id of messages.finish(inputId,outcome,answer)){
      const message=messages.get(id);
      messages.queueReplies(message.sourceConversationId);
      if(message.state==='succeeded'&&messages.isDedicated(message.targetConversationId))inquirySettlementCandidates.add(message.targetConversationId);
      queueMicrotask(()=>{if(!closed)void pump(message.sourceConversationId);});
    }
  };
  const settleInquiryConversation=(id:string)=>{
    if(!inquirySettlementCandidates.has(id)||chat(id).status!=='idle'||live.get(id)?.preparing)return;
    const db=store.database;
    // Never close unrelated human work or a Task just because an inquiry was answered.
    if(db.prepare("SELECT id FROM events WHERE conversationId=? AND kind='user' AND superseded=0 AND json_extract(data,'$.agentMessage') IS NULL AND json_extract(data,'$.task') IS NULL LIMIT 1").get(id)||
      db.prepare('SELECT task_id FROM task_executions WHERE conversation_id=? AND superseded_by_execution_id IS NULL LIMIT 1').get(id)||
      db.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? OR json_extract(continuation,'$.conversationId')=? LIMIT 1").get(id,id)){
      inquirySettlementCandidates.delete(id);return;
    }
    if(db.prepare("SELECT id FROM task_user_inputs WHERE conversation_id=? AND state IN ('queued','running','unknown') LIMIT 1").get(id)||
      db.prepare("SELECT id FROM agent_messages WHERE target_conversation_id=? AND state IN ('queued','running','unknown') OR source_conversation_id=? AND (state IN ('queued','running','unknown') AND reply_state<>'parked' OR auto_resume_allowed=1 AND reply_state IN ('pending','queued')) LIMIT 1").get(id,id)||
      db.prepare("SELECT id FROM task_receipts WHERE destination_conversation_id=? AND delivery_state IN ('pending','presented') LIMIT 1").get(id))return;
    markConversationProgress(store,id,true);inquirySettlementCandidates.delete(id);
  };
  const presentTaskReceipts=(taskId:string,targetId:string,succeeded:boolean)=>{
    queueMicrotask(() => {
      if (closed) return;
      try { for (const receipt of tasks.listReceipts(root, taskId)) {
        if (!receipt.destinationConversationId) continue;
        const destination = receipt.destinationConversationId;
        if (receipt.deliveryState === "pending") {
          scheduler.presentReceipt(receipt.id);
          store.appendEvent(destination, "task", { taskId: taskId, receiptId: receipt.id,
            status: succeeded ? "completed" : "failed", from: targetId, to: destination });
        }
        void pump(destination);
      } } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error;
        store.appendEvent(targetId,"metadata",{receiptPresentation:"forbidden",taskId:taskId});
      }
    });
  };
  const finishTask = (targetId: string, succeeded: boolean, runtime = live.get(targetId)) => {
    if (!runtime) return;
    if (runtime.queuedInputId) {
      const inputId=runtime.queuedInputId,marker=messages.metadata(inputId);
      if(marker)finishMessageInput(inputId,succeeded?'succeeded':'failed',invocationAnswer(targetId,runtime.runId!,true));
      if(scheduler.listUserInputs(targetId).find(i=>i.id===inputId)?.state==='running')scheduler.completeUserInput(inputId);
      runtime.queuedInputId = undefined;
      settleInquiryConversation(targetId);
    }
    const durable = runtime.durableRun;
    if (!durable) return;
    const result = invocationAnswer(targetId,runtime.runId!);
    const identity = store.database.prepare("SELECT host_id,native_session_id,native_turn_id FROM task_runs WHERE id=?").get(durable.id)!;
    const actual = {id:durable.id,hostId:identity.host_id as string,nativeSessionId:identity.native_session_id as string|null,nativeTurnId:identity.native_turn_id as string|null};
    if (actual.nativeSessionId && actual.nativeTurnId) {
      const outputs = store.database.prepare("SELECT id,asset_id FROM asset_versions WHERE json_extract(data,'$.provenance.runId')=?").all(actual.id)
        .map(row => ({assetId: row.asset_id as string, versionId: row.id as string}));
      tasks.applyRunEvent({ runId: actual.id, hostId: actual.hostId!, nativeSessionId: actual.nativeSessionId,
        nativeTurnId: actual.nativeTurnId, eventKey: `terminal:${actual.id}`, outcome: succeeded ? "succeeded" : runtime.stopRequested ? "interrupted" : "failed", summary: result, artifactVersions: outputs });
    } else {
      store.database.prepare("UPDATE task_runs SET state='unknown' WHERE id=? AND state='starting'").run(actual.id);
    }
    runtime.durableRun = undefined;
    presentTaskReceipts(durable.taskId,targetId,succeeded);
  };
  const backgroundNotConfirmed = (error:unknown) => error instanceof DomainError &&
    ['native_background_active','native_background_check_failed'].includes(error.code);
  const waitForQueuedBackground = (id:string,inputId:string,client:CodexClient,nativeId:string) => {
    const executionId=manager.executionId(id);
    const sameThread=()=>{
      const runtime=live.get(id),conversation=store.getConversation(id);
      return runtime?.client===client&&runtime.runId===executionId&&conversation?.nativeId===nativeId&&
        !runtime.preparing&&!runtime.invocation&&!['running','approval'].includes(conversation.status);
    };
    const release=()=>{
      backgroundSends.delete(id);
      store.appendEvent(id,'metadata',{queuedInputId:inputId,state:'queued'});
    };
    const poll=async()=>{
      if(backgroundSends.get(id)!==waiting)return;
      if(!sameThread()){release();return;}
      try{
        await client.assertReloadable!(nativeId);
      } catch(error){
        if(backgroundSends.get(id)!==waiting)return;
        if(backgroundNotConfirmed(error)&&sameThread()){waiting.timer=schedule();return;}
        release();
        return;
      }
      if(backgroundSends.get(id)!==waiting)return;
      if(!sameThread()){release();return;}
      backgroundSends.delete(id);
      try{await manager.sendQueuedInput(id,inputId,executionId);}
      catch(error){if(!closed)store.appendEvent(id,'error',{message:(error as Error).message,nativeTurnSubmitted:false});}
    };
    const schedule=()=>setTimeout(()=>{void poll();},750).unref();
    const waiting={inputId,timer:schedule()};
    backgroundSends.set(id,waiting);
    store.appendEvent(id,'metadata',{queuedInputId:inputId,state:'queued',reason:'background'});
  };
  const run = async (id: string, text: string, continuing: boolean, replacing = false,
    task?: Run, queuedInputId?: string, attachments: NativeAttachment[] = [], references: ComposerReferenceSelection[] = [], explicitQueuedSend = false) => {
    if (closed) throw new Error("service closed");
    let before = chat(id);
    if (queuedSendPending(id)&&!explicitQueuedSend || continuity.blocked(id) || branching.has(id) && !replacing || live.get(id)?.preparing || before.status === "running" || before.status === "approval")
      throw new Error("conversation busy");
    if (before.status === "interrupted" && !continuing)
      throw new Error("conversation interrupted; use continue");
    if (!text.trim() && !attachments.length && !references.length) throw new Error("invalid empty message");
    const originalText = text;
    const invocationId=task?.id??randomUUID();
    const messageOrigin=queuedInputId?messages.metadata(queuedInputId):undefined;
    const inputSource=queuedInputId?scheduler.listUserInputs(id).find(i=>i.id===queuedInputId)?.source:undefined;
    if(isHumanInput({task,agentMessage:messageOrigin,source:inputSource})&&hasRevokedReceiptHistory(id)) {
      try{await resetRevokedContext(id,queuedInputId);before=chat(id);}
      catch(error){if(queuedInputId&&scheduler.requeueUnsubmittedInput(queuedInputId,'context_rebuild_deferred'))resources.releaseUnsubmitted('input',queuedInputId);throw error;}
    }
    const owner:DirectoryOwner={kind:task?'run':queuedInputId?'input':'invocation',id:task?.id??queuedInputId??invocationId,conversationId:id};
    let runtime = live.get(id);
    if (!runtime) {
      runtime = { approvals: new Map(), stopRequested: false, generation: 0, controller: new AbortController() };
      live.set(id, runtime);
    }
    const current = runtime;
    current.runId = invocationId;
    current.preparing = true;
    current.directoryOwner=owner;
    current.durableRun = task;
    current.queuedInputId = queuedInputId;
    revokeBusinessCli(current);
    current.toolToken = randomUUID();
    tools.set(current.toolToken, { conversationId: id, invocationId: current.runId, projectId:before.projectId, agentId:before.agentId });

    current.stopRequested = false;
    current.activeTurnId = undefined;
    current.invocation = undefined;
    let acceptedUserEvent:ReturnType<Store['appendEvent']>|undefined;
    let turnSubmitted = false;
    let submittedInvocation: ActiveInvocation | undefined;
    let memoryTrace: { memoryRecall: string; count: number; entryIds: string[]; entries?: { title: string; kind: string; assetId?: string; versionId?: string }[] } | undefined;
    let memoryLoaded = false, memoryReadFailed = false;
    let layered: MemoryHit[] = [];
    let memoryContextInstructions = '';
    let inheritedMemory:ReturnType<typeof memoryHistoryReferences> = [];
    let memoryNotices:MemoryChangeNotice[] = [];
    const recallPlan=planMemoryRecall({request:text,recentRequests:store.listEvents(id,mandalaContextBoundary(store,id)).filter(event=>event.kind==='user').map(event=>(event.data as {text?:string}).text??''),taskRequest:task?tasks.getExecution(root,task.executionId).request:undefined});
    const memoryQuery = recallPlan.query??text;
    const memoryPrincipal = {...root, ...(before.agentId ? {agentId:before.agentId} : {}), ...(task ? {runId:task.id} : {})};
    let handoffSkills:SkillDefinition[]=[];
    let receiptSources:VersionRef[]=[];
    const validateHandoff = async () => {
      if(skillCatalog&&handoffSkills.length){
        const latest=await loadConfig(),agent=latest.agents.find(item=>item.id===before.agentId),project=latest.projects.find(item=>item.id===before.projectId);
        for(const skill of handoffSkills){
          if(!latest.skillLibrary?.some(item=>item.id===skill.id)||!(agent?.skillIds?.includes(skill.id)&&!agent.disabledSkillIds?.includes(skill.id))&&!((project?.agentIds.includes(before.agentId)||isSystemAgent(latest,before.agentId))&&project?.skillIds?.includes(skill.id)&&!project.disabledSkillIds?.includes(skill.id)))throw new DomainError('skill_unavailable',403,'Skill assignment changed during native preparation');
          skillCatalog.read(skill,before.agentId,latest,before.projectId);
        }
      }
      if(memoryRuntime&&layered.length){const kinds=await memoryRuntime.reading(memoryPrincipal);if(layered.some(r=>!kinds.some(kind=>(r.pipelines??['request']).includes(kind))))throw new DomainError('memory_read_disabled',409,'memory_read_disabled');}
      if(!ownsPreparation())throw new Error('native_preparation_cancelled');
      authorizeExecutionHistory(id);
      if(inputSource?.kind==='coordination'){
        if(coordination.deliveryPaused(id))throw new DomainError('receipt_delivery_paused',409,'Automatic receipt delivery paused');
        for(const receiptId of inputSource.receiptIds)tasks.authorizeReceiptDelivery({...root,agentId:before.agentId},receiptId,id);
      }
      if(messageOrigin)await validateMessageInput({id:queuedInputId!,conversationId:id,text:originalText,state:'running',createdAt:'',agentMessage:messageOrigin});
      if(!ownsPreparation())throw new Error('native_preparation_cancelled');
      memoryRuntime?.memory.validateReferences(memoryPrincipal,{projectId:before.projectId||null,items:[...inheritedMemory,...layered.map(({recordId,revision})=>({recordId,revision}))]});
    };
    const rejectChangedHistory = () => {
      if (!task || turnSubmitted) return false;
      const accepted = tasks.getContextSnapshot(root, task.id)!.sourceVersions;
      if (!knownSources(id).some(ref => !accepted.some(source => source.assetId === ref.assetId && source.versionId === ref.versionId))) return false;
      store.transaction(() => tasks.rejectQueuedRun(root, task.id, "native_history_changed"));
      current.durableRun = undefined;
      current.preparing = false;
      appendEvent(id, "metadata", { taskId: task.taskId, reason: "native_history_changed", nativeTurnSubmitted: false, requiresPreparation: true });
      state(id, "idle");
      return true;
    };
    const ownsPreparation = () => !closed && live.get(id)===current && current.runId===invocationId && current.preparing &&
      !current.controller.signal.aborted && !current.stopRequested && (!task || tasks.getRunControl(root,task.id).state==='starting');
    const queueCurrent=(reason:'directory'|'concurrency'|'background')=>{
      if(task)throw new Error('Execution admission changed before submission');
      current.preparing=false;current.admitted=false;current.directoryOwner=undefined;
      const input=queuedInputId?scheduler.listUserInputs(id).find(item=>item.id===queuedInputId)!:scheduler.enqueueUserInput(id,originalText,`directory:${invocationId}`,attachments.map(item=>item.id),references);
      if(queuedInputId){store.database.prepare("UPDATE task_user_inputs SET state='queued' WHERE id=?").run(queuedInputId);current.queuedInputId=undefined;}
      if(acceptedUserEvent)store.database.prepare("UPDATE events SET data=json_set(data,'$.queuedInputId',?) WHERE id=? AND conversationId=?").run(input.id,acceptedUserEvent.id,id);
      appendEvent(id,'metadata',{queuedInputId:input.id,state:'queued',reason,nativeTurnSubmitted:false});
      const waitingStatus=reason==='background'&&before.status==='interrupted'?'interrupted':'idle';
      if(chat(id).status!==waitingStatus&&!hasUnprovenNativeOccupancy(store,id)&&!store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id))state(id,waitingStatus);
      queueMicrotask(()=>{void wakeDirectories();});
    };
    try {
      // Preserve acceptance before config, staging or native preparation can fail.
      if(queuedInputId)acceptedUserEvent=store.listEvents(id,0).find(event=>event.kind==='user'&&(event.data as {queuedInputId?:string}).queuedInputId===queuedInputId);
      if (!task&&!acceptedUserEvent) acceptedUserEvent=appendEvent(id, "user", { text: originalText, ...(attachments.length ? { attachments } : {}),
        ...(references.length ? { references } : {}),
        ...(attachments.length ? {nativeText:attachmentText(originalText,attachments)} : {}), invocationId,
        ...(attachments.length?{fileScope:{agentId:before.agentId||undefined,projectId:before.projectId||undefined}}:{}),
        ...(queuedInputId ? { queuedInputId } : {}), ...(messageOrigin?{agentMessage:messageOrigin}:{}), ...(inputSource?{source:inputSource}:{}) });
      current.humanEventId=isHumanInput({task,agentMessage:messageOrigin,source:inputSource})?acceptedUserEvent?.id:undefined;
      if(current.humanEventId&&coordination.list().some(own=>own.conversationId===id))coordination.resumeDelivery(id);
      if(current.humanEventId)store.database.prepare("UPDATE events SET data=json_set(data,'$.invocationId',?) WHERE id=?").run(invocationId,current.humanEventId);
      if(attachments.length){
        const loaded:NativeAttachment[]=[],refs:VersionRef[]=[];
        for(const item of attachments){
          const origin=attachmentAssets.submittedOrigin(id,item.id,sourceId=>authorizeExecutionHistory(sourceId));
          const [attachment]=await loadAttachments(home,origin.conversationId,[item.id]);loaded.push(attachment);
          attachmentAssets.accept(root,origin.conversationId,[item.id],queuedInputId??invocationId,origin.scope);
          refs.push(...await attachmentAssets.resolve(root,origin.conversationId,[item.id],()=>{authorizeExecutionHistory(origin.conversationId);authorizeExecutionHistory(id);}));
        }
        for(const ref of refs)assets.getAuthorizedVersion(memoryPrincipal,ref);
        attachments=loaded;
        if(acceptedUserEvent)store.database.prepare("UPDATE events SET data=json_set(data,'$.attachments',json(?),'$.nativeText',?) WHERE id=? AND conversationId=?").run(JSON.stringify(loaded),attachmentText(originalText,loaded),acceptedUserEvent.id,id);
        appendEvent(id,'metadata',{attachmentFiles:refs,actualUse:'acknowledged',sourceVersions:refs});
      }
      text=attachmentText(text,attachments);
      const config = await loadConfig();
      assertExecutionAvailable(config,before);
      if(!ownsPreparation())return;
      if(inputSource?.kind==='coordination'){
        receiptSources=inputSource.receiptIds.flatMap(receiptId=>{
          const receipt=tasks.authorizeReceiptDelivery({...root,agentId:before.agentId},receiptId,id);
          return [...receipt.artifactVersions,...(receipt.sourceRunId?tasks.getContextSnapshot({...root,agentId:before.agentId},receipt.sourceRunId)?.sourceVersions??[]:[])];
        });
      }
      if(!ownsPreparation())return;
      if(!canAdmit(id,config)){queueCurrent('concurrency');return;}
      current.admitted=true;
      const primaryAgent = before.purpose === "mandala-main" && config.mandala?.agentId === before.agentId
        ? config.agents.find(a => a.id === before.agentId && a.systemRole === "mandala") : undefined;
      if (primaryAgent && (before.cli !== primaryAgent.defaultCli || before.model !== (primaryAgent.models[primaryAgent.defaultCli] || null))) {
        if (!enabledRuntimes(config).includes(primaryAgent.defaultCli)) throw new Error("Runtime disabled");
        const previousClient = current.client;
        current.client = undefined; current.verification = undefined; current.generation++;
        const patch = { cli:primaryAgent.defaultCli, nativeId:null, turnId:null, model:primaryAgent.models[primaryAgent.defaultCli] || null, effort:null, continuityPending:true };
        store.updateConversation(id, patch); Object.assign(before, patch);
        await previousClient?.close();
        if (!ownsPreparation()) return;
      }
      if (before.continuityPending) {
        const linkedGoals=mandalaContextBoundary(store,id)?[]:conversationGoals(id);
        const maintained=continuity.latest(id);
        const handoff=maintained?.status==='fallback'&&maintained.afterEventId===mandalaContextBoundary(store,id)&&maintained.goalIds.every(goalId=>linkedGoals.some(goal=>goal.id===goalId))?maintained.handoff+'\n'+mandalaContinuity(store,id,'maintenance',maintained.throughEventId,acceptedUserEvent?.id):mandalaContinuity(store,id,'runtime',0,acceptedUserEvent?.id);
        text = [handoff, linkedGoals.length ? "Associated goals (links or coordination ownership):\n" + JSON.stringify(linkedGoals) : "", (inputSource?"Current automatic input:\n":"Current user request:\n") + text].filter(Boolean).join("\n\n");
      }
      const selectedReferences = await resolveComposerReferences({ home, store, manager, config, principal: root, conversationId: id }, references);
      if (selectedReferences.context) text = [text, selectedReferences.context].filter(Boolean).join("\n\n");
      if(acceptedUserEvent){const data={...acceptedUserEvent.data as Record<string,unknown>,runId:invocationId,invocationId,...(references.length?{referenceItems:selectedReferences.items}:{}),...(text!==originalText?{nativeText:text}:{})};store.database.prepare('UPDATE events SET data=? WHERE id=? AND conversationId=?').run(JSON.stringify(data),acceptedUserEvent.id,id);}
      const skillConfig=skillCatalog?.resolve(config,before.agentId,before.projectId)??config;
      const executionContext=conversationContext(skillConfig,before,join(home||tmpdir(),'workspaces','conversations',id));
      if(!ownsPreparation())return;
      // A first connection can take a while (it may install the remote service), so the chat shows which machine it is reaching.
      const location=executionContext.executionLocation,connecting=!!location&&!remoteExecutions.has(id),machine=location?{machineName:location.machineName,host:location.host}:{};
      if(connecting)appendEvent(id,'metadata',{remoteConnection:'connecting',...machine});
      let remote:SshExecution|undefined;
      try{remote=await remoteFor(executionContext,id);}catch(error){if(connecting)appendEvent(id,'metadata',{remoteConnection:'failed',...machine});throw error;}
      if(connecting)appendEvent(id,'metadata',{remoteConnection:'connected',...machine});
      if(!ownsPreparation())return;
      if(remote){const directory=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:executionContext.project.cwd});if(!directory.isDirectory)throw new Error('Remote working directory is unavailable');executionContext.project.cwd=directory.realpath;}
      else if(before.purpose==='mandala-background'||!executionContext.workspace&&!before.cwd)await mkdir(executionContext.project.cwd,{recursive:true});
      current.codeGraphScope=remote?undefined:await codeGraph.capture(before,config);
      const extras=(await Promise.all(executionContext.project.resources.filter(r=>r.kind==='local').map(async r=>{if(remote){const directory=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:r.location}).catch(()=>null);return directory?.isDirectory?directory.realpath:null;}return (await stat(r.location).catch(()=>null))?.isDirectory()?r.location:null;}))).filter((p):p is string=>!!p);
      let executionAttachments=attachments;
      if(remote&&attachments.length){executionAttachments=await Promise.all(attachments.map(async item=>({...item,path:await remote.uploadAttachment(item.path,item.id)})));for(let index=0;index<attachments.length;index++)text=text.split(attachments[index].path).join(executionAttachments[index].path);if(acceptedUserEvent)store.database.prepare("UPDATE events SET data=json_set(data,'$.nativeText',?) WHERE id=? AND conversationId=?").run(text,acceptedUserEvent.id,id);}
      const configuredAgent=config.agents.some(a=>a.id===before.agentId);
      const outputDirectory=home&&(task||configuredAgent)?task?join(home,'outputs',task.id):join(home,'outputs','conversations',id,invocationId):undefined;
      if(outputDirectory)await mkdir(outputDirectory,{recursive:true});
      // Queued inputs and actual invocations claim the same stable conversation output root.
      const claimedOutputRoot=outputDirectory?task?outputDirectory:join(home,'outputs','conversations',id):undefined;
      const roots=[executionContext.project.cwd,...extras,...(claimedOutputRoot?[claimedOutputRoot]:[])];
      const executionRoots=[executionContext.project.cwd,...extras,...(outputDirectory?[outputDirectory]:[])];
      if(!ownsPreparation())return;
      if(resources.claim(owner,roots,'write')==='queued'){queueCurrent('directory');return;}
      appendEvent(id, "metadata", { execution: "started" });
      state(id, "running");
      if(before.completedAt) store.updateConversation(id,{completedAt:before.completedAt});
      authorizeExecutionHistory(id);
      if(memoryRuntime){
        const history=memoryRuntime.memory.history(memoryPrincipal,{projectId:before.projectId||null,items:memoryHistoryReferences(store,id,mandalaContextBoundary(store,id))});
        inheritedMemory=history.items.map(item=>({...item,reason:'inherited_native_history'}));memoryNotices=history.notices;
        memoryContextInstructions=buildMemoryContext({profile:null,facts:[],scenes:[],query:memoryQuery,notices:memoryNotices}).instructions;
      }
      if (rejectChangedHistory()){resources.releaseUnsubmitted(owner.kind,owner.id);queueMicrotask(()=>{void wakeDirectories();});return;}
      const { project, agent, workspace } = executionContext;
      if (!workspace && !before.cwd) await mkdir(project.cwd, { recursive: true });
      let memory: Awaited<ReturnType<typeof recallMemory>>;
      try {
        memory = task ? { entries: [], instructions: "", truncated: false } : await recallMemory(home, { projectId: project.id, agentId: agent.id, query: text, documentIds: [...(project.knowledgeIds ?? []), ...(agent.knowledgeIds ?? [])] }, store);
      } catch {
        memoryReadFailed = true;
        memoryTrace = { memoryRecall: randomUUID(), count: 0, entryIds: [] };
        throw new Error("Cannot load confirmed memory; check the MANA library and retry this turn.");
      }
      if(memoryRuntime) {
        try {
          const kinds=await memoryRuntime.reading(memoryPrincipal),projectId=before.projectId||null;
          const factResult=kinds.length&&recallPlan.query?await memoryRuntime.recall.contextSearch(memoryPrincipal,{projectId,query:memoryQuery,layers:['L1'],kinds}):undefined;
          const facts=factResult?.items??[];
          const profile=kinds.includes('request')?memoryRuntime.profiles.current(memoryPrincipal,{projectId,agentId:before.agentId||null}):null;
          const stableContext=profile?[{...profile,reason:'current_profile'}]:[];
          const sceneResult=kinds.includes('request')&&recallPlan.query?await memoryRuntime.recall.contextSearch(memoryPrincipal,{projectId,query:memoryQuery,layers:['L2'],kinds:['request']}):undefined;
          const scenes=sceneResult?.items??[];
          if(factResult?.degraded||sceneResult?.degraded)store.appendEvent(id,"metadata",{memorySearch:"degraded",message:"本地语义索引不可用或构建中，本轮保留BM25检索",indexLag:(factResult?.indexLag??0)+(sceneResult?.indexLag??0)});
          const currentKinds=await memoryRuntime.reading(memoryPrincipal);
          const readable=(r:MemoryHit)=>currentKinds.some(kind=>(r.pipelines??['request']).includes(kind));
          const corrections=currentKinds.length?[...new Set(memoryNotices.filter(notice=>notice.status==='corrected').map(notice=>notice.recordId))].map(recordId=>({...memoryRuntime.memory.read(memoryPrincipal,recordId,projectId),reason:'corrected_history'})).filter(readable):[];
          const context=buildMemoryContext({profile:stableContext.find(readable)??null,facts:[...corrections,...facts].filter(readable),scenes:scenes.filter(readable),query:memoryQuery,notices:memoryNotices});
          layered=context.items;memoryContextInstructions=context.instructions;
        }
        catch { store.appendEvent(id,"metadata",{memoryUse:"unavailable",message:"本轮未使用记忆"}); }
      }
      if(!ownsPreparation())return;
      current.sourceVersions = [...new Map([...knownSources(id), ...(!task&&configuredAgent?boundFileVersions(project.id,agent.id):[]), ...(task ? tasks.getContextSnapshot(root, task.id)!.sourceVersions : memory.entries.flatMap(entry => entry.assetId && entry.versionId ? [{assetId:entry.assetId,versionId:entry.versionId}] : []))].map(ref=>[ref.versionId,ref])).values()];
      if (memory.entries.length || current.loadedMemoryCount) {
        memoryTrace = { memoryRecall: randomUUID(), count: memory.entries.length, entryIds: memory.entries.map((entry) => entry.id), entries: memory.entries.map(({ title, kind, assetId, versionId }) => ({ title, kind, ...(assetId ? { assetId, versionId } : {}) })) };
        appendEvent(id, "metadata", { ...memoryTrace, status: "running" });
      }
      if(layered.length) {
        memoryTrace={memoryRecall:memoryTrace?.memoryRecall??randomUUID(),count:memory.entries.length+layered.length,entryIds:[...memory.entries.map(e=>e.id),...layered.map(e=>e.recordId)],entries:[...memoryTrace?.entries??[],...layered.map(e=>({title:e.text.split("\n")[0].slice(0,160),kind:"memory",recordId:e.recordId,revision:e.revision,reason:e.reason}))]};
        appendEvent(id,"metadata",{...memoryTrace,status:"running"});
      }
      const outputRoot = outputDirectory;
      if (outputRoot) {
        if(!ownsPreparation())return;
        const boundRunId = invocationId, boundAgentId=agent.id, boundProjectId=project.id;
        if(!task)store.database.prepare('INSERT INTO file_execution_scopes VALUES (?,?,?,?,?)').run(invocationId,root.userId,boundAgentId,boundProjectId||null,id);
        const token=current.toolToken!;
        current.artifacts = createRunArtifacts({store,files,assets,principal:{...root,agentId:boundAgentId,runId:boundRunId},outputRoot,sourceVersions:[...(current.sourceVersions??[]),...receiptSources],maintenanceUpdate:args=>fileMaintenance.updateGate({...root,agentId:boundAgentId,runId:boundRunId},boundProjectId||null,args),async assertActive() {
          const config=await loadConfig();
          if (live.get(id) !== current || current.runId!==boundRunId || !current.invocation || current.stopRequested || current.controller.signal.aborted || tools.get(token)?.invocationId!==boundRunId || chat(id).agentId!==boundAgentId || chat(id).projectId!==before.projectId || !config.agents.some(a=>a.id===boundAgentId) || boundProjectId&&!isSystemAgent(config,boundAgentId)&&!config.projects.find(p=>p.id===boundProjectId)?.agentIds.includes(boundAgentId) || task&&(current.durableRun?.id !== boundRunId || !["running","approval"].includes(store.database.prepare("SELECT state FROM task_runs WHERE id=?").get(boundRunId)?.state as string))) throw new DomainError("forbidden",403,"File execution is not active");
        }});
      } else current.artifacts = undefined;
      const runtimePolicy = executionRuntimePolicy(before.cli, agent, config.runtimeDefaults);
      const runtimeConfig = runtimeOptions(before.cli,executionContext,config);
      let cliInstructions = "";
      let nativeOutputRoot=outputRoot;
      {
        const token = current.toolToken!;
        const invoke=(data:{command:string;args:Record<string,unknown>;commandKey:string})=>invokeBusinessCli(manager,{headers:{authorization:`Bearer ${token}`}} as IncomingMessage,data,name=>findCommand(name)?.boundTool);
        const codexSandbox = before.cli === "codex" && runtimeConfig.fullAccess === false;
        const codexCapabilitiesFile = codexSandbox && process.platform === "win32"
          ? resolve(project.cwd, process.env.CODEX_HOME || join(homedir(), ".codex"), "cap_sid") : undefined;
        const cli = remote ? await remote.prepareBusiness(invocationId,async data=>{
          if(outputRoot&&(data.command==='assets publish'||data.command==='assets update')){
            const paths=data.command==='assets publish'?Array.isArray(data.args.files)?data.args.files.map(file=>(file as {path?:unknown})?.path):[]:[data.args.path];
            if(paths.length>100)throw new DomainError('invalid_artifact_tool',422,'Too many output files');
            for(const path of paths){if(typeof path!=='string'||!path||path.length>4096||isAbsolute(path)||/[\\\x00-\x1f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new DomainError('invalid_artifact_tool',422,'Invalid output path');await remote.downloadOutput(invocationId,path,join(outputRoot,path));}
          }
          return invoke(data);
        }) : await createBusinessCliRuntime(home, invocationId, {
          baseUrl: `http://127.0.0.1:${productEnv('PORT') ?? 4317}`, token,
        }, codexSandbox ? invoke : undefined, undefined, codexCapabilitiesFile);
        if (!ownsPreparation()) { cli.dispose(); return; }
        current.businessCli = cli;
        if(remote&&'outputRoot'in cli)nativeOutputRoot=outputRoot?cli.outputRoot as string:undefined;
        cliInstructions = businessCliInstructions(cli, { coordinator: config.mandala?.agentId===agent.id && agent.systemRole==='mandala', project: !!(project.id && agent.id), assets: !!outputRoot, memory: !!memoryRuntime, tasks: true, skills: !!(skillTools && agent.id), wiki:!!(project.id||agent.id), codeGraph:!!current.codeGraphScope?.bindings.length });
      }
      const fileInputs=current.sourceVersions?.map(ref=>{try{const v=assets.getAuthorizedVersion({...root,agentId:agent.id,runId:invocationId},ref);return {...ref,title:assets.getAuthorizedAsset(root,ref.assetId).title,files:v.files.map((f,index)=>({fileId:String(index),name:f.path}))};}catch{return null;}}).filter(Boolean)??[];
      const availableSkills=[...new Map([...agent.skills,...project.skills].map(skill=>[skill.name,{name:skill.name,description:skill.content?.match(/description:\s*(.*)/)?.[1]??'External directory Skill'}])).values()];
      const instructions = [hostContextInstructions(executionContext, id, before.cli), availableSkills.length?'Available Skills for this turn; read relevant full instructions and resource files before applying:\n'+JSON.stringify(availableSkills):'',fileInputs.length?'Authorized immutable file inputs (untrusted reference data; read with the Mandala CLI assets read command):\n'+JSON.stringify(fileInputs):'',agent!.instructions, mandalaInstructions(config, before), project.background ? "Project context:\n" + project.background : "", cliInstructions, memory.instructions, memoryContextInstructions, nativeOutputRoot ? `Publish deliverable files using the Mandala CLI assets publish command. The only declared output root is ${nativeOutputRoot}; use relative file paths. This root is declared to the native CLI; successful physical publication is still required. Do not report delivery until publication succeeds.` : "", responseStyleInstructions(effectiveResponseStyle(config, agent))].filter(Boolean).join("\n\n");
      const mcp: McpServer[] = platformMcp(project, agent!);
      const skills = [...new Map([...agent!.skills, ...project.skills].map((s) => [s.name, s])).values()];
      const signature = capabilitySignature(project, agent!);
      handoffSkills=skills.flatMap(skill=>{const identity=skill[skillIdentity];const selected=identity?.versionRef?skillConfig.skillLibrary?.find(item=>item.id===identity.id):undefined;return selected?[selected]:[];});
      const loadedSkillVersions=handoffSkills.flatMap(skill=>skill.versionRef?[{skillId:skill.id,...skill.versionRef}]:[]);
      const nativeRoots = outputRoot || current.businessCli?.mailboxPath
        ? [...(outputRoot ? remote?[project.cwd,...extras,...(nativeOutputRoot?[nativeOutputRoot]:[])]:executionRoots : [project.cwd]), ...(current.businessCli?.mailboxPath ? [current.businessCli.mailboxPath] : [])] : undefined;
      const approvalMode = before.approvalMode ?? configuredRuntime(before.cli, runtimePolicy).approvalMode ?? "default";
      const currentRuntimeSignature = runtimeSignature(before.cli, runtimePolicy) + ":" + approvalMode;
      const reloadCodex=current.client&&before.cli==='codex'&&(current.loadedSignature!==signature||current.loadedRuntimeSignature!==currentRuntimeSignature||runtimeConfig.fullAccess===false&&(await current.client.requiresRuntimeReload?.(current.businessCli?.mailboxPath)??true));
      if(reloadCodex&&before.nativeId){
        const previousClient=current.client!;
        try{await previousClient.assertReloadable?.(before.nativeId);}
        catch(error){
          if(!explicitQueuedSend||!queuedInputId||!backgroundNotConfirmed(error))throw error;
          if(!ownsPreparation())return;
          resources.releaseUnsubmitted(owner.kind,owner.id);
          queueCurrent('background');
          waitForQueuedBackground(id,queuedInputId,previousClient,before.nativeId);
          return;
        }
      }
      if (current.client && (before.cli !== "codex" && (current.loadedSignature !== signature || current.loadedInstructions !== instructions || current.loadedToolToken !== current.toolToken) ||
          reloadCodex || current.loadedRuntimeSignature !== currentRuntimeSignature)) {
        current.generation++;
        const previousClient=current.client;
        current.client = undefined;
        current.verification = undefined;
        // Loaded Codex threads ignore new permission profiles and MCP configuration.
        if(remote){
          if(!await remote.request<boolean>('runtime.release',{runtimeId:id}))throw new DomainError('native_background_active',409,'Remote work must settle before changing its runtime.');
          clients.delete(previousClient);
        }else await previousClient.close();
        if(!ownsPreparation())return;
      }
      if (!current.client) {
        const generation = ++current.generation;
        current.usage=createUsageRecorder(store);
        current.loadedSignature = signature;
        current.loadedRuntimeSignature = currentRuntimeSignature;
        const capabilityRoot = before.cli === "omp" || skills.length
          ? remote?await remote.prepareCapabilities(id,mcp,skills,instructions):await prepareCapabilityRuntime(home, id, mcp, skills, instructions, validateHandoff) : "";
        const nativeInstructions=skills.length&&before.cli!=='codex'&&before.cli!=='omp'
          ? instructions+'\n\nBound Skill files: read the relevant full SKILL.md and referenced files before applying the Skill.\n'+JSON.stringify(skills.map(skill=>({name:skill.name,path:join(capabilityRoot,'skills',skill.name,'SKILL.md')}))) : instructions;
        const accessibleDirs = extras;
        if(!ownsPreparation())return;
        current.approvalScope={conversationId:id,agentId:before.agentId,projectId:before.projectId,cli:before.cli,cwd:remote?project.cwd:realpathSync(project.cwd),hostId:executionContext.executionLocation?.host};
        const callbacks = {
          cwd: project.cwd,
          model:before.model??config.chatDefaults?.[before.cli]?.model,
          ...runtimeConfig,
          signal: AbortSignal.any([lifetime.signal, current.controller.signal]),
          onEvent(event: RpcMessage) {
            if (closed || live.get(id) !== current || current.generation !== generation) return;
            if(continuity.event(id,event)){if(event.method==='thread/tokenUsage/updated'&&!current.invocation)current.usage?.event(event);return;}
            const p = event.params ?? {};
            const c = chat(id);
            if (p.threadId && c.nativeId && p.threadId !== c.nativeId) return;
            if(event.method?.startsWith('mandala/usage')||event.method?.startsWith('openmana/usage')||event.method==='thread/tokenUsage/updated') {current.usage?.event(event);return;}
            // Item IDs are scoped to a native turn, not merely to its session.
            if(event.method?.startsWith('item/')&&
              (!current.invocation||!current.invocation.nativeTurnId||p.threadId!==current.invocation.nativeSessionId||p.turnId!==current.invocation.nativeTurnId)){
              store.appendEvent(id,'metadata',{execution:'item_ignored',correlation:'unknown',nativeSessionId:p.threadId,nativeTurnId:p.turnId});return;
            }
            const hook = normalizeHookEvent(before.cli, event.method, p);
            if (hook) {
              appendEvent(id, "hook", hook);
              return;
            }
            if (event.method === "serverRequest/resolved") {
              const resolvedApprovalIds:string[]=[];
              for (const [key, approval] of current.approvals)
                if (approval.nativeRequestId === p.requestId) {
                  current.approvals.delete(key);
                  resolvedApprovalIds.push(key);
                }
              if (resolvedApprovalIds.length) appendEvent(id,"metadata",{resolvedRequestId:p.requestId,resolvedApprovalIds});
              if (resolvedApprovalIds.length && c.status === "approval")
                state(id, hasBlockingApprovals(current.approvals.values()) ? "approval" : "running");
              return;
            }
            if (event.method === "turn/started") {
              const invocation = current.invocation;
              if (!invocation || invocation.generation !== generation || p.threadId !== invocation.nativeSessionId ||
                  typeof p.turn?.id !== "string" ||
                  (invocation.nativeTurnId !== null && invocation.nativeTurnId !== p.turn.id) ||
                  (invocation.nativeTurnId === null && current.completedTurns?.has(p.turn.id))) return;
              invocation.nativeTurnId = p.turn.id;
              current.usage?.event(event);
              if (c.completedAt) store.completeConversation(id,false);
              if(current.directoryOwner)resources.bindTurn(current.directoryOwner.kind,current.directoryOwner.id,invocation.invocationId,invocation.nativeSessionId,p.turn.id);
              if (current.durableRun) bindNative(id,current.durableRun,invocation.nativeSessionId,p.turn.id);
              if (current.queuedInputId) {scheduler.bindInputInvocation(current.queuedInputId,invocation.invocationId,invocation.nativeSessionId,p.turn.id);messages.started(current.queuedInputId);}
              current.activeTurnId = p.turn.id;
              store.updateConversation(id, { turnId: p.turn.id });
              if (current.stopRequested)
                void current.client
                  ?.interrupt(c.nativeId!, p.turn.id)
                  .catch(() => { /* The bounded stop handles an unresponsive CLI. */ });
            }
            if (event.method === "item/agentMessage/delta")
              appendEvent(id, "text", {
                text: p.delta,
                itemId: p.itemId,
                turnId: p.turnId,
              });
            else if (event.method === "turn/completed") {
              const invocation = current.invocation;
              if (!invocation || invocation.invocationId !== current.runId || invocation.conversationId !== id ||
                  invocation.generation !== generation || p.threadId !== invocation.nativeSessionId ||
                  invocation.nativeTurnId === null || p.turn?.id !== invocation.nativeTurnId) {
                store.appendEvent(id, "metadata", { execution: "terminal_ignored", correlation: "unknown",
                  nativeSessionId: p.threadId, nativeTurnId: p.turn?.id });
                return;
              }
              (current.completedTurns ??= new Set()).add(invocation.nativeTurnId);
              if(current.directoryOwner){
                resources.confirmTerminal(current.directoryOwner.kind,current.directoryOwner.id,{...invocation,nativeTurnId:invocation.nativeTurnId});
                if(current.directoryOwner.kind!=='invocation')store.database.prepare('DELETE FROM task_native_uncertainty WHERE kind=? AND claim_id=?').run(current.directoryOwner.kind,current.directoryOwner.id);
              }
              queueMicrotask(()=>{void wakeDirectories();});
              current.invocation = undefined;
              revokeBusinessCli(current);
              appendEvent(id, "tool", { method: event.method, params: p });
              current.approvals.clear();
              current.activeTurnId = undefined;
              store.updateConversation(id, { turnId: null });
              const status =
                current.stopRequested || p.turn.status === "interrupted"
                  ? "interrupted"
                  : p.turn.status === "failed"
                    ? "error"
                    : "idle";
              if (p.turn.error)
                store.appendEvent(id, "error", {
                  message: p.turn.error.message,
                });
              if (before.cli !== "codex") {
                // OMP and ACP notifications have no per-prompt event identity; retire this process before another invocation.
                current.generation++;
                const client = current.client;
                current.client = undefined;
                current.verification = undefined;
                client?.close();
              }
              state(id, status);
              current.finishStop?.();
              finishTask(id, status === "idle");
              if (status === "idle") {
                const events=store.listEvents(id,0),user=events.filter(e=>e.kind==='user'&&(e.data as {runId?:string}).runId===invocation.invocationId).at(-1);
                const reply=invocationAnswer(id,invocation.invocationId,true),userText=(user?.data as {text?:string})?.text;
                const sourceEvent=events.filter(e=>e.kind==='status'&&(e.data as {status?:string}).status==='idle').at(-1);
                const round=userText?.trim()&&reply&&sourceEvent?{sourceEventId:sourceEvent.id,user:userText,reply}:undefined;
                void skillLearning?.capture(id,/沉淀|整理.*技能|(?:save|register|distill).{0,30}skill/i.test(userText??'')).then(()=>skillLearning.drain()).catch(()=>{});
                onSettled?.(id,round);
              }
            } else if (event.method === "error")
              store.appendEvent(id, "error", {
                message: p.error?.message ?? "CLI error",
              });
            else {
              appendEvent(id, "tool", {
                method: event.method,
                params: p,
              });
              if(event.method==='item/completed'&&p.item?.type==='agentMessage')
                appendEvent(id,'metadata',{questionFormsUpdated:p.item.id});
            }
          },
          onApproval(request: RpcMessage) {
            if (closed || live.get(id) !== current || current.generation !== generation ||
                request.id === undefined || !request.method) return;
            const invocation=current.invocation;
            if(!invocation||invocation.invocationId!==current.runId||invocation.conversationId!==id||invocation.generation!==generation)return;
            const c = chat(id),
              p = request.params ?? {};
            if(current.stopRequested||typeof p.turnId==='string'&&current.completedTurns?.has(p.turnId))return;
            if (
              p.threadId !== c.nativeId ||
              (c.turnId && p.turnId !== c.turnId && !(request.method === "mcpServer/elicitation/request" && p.turnId == null))
            )
              return;
            const approval: Approval = {
              id: randomUUID(),
              conversationId: id,
              nativeRequestId: request.id,
              method: request.method,
              params: p,
            };
            approval.conversationApproval = approvalMode !== "strict" && supportsConversationApproval(approval);
            if (approval.conversationApproval && invocation.nativeTurnId !== null &&
                (p.turnId === invocation.nativeTurnId || approval.method === "mcpServer/elicitation/request" && p.turnId == null) &&
                current.client && current.approvalScope && conversationApprovals.has(current.approvalScope)) {
              current.client?.replyApproval(approval.nativeRequestId,nativeApprovalResponse(approval,"approve"));
              appendEvent(id,"metadata",{approval:"conversation_authorization",method:approval.method});
              return;
            }
            current.approvals.set(approval.id, approval);
            appendEvent(id, "approval", approval);
            if (request.method !== "item/tool/requestUserInput" || p.isBlocking !== false) state(id, "approval");
          },
          onExit(reason: string) {
            if (closed || live.get(id) !== current || current.generation !== generation) return;
            if(continuity.disconnected(id)){current.client=undefined;return;}
            revokeBusinessCli(current);
            current.client = undefined;
            current.preparing = false;
            if(current.directoryOwner)resources.releaseUnsubmitted(current.directoryOwner.kind,current.directoryOwner.id);
            current.approvals.clear();
            store.appendEvent(id, "error", { message: reason });
            state(id, "interrupted",'native_disconnected');
            current.finishStop?.();
            if(current.durableRun){tasks.markUnknown(current.durableRun.id);current.durableRun=undefined;}
            if(current.queuedInputId){messages.finish(current.queuedInputId,'unknown','');scheduler.reconcileInput(current.queuedInputId,false);current.queuedInputId=undefined;}
          },
        };
        await validateHandoff();
        if(!ownsPreparation())return;
        current.client = before.cli === "omp"
          ? await startClient(before.cli,{ ...callbacks, validateHandoff, resume: before.nativeId ?? undefined,
              instructions: instructions ? join(capabilityRoot, "instructions.md") : undefined,
              model: before.model ?? undefined,
              directories: [...accessibleDirs, ...(nativeOutputRoot ? [nativeOutputRoot] : [])],
              pluginDir: capabilityRoot, approvalMode },executionContext,id,config)
          : await startClient(before.cli,callbacks,executionContext,id,config);
        if (closed || live.get(id) !== current || current.controller.signal.aborted) {
          await current.client.close();
          current.client = undefined;
          if (closed) throw new Error("service closed");
          return;
        }
        if (before.cli === "codex" && skills.length)
          await current.client.setSkillRoots?.([join(capabilityRoot, "skills")]);
        if(!ownsPreparation())return;
        await validateHandoff();
        if(!ownsPreparation())return;
        if (before.nativeId) {
          if (before.cli !== "omp") await current.client.resumeThread(before.nativeId, mcp, nativeInstructions, before.model ?? undefined, nativeRoots, current.businessCli?.mailboxPath);
        }
        else {
          const nativeId = await current.client.startThread({
            cwd: project.cwd,
            ...(nativeRoots?{runtimeWorkspaceRoots:nativeRoots}:{}),
            ...(current.businessCli?.mailboxPath ? { runtimeMailboxPath: current.businessCli.mailboxPath } : {}),
            instructions:nativeInstructions,
            model: before.model ?? undefined,
            mcp,
          });
          if(!ownsPreparation())return;
          store.updateConversation(id, { nativeId });
        }
      } else {
        if (current.loadedSignature !== signature || current.loadedInstructions !== instructions || current.loadedToolToken !== current.toolToken) {
          if (before.cli === "codex") {
            if (current.loadedSignature !== signature) {
              const capabilityRoot = remote?await remote.prepareCapabilities(id,mcp,skills,instructions):await prepareCapabilityRuntime(home, id, mcp, skills, instructions, validateHandoff);
              if(!ownsPreparation())return;
              await current.client.setSkillRoots?.(skills.length ? [join(capabilityRoot, "skills")] : []);
            }
          }
          if(!ownsPreparation())return;
          await validateHandoff();
          if(!ownsPreparation())return;
          await current.client.resumeThread(before.nativeId!, mcp, instructions, before.model ?? undefined, nativeRoots, current.businessCli?.mailboxPath);
          current.loadedSignature = signature;
        }
      }
      if (closed) throw new Error("service closed");
      if (!ownsPreparation()) return;
      current.loadedToolToken = current.toolToken;
      current.loadedInstructions = instructions;
      current.loadedMemoryCount = memory.entries.length;
      if (memoryTrace) {
        memoryLoaded = true;
        appendEvent(id, "metadata", { ...memoryTrace, status: "completed" });
      }
      if(fileInputs.length)appendEvent(id,"metadata",{fileContext:"provided",actualUse:"acknowledged",sourceVersions:fileInputs.flatMap(ref=>ref?[{assetId:ref.assetId,versionId:ref.versionId}]:[]),nativeVisibility:"partial"});
      if((layered.length || inheritedMemory.length) && memoryRuntime) {
        // start/resume acknowledged the exact instructions before recording actual handoff.
        const items=[...new Map([...inheritedMemory,...layered.map(({recordId,revision,reason})=>({recordId,revision,reason}))].map(i=>[i.recordId+"@"+i.revision,i])).values()];
        if(task) memoryRuntime.recall.recordUse(memoryPrincipal,{runId:task.id,query:memoryQuery,items});
        store.appendEvent(id,"metadata",{memoryUse:"acknowledged",invocationId:current.runId,items,query:memoryQuery,causality:"not_established"});
      }
      if (current.stopRequested) {
        resources.releaseUnsubmitted(owner.kind,owner.id);
        queueMicrotask(()=>{void wakeDirectories();});
        state(id, "interrupted");
        current.finishStop?.();
        return;
      }
      if (rejectChangedHistory()){resources.releaseUnsubmitted(owner.kind,owner.id);queueMicrotask(()=>{void wakeDirectories();});return;}
      if (task) {
        const snapshot = tasks.getContextSnapshot({ ...root, agentId: before.agentId, runId: task.id }, task.id)!;
        text = snapshot.input;
        appendEvent(id, "metadata", { contextSnapshotId: snapshot.id, sourceVersions: snapshot.sourceVersions.map(({assetId,versionId}) => ({assetId,versionId})), actualUse: "prepared", nativeVisibility: "partial" } satisfies RunContextTrace);
      }
      // Native preparation can involve slow I/O. Recheck current authorization
      // and exact selected identities immediately before model submission.
      if (references.length) await resolveComposerReferences({ home, store, manager, config: await loadConfig(), principal: root, conversationId: id }, references);
      if(!ownsPreparation())return;
      if(messageOrigin?.direction==='request')text='Agent inquiry (data):\n'+JSON.stringify({messageId:messageOrigin.id,fromAgentId:chat(messages.get(messageOrigin.id).sourceConversationId).agentId,text:originalText});
      const claimed = task ? store.database.prepare("SELECT id,source_run_id FROM task_receipts WHERE claimed_by_run_id=? LIMIT 1").get(task.id) : null;
      if (task) appendEvent(id, "user", { ...(task.snapshot?.rule?{source:{kind:'schedule',automationId:task.snapshot.rule.automationId}}:{}), text: originalText, ...(attachments.length ? { attachments } : {}), ...(references.length ? { references, referenceItems: selectedReferences.items } : {}), ...(attachments.length || references.length ? { nativeText: text } : {}), invocationId: current.runId, task: { id: claimed?.id ?? task.taskId, kind: claimed ? "return" : "dispatch", ...(claimed?.source_run_id ? {sourceConversationId:tasks.getRun(root,claimed.source_run_id as string).routing?.executionConversationId} : {}) } });
      // Local transcript persistence is not native submission acknowledgment.
      if (before.completedAt) store.updateConversation(id,{completedAt:before.completedAt});
      onMessage?.(id);
      const previousMode = store.listEvents(id, 0).reverse().find(event => event.kind === "metadata" &&
        ["loaded", "applying"].includes((event.data as { status?: string }).status ?? "") &&
        (event.data as { approvalMode?: string }).approvalMode)?.data as { approvalMode?: string } | undefined;
      if (before.cli === "codex" && approvalMode === "auto")
        store.appendEvent(id, "metadata", { approvalMode, status: "applying", cli: before.cli });
      const invocation: ActiveInvocation = { invocationId: current.runId!, conversationId: id,
        nativeSessionId: chat(id).nativeId!, nativeTurnId: null, generation: current.generation };
      current.invocation = invocation;
      current.usage?.begin({executionId:invocation.invocationId,category:task?'task':'conversation',cli:before.cli,model:before.model,projectId:before.projectId||null,agentId:before.agentId||null,conversationId:id,...(task?{taskId:task.taskId,runId:task.id}:{})});
      submittedInvocation = invocation;
      if(queuedInputId) scheduler.bindInputInvocation(queuedInputId,invocation.invocationId,invocation.nativeSessionId,null);
      const turnOptions = { model: before.model ?? undefined, effort: before.effort ?? undefined, images: executionAttachments.filter(item => item.mimeType.startsWith("image/")).map(({path,mimeType}) => ({path,mimeType})) };
      // Capability/model/file checks must fail before native occupancy becomes durable.
      await current.client.prepareTurn?.(invocation.nativeSessionId, turnOptions);
      await validateHandoff();
      if(!ownsPreparation())return;
      if(queuedInputId&&!messages.eligible({id:queuedInputId,conversationId:id,text:originalText,state:'running',createdAt:''}))throw new Error('message_stopped');
      if(inputSource?.kind==='coordination'){
        // Stage report dependencies only at the validated submission boundary. They
        // must not contaminate native instructions while the input is still retryable.
        current.sourceVersions=[...new Map([...(current.sourceVersions??[]),...receiptSources].map(ref=>[ref.versionId,ref])).values()];
        appendEvent(id,'metadata',{actualUse:'acknowledged',sourceVersions:receiptSources,receiptContext:true,receiptIds:inputSource.receiptIds,queuedInputId,invocationId});
      }
      resources.submitted(owner.kind,owner.id,invocation.invocationId,invocation.nativeSessionId);
      if(owner.kind!=='invocation')retainNativeOccupancy(store,owner.kind,owner.id,id);
      current.preparing = false;
      turnSubmitted = true;
      const turnId = await current.client.startTurn(invocation.nativeSessionId, text,
        before.cli === "codex" ? approvalMode === "strict" ? "strict" : approvalMode === "auto" ? "auto" : previousMode?.approvalMode === "auto" || previousMode?.approvalMode === "strict" ? "default" : undefined : before.cli === "omp" ? undefined : approvalMode,
        before.cli === "codex" ? nativeRoots : undefined,
        turnOptions);
      if (live.get(id) !== current || current.controller.signal.aborted || current.invocation !== invocation ||
          current.generation !== invocation.generation) return;
      appendEvent(id,'metadata',{skillVersions:loadedSkillVersions,actualUse:'provided',nativeVisibility:'partial',skillInventory:skills.map(skill=>({name:skill.name,description:skill.content?.match(/description:\s*(.*)/)?.[1]??''}))});
      if(before.completedAt)store.completeConversation(id,false);
      store.appendEvent(id, "metadata", { approvalMode, model: before.model, effort: before.effort, status: "loaded", cli: before.cli });
      if (invocation.nativeTurnId !== null && invocation.nativeTurnId !== turnId)
        throw new Error("Native turn identity does not match start response");
      if (before.continuityPending) store.updateConversation(id, {continuityPending:false});
      invocation.nativeTurnId = turnId;
      current.usage?.bind(invocation.nativeSessionId,turnId);
      resources.bindTurn(owner.kind,owner.id,invocation.invocationId,invocation.nativeSessionId,turnId);
      if (task) bindNative(id,task,invocation.nativeSessionId,turnId);
      if(queuedInputId) {scheduler.bindInputInvocation(queuedInputId,invocation.invocationId,invocation.nativeSessionId,turnId);messages.started(queuedInputId);}
      void verify(current, chat(id).nativeId!, project.cwd);
      if (chat(id).status === "running" || chat(id).status === "approval")
        store.updateConversation(id, { turnId });
      // Requests can arrive before startTurn acknowledges the native turn.
      // Replay only after binding, through the same validation as a manual approval.
      if(current.approvalScope && conversationApprovals.has(current.approvalScope))
        for(const approval of [...current.approvals.values()]) {
          if(!conversationApprovals.has(current.approvalScope))break;
          const params=approval.params as {turnId?:string|null};
          if(approval.conversationApproval && (params.turnId===turnId || approval.method==='mcpServer/elicitation/request'&&params.turnId==null))
            await manager.approve(id,approval.id,'approve');
        }
    } catch (e) {
      if (submittedInvocation && (current.invocation !== submittedInvocation ||
          current.generation !== submittedInvocation.generation)) return;
      if (closed) throw new Error("service closed");
      if (live.get(id) !== current || current.controller.signal.aborted) return;
      const error = e as Error;
      const reloadBlocked=backgroundNotConfirmed(error)&&!turnSubmitted;
      const recoveredReceipt=!turnSubmitted&&!!current.queuedInputId&&scheduler.recoverReceiptInput(current.queuedInputId,invocationId);
      if(recoveredReceipt)current.queuedInputId=undefined;
      revokeBusinessCli(current);
      if(!turnSubmitted){resources.releaseUnsubmitted(owner.kind,owner.id);queueMicrotask(()=>{void wakeDirectories();});}
      if (memoryTrace && !memoryLoaded) appendEvent(id, "metadata", { ...memoryTrace, status: "failed",
        message: memoryReadFailed ? error.message : "CLI did not acknowledge memory instructions; retry this turn." });
      appendEvent(id, "error", { message: error.message, nativeTurnSubmitted: turnSubmitted,
        ...(reloadBlocked?{code:(error as DomainError).code}:/already has an active writer/i.test(error.message)?{code:'native_thread_busy'}:{}) });
      if (current.queuedInputId && !turnSubmitted && error instanceof DomainError && ["reference_changed", "invalid_references"].includes(error.code)) {
        scheduler.rejectUnsubmittedInput(current.queuedInputId);
        current.queuedInputId = undefined;
      }
      if(current.queuedInputId && turnSubmitted){messages.finish(current.queuedInputId,'unknown','');scheduler.reconcileInput(current.queuedInputId,false);current.queuedInputId=undefined;}
      if(reloadBlocked){
        if(current.queuedInputId){finishMessageInput(current.queuedInputId,'failed',error.message);scheduler.rejectUnsubmittedInput(current.queuedInputId,(error as DomainError).code as 'native_background_active'|'native_background_check_failed');current.queuedInputId=undefined;}
        if(task){store.transaction(()=>tasks.rejectQueuedRun(root,task.id,(error as DomainError).code as 'native_background_active'|'native_background_check_failed'));presentTaskReceipts(task.taskId,id,false);}
        current.preparing=false;current.directoryOwner=undefined;current.durableRun=undefined;current.invocation=undefined;current.usage?.finish('failed');state(id,'error');throw e;
      }
      const uncertainTurn =
        turnSubmitted &&
        (error.name === "RpcTimeoutError" || !!current.activeTurnId);
      if (uncertainTurn && before.completedAt) store.completeConversation(id,false);
      if (!uncertainTurn) {
        current.usage?.finish(current.stopRequested ? 'interrupted' : 'failed');
        finishTask(id, false);
        live.delete(id);
        await current.client?.close();
        current.client = undefined;
        current.approvals.clear();
        current.finishStop?.();
        if (chat(id).status !== "interrupted") state(id, current.stopRequested ? "interrupted" : "error");
      }
      if(recoveredReceipt&&!current.stopRequested){state(id,'idle');queueMicrotask(()=>{void pump(id);});}
      throw e;
    } finally {
      if (!turnSubmitted && current.runId === invocationId) revokeBusinessCli(current);
    }
  };
  const wakeDirectories=async()=>{
    if(closed)return;
    const pending=store.database.prepare("SELECT conversation_id AS id,created_at FROM task_user_inputs WHERE state='queued' UNION ALL SELECT json_extract(routing,'$.executionConversationId') AS id,created_at FROM task_runs WHERE state='queued' ORDER BY created_at,id").all();
    for(const id of new Set(pending.map(row=>row.id).filter(Boolean)))await pump(id as string);
  };
  const pump = (id: string) => {
    const pending: Promise<void> = pumpConversation(id).finally(() => queuePumps.delete(pending));
    queuePumps.add(pending);
    return pending;
  };
  const pumpConversation = async (id: string) => {
    if (closed || queuedSendPending(id) || continuity.blocked(id) || branching.has(id) || chat(id).status !== "idle") return;
    let config:Config;
    try{config=await loadConfig();}catch(error){if(closed)return;throw error;}
    if(closed)return;
    let context:ReturnType<typeof conversationContext>;
    try{assertExecutionAvailable(config,chat(id));context=conversationContext(config,chat(id),join(home||tmpdir(),'workspaces','conversations',id));}
    catch(error){
      if(!(error instanceof Error)||!['invalid project or agent','invalid workspace','Archived Project or Agent cannot execute'].includes(error.message))throw error;
      for(const row of store.database.prepare("SELECT id FROM task_user_inputs i WHERE conversation_id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM task_input_invocations n WHERE n.input_id=i.id) AND NOT EXISTS(SELECT 1 FROM task_directory_claims c WHERE c.kind='input' AND c.owner_id=i.id AND c.submitted=1) AND NOT EXISTS(SELECT 1 FROM task_native_uncertainty u WHERE u.kind='input' AND u.claim_id=i.id)").all(id)){
          messages.finish(row.id as string,'failed','询问上下文或权限已失效');scheduler.cancelUserInput(row.id as string);resources.releaseUnsubmitted('input',row.id as string);
      }
      store.transaction(()=>{
        for(const row of store.database.prepare("SELECT id FROM task_runs r WHERE state='queued' AND json_extract(routing,'$.executionConversationId')=? AND native_session_id IS NULL AND native_turn_id IS NULL AND NOT EXISTS(SELECT 1 FROM task_directory_claims c WHERE c.kind='run' AND c.owner_id=r.id AND c.submitted=1) AND NOT EXISTS(SELECT 1 FROM task_native_uncertainty u WHERE u.kind='run' AND u.claim_id=r.id)").all(id)){
          tasks.rejectQueuedRun(root,row.id as string,'forbidden');resources.releaseUnsubmitted('run',row.id as string);
        }
      });
      if(!store.listEvents(id,0).some(e=>e.kind==='error'&&(e.data as {message?:string}).message===error.message))store.appendEvent(id,'error',{message:error.message});
      return;
    }
    let remote:SshExecution|undefined;
    try{remote=await remoteFor(context,id);if(remote){const directory=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:context.project.cwd});if(!directory.isDirectory)throw new Error('Remote working directory is unavailable');context.project.cwd=directory.realpath;}}
    catch(error){if(!closed){const message=error instanceof Error?error.message:'Remote execution unavailable';const last=store.listEvents(id,0).filter(event=>event.kind==='error').at(-1);if((last?.data as {code?:string;message?:string})?.code!=='remote_unavailable'||(last?.data as {message?:string})?.message!==message)store.appendEvent(id,'error',{code:'remote_unavailable',message});}return;}
    if(!remote&&(chat(id).purpose==='mandala-background'||!context.workspace&&!chat(id).cwd))await mkdir(context.project.cwd,{recursive:true}).catch(error=>{if(!closed)throw error;});
    if(closed)return;
    const extra=(await Promise.all(context.project.resources.filter(r=>r.kind==='local').map(async r=>{if(remote){const value=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:r.location}).catch(()=>null);return value?.isDirectory?value.realpath:null;}return (await stat(r.location).catch(()=>null))?.isDirectory()?r.location:null;}))).filter((p):p is string=>!!p);
    if(home)for(const row of store.database.prepare("SELECT id FROM task_runs WHERE state='queued' AND json_extract(routing,'$.executionConversationId')=?").all(id))await mkdir(join(home,'outputs',row.id as string),{recursive:true}).catch(error=>{if(!closed)throw error;});
    const conversationOutputRoot=home&&config.agents.some(a=>a.id===chat(id).agentId)?join(home,'outputs','conversations',id):undefined;
    if(conversationOutputRoot)await mkdir(conversationOutputRoot,{recursive:true}).catch(error=>{if(!closed)throw error;});
    directoryRoots.set(id,{roots:[context.project.cwd,...extra],conversationOutputRoot});
    if(closed||queuedSendPending(id)||continuity.blocked(id)||branching.has(id)||chat(id).status!=='idle')return;
      admissionConfig.set(id,config);
    messages.queueReplies(id);
    // Recovery also presents notify-only reports, which do not create an automatic input.
    for(const row of store.database.prepare("SELECT id,task_id,source_run_id FROM task_receipts WHERE destination_conversation_id=? AND delivery_state='pending' ORDER BY rowid").all(id)){
      const sourceRun=row.source_run_id?tasks.getRunControl(root,row.source_run_id as string):null;
      scheduler.presentReceipt(row.id as string);
      store.appendEvent(id,'task',{taskId:row.task_id,receiptId:row.id,status:sourceRun?.state==='succeeded'?'completed':'failed',from:sourceRun?.routing?.executionConversationId??id,to:id});
    }
    if(config.mandala?.agentId===chat(id).agentId&&!coordination.deliveryPaused(id)){
      const receipts:import('../shared/tasks').Receipt[]=[];
      for(const row of store.database.prepare("SELECT id,task_id FROM task_receipts WHERE destination_conversation_id=? AND delivery_state IN ('pending','presented') AND claimed_by_run_id IS NULL ORDER BY rowid").all(id)){
        const owner=row.task_id?coordination.ownership(row.task_id as string):undefined;
        if(owner&&owner.conversationId!==id)continue;
        try{receipts.push(tasks.authorizeReceiptDelivery({...root,agentId:chat(id).agentId},row.id as string,id));}
        catch(error){if(!(error instanceof DomainError)||![403,409].includes(error.status))throw error;store.database.prepare("UPDATE task_receipts SET delivery_state='parked',claim_error=? WHERE id=?").run(error.code,row.id as string);}
      }
      scheduler.enqueueReceiptInput(id,receipts);
    }
    if (scheduler.takeNext(id)) return;
    const rows = store.database.prepare("SELECT task_id,id FROM task_receipts WHERE destination_conversation_id=? AND policy='resume' AND delivery_state IN ('pending','presented') AND claimed_by_run_id IS NULL").all(id);
    for (const parentId of new Set(rows.map(row => row.task_id as string))) {
      const parent = tasks.getTask(root, parentId);
      if (!coordinatorPrepared.has(parentId)) continue; // Restart recovery requires explicit Task5 reconciliation.
      const claimed=scheduler.claimReceipts(parent.id, parent.continuationEpoch, id, randomUUID(), rows.filter(row => row.task_id === parentId).map(row => row.id as string));
      // The receipt claim just created a Run; prepare its output root before taking it.
      if(claimed.length){await pump(id);return;}
    }
    settleInquiryConversation(id);
  };
  const authorizeConversationRuns = (runIds:readonly string[],agentId?:string) => {
    for(const runId of runIds){const principal=agentId!==undefined?{...root,agentId,runId}:root;tasks.getContextSnapshot(principal,runId);tasks.getRun(principal,runId);}
  };
  const authorizeReceiptHistory = (id:string,agentId:string,after=0) => {
    for(const event of store.database.prepare("SELECT kind,data FROM events WHERE conversationId=? AND id>? AND superseded=0 AND (kind='user' AND json_extract(data,'$.source.kind')='coordination' OR kind='metadata' AND json_extract(data,'$.receiptContext')=1) ORDER BY id").all(id,after)){
      const data=JSON.parse(event.data as string) as {source?:QueuedInput['source'];receiptContext?:boolean;receiptIds?:string[]};
      const receiptIds=event.kind==='user'&&data.source?.kind==='coordination'?data.source.receiptIds:event.kind==='metadata'&&data.receiptContext===true?data.receiptIds??[]:[];
      for(const receiptId of receiptIds)tasks.authorizeReceipt({...root,agentId},receiptId);
    }
  };
  const authorizeConversationRead = (id:string,asAgent=false,after=0) => {
    const c=chat(id);authorizeConversationRuns(store.listConversationTaskRuns(id),asAgent?c.agentId:undefined);
    if(asAgent)authorizeReceiptHistory(id,c.agentId,after);
    if(asAgent&&memoryRuntime) {
      memoryRuntime.memory.history({...root,...(c.agentId?{agentId:c.agentId}:{})},{projectId:c.projectId||null,items:memoryHistoryReferences(store,id,after)});
    }
  };
  const authorizeExecutionHistory = (id:string) => authorizeConversationRead(id,true,mandalaContextBoundary(store,id));
  const hasRevokedReceiptHistory = (id:string) => {
    const c=chat(id);if(c.purpose!=='mandala-main')return false;
    try{authorizeReceiptHistory(id,c.agentId,mandalaContextBoundary(store,id));}
    catch(error){if(error instanceof DomainError&&error.status===403)return true;throw error;}
    return false;
  };
  // Acceptance may queue a human request while busy. Retirement occurs only at the safe execution boundary.
  const authorizeHumanContinuation = (id:string) => {if(!hasRevokedReceiptHistory(id))authorizeExecutionHistory(id);};
  const resetRevokedContext = async (id:string,inputId?:string) => {
    const c=chat(id),runtime=live.get(id);
    const occupied=()=>runtime?.preparing||runtime?.invocation||['running','approval'].includes(chat(id).status)||
      store.database.prepare('SELECT claim_id FROM task_native_uncertainty WHERE conversation_id=?').get(id)||
      store.database.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? AND state IN ('starting','running','approval','unknown')").get(id)||
      store.database.prepare("SELECT id FROM task_user_inputs WHERE conversation_id=? AND (state='unknown' OR state='running' AND id<>?)").get(id,inputId??'')||
      store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id);
    if(continuity.blocked(id)||branching.has(id)||occupied())throw new DomainError('native_context_busy',409,'Current native work must settle before rebuilding context; queued input is preserved.');
    branching.add(id);let inspection:CodexClient|undefined;
    try{
      // The native runtime can retain background commands even after a terminal turn.
      if(c.nativeId&&c.cli==='codex'){
        let client=runtime?.client;
        if(!client){const config=await loadConfig(),context=conversationContext(config,c,join(home,'workspaces','conversations',id));
          inspection=client=await startClient(c.cli,{cwd:context.project.cwd,...runtimeOptions(c.cli,context,config),signal:lifetime.signal,onEvent(){},onApproval(){},onExit(){}},context,id,config,'inspect');}
        await client.assertReloadable?.(c.nativeId);
      }
      if(closed)throw new Error('service closed');
      if(occupied())throw new DomainError('native_context_busy',409,'Native work changed before rebuilding context; queued input is preserved.');
      // Persist invalidation before closing the old client, so restart cannot resume its transcript.
      store.transaction(()=>{appendEvent(id,'metadata',{nativeContextReset:{reason:'receipt_access_revoked',historyPreserved:true},message:'Context rebuilt after access changed. Previous history is retained and was not replayed.'});store.updateConversation(id,{nativeId:null,turnId:null,continuityPending:false});});
      if(runtime){revokeBusinessCli(runtime);runtime.generation++;live.delete(id);runtime.controller.abort();await runtime.client?.close();}
    }finally{await inspection?.close();branching.delete(id);}
  };
  const revise = async (id: string, eventId: number, text: string, replace: boolean, afterReply = false): Promise<Conversation> => {
    const source = chat(id);
    if (source.purpose === 'mandala-main') throw new DomainError('primary_conversation', 422, 'Primary chat is one continuous conversation; its messages cannot be edited or branched');
    const protectedRuns=store.listConversationTaskRuns(id),inheritedSources=knownSources(id);
    authorizeConversationRead(id,true);
    if (queuedSendPending(id) || continuity.blocked(id) || branching.has(id) || live.get(id)?.preparing || source.status === "running" || source.status === "approval")
      throw new Error("conversation busy");
    if (!afterReply && !text.trim()) throw new Error("invalid empty message");
    const inheritedMemory = memoryRuntime ? memoryHistoryReferences(store,id) : [];
    const events = store.listEvents(id, 0);
    const users = events.filter((event) => event.kind === "user");
    const unsubmitted = new Set(events.flatMap(event => {
      const data = event.data as { runId?: string; nativeTurnSubmitted?: boolean };
      return ["error", "metadata"].includes(event.kind) && data.nativeTurnSubmitted === false && data.runId ? [data.runId] : [];
    }));
    const nativeUsers = users.filter(event => !unsubmitted.has((event.data as { runId?: string }).runId ?? ""));
    const checkpoint = events.find(event => event.id === eventId);
    if (afterReply && (checkpoint?.kind !== "status" || (checkpoint.data as {status?: string}).status !== "idle"))
      throw new Error("invalid reply checkpoint");
    const target = afterReply ? users.filter(event => event.id < eventId).at(-1) : checkpoint;
    const index = users.findIndex(event => event.id === target?.id);
    if (!Number.isSafeInteger(eventId) || index < 0) throw new Error("invalid branch message");
    if (!afterReply && ((target?.data as { task?: unknown }).task || (target?.data as { agentMessage?:unknown }).agentMessage)) throw new Error("cannot edit task input");
    const runId = (users[index].data as { runId?: string }).runId;
    const prefixEnd = runId ? events.find(event => (event.data as { runId?: string }).runId === runId)!.id : eventId;
    if (!source.nativeId) throw new Error("Native message branching unavailable");
    branching.add(id);
    let client: CodexClient | undefined;
    try {
      const config = await loadConfig();
      const context=conversationContext(config, source, join(home || tmpdir(), "workspaces", "conversations", id));
      const { project } = context;
      authorizeConversationRead(id,true);
      let nativeId: string | null = null;
      client = await startClient(source.cli,{
        cwd: project.cwd, ...runtimeOptions(source.cli,context,config),
        signal: lifetime.signal, onEvent() {}, onApproval() {}, onExit() {},
        ...(source.cli === "omp" ? { resume: source.nativeId } : {}),
      },context,id,config,'fork');
      authorizeConversationRead(id,true);
      if (!client?.forkThread) throw new Error("Native message branching unavailable");
      nativeId = await client.forkThread(source.nativeId!,
        nativeUsers.map((event) => (event.data as { text: string; nativeText?: string }).nativeText ?? (event.data as { text: string }).text),
        nativeUsers.filter(event => afterReply ? event.id <= target!.id : event.id < target!.id).length, source.model ?? undefined);
      await client?.close();
      client = undefined;
      if (closed) throw new Error("service closed");
      authorizeConversationRead(id,true);
      if (replace) {
        if (store.listEvents(id, 0).filter(e => e.kind === "user").length !== users.length)
          throw new Error("conversation history changed; retry editing");
        const previous = live.get(id);
        if (previous) {
          previous.usage?.finish('interrupted');
          revokeBusinessCli(previous);
          live.delete(id);
          previous.generation++;
          previous.controller.abort();
          await previous.client?.close();
        }
        const from = store.replaceHistory(id, eventId, nativeId);
        store.appendEvent(id, "metadata", { historyReplacedFrom: from });
        if(inheritedMemory.length)store.appendEvent(id,"metadata",{memoryHistory:"inherited",items:inheritedMemory,causality:"not_established"});
        try { await run(id, text, false, true, undefined, undefined, (users[index].data as { attachments?: NativeAttachment[] }).attachments, (users[index].data as { references?: ComposerReferenceSelection[] }).references); } catch { /* run persists the failure */ }
        return chat(id);
      }
      const branch = store.transaction(() => {
        authorizeConversationRead(id,true);
        const branch = store.createConversation({ projectId: source.projectId, agentId: source.agentId,
          ...(source.purpose ? {purpose:"mandala-background" as const} : {}), cli: source.cli, model: source.model, effort: source.effort, approvalMode: source.approvalMode, workspaceId: source.workspaceId, cwd: source.cwd, workspaceName: source.workspaceName, executionLocation:source.executionLocation, branchedFrom: { conversationId: id, eventId } });
        store.updateConversation(branch.id, { nativeId });
        store.inheritConversationTaskRuns(branch.id,protectedRuns);
        if(inheritedMemory.length)store.appendEvent(branch.id,"metadata",{memoryHistory:"inherited",items:inheritedMemory,causality:"not_established"});
        store.appendEvent(branch.id,"metadata",{actualUse:"acknowledged",sourceVersions:inheritedSources,nativeVisibility:"partial",inheritedNativeHistory:true});
        for (const event of events) {
          if (afterReply ? event.id > eventId : event.id >= prefixEnd) break;
          if (event.kind !== "approval" && event.kind !== "task" &&
              (event.kind !== "metadata" || afterReply && !(event.data as {systemTask?: string}).systemTask))
            store.appendEvent(branch.id, event.kind, event.data, afterReply ? event.createdAt : undefined);
        }
        return branch;
      });
      // The branch already exists even if submitting its edited turn fails. Return it so
      // the user can inspect the saved error and continue without repeating the fork.
      if (afterReply) {
        if (source.title) store.renameConversation(branch.id, source.title, source.titleSource ?? "message");
        return chat(branch.id);
      }
      try { await run(branch.id, text, false, false, undefined, undefined, (users[index].data as { attachments?: NativeAttachment[] }).attachments); } catch { /* run persists the failure */ }
      return chat(branch.id);
    } finally {
      await client?.close();
      branching.delete(id);
      queueMicrotask(() => { void pump(id); });
    }
  };
  const stopInvocation = async (id:string) => {
      const c = chat(id),
        r = live.get(id);
      if (!r || (!r.preparing && c.status !== "running" && c.status !== "approval"))
        throw new Error("conversation not running");
      if (r.stopping) return r.stopping;
      r.stopRequested = true;
      revokeBusinessCli(r);
      if(r.preparing){
        // No turn RPC has been sent. Invalidate ownership before releasing only the unsent claim.
        appendEvent(id, "metadata", { nativeTurnSubmitted: false, reason: "preparation_stopped" });
        r.usage?.finish('interrupted');r.generation++;live.delete(id);r.controller.abort();await r.client?.close();r.approvals.clear();
        if(r.directoryOwner)resources.releaseUnsubmitted(r.directoryOwner.kind,r.directoryOwner.id);
        if(r.queuedInputId&&scheduler.listUserInputs(id).find(input=>input.id===r.queuedInputId)?.source?.kind==='coordination'&&scheduler.requeueUnsubmittedInput(r.queuedInputId))r.queuedInputId=undefined;
        state(id,'interrupted');finishTask(id,false,r);queueMicrotask(()=>{void wakeDirectories();});return;
      }
      r.stopping = new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          if (live.get(id) !== r) return;
          // Invalidate callbacks before closing so a late result cannot revive this turn.
          r.usage?.finish('interrupted',undefined,'native_terminal_unconfirmed');
          r.generation++;
          live.delete(id);
          r.controller.abort();
          r.client?.close();
          r.approvals.clear();
          if(r.directoryOwner&&resources.releaseUnsubmitted(r.directoryOwner.kind,r.directoryOwner.id))queueMicrotask(()=>{void wakeDirectories();});
          if(c.executionLocation){
            store.appendEvent(id,'error',{message:'Remote execution did not confirm stopping. Reconnect and check its state before starting more work.',code:'remote_stop_unconfirmed'});
            state(id,'interrupted');if(r.durableRun)tasks.markUnknown(r.durableRun.id);if(r.queuedInputId)scheduler.reconcileInput(r.queuedInputId,false);r.finishStop?.();return;
          }
          store.updateConversation(id, { turnId: null });
          store.appendEvent(id, "error", { message: "CLI did not finish stopping; its runtime was terminated. You can continue this conversation." });
          state(id, "interrupted");
          finishTask(id, false, r);
          r.finishStop?.();
        }, 3000);
        r.finishStop = () => { clearTimeout(timer); resolve(); };
      });
      if (r.client && c.nativeId && r.activeTurnId)
        void r.client.interrupt(c.nativeId, r.activeTurnId).catch(() => {});
      await r.stopping;
      r.stopping = undefined;
      r.finishStop = undefined;
  };
  let recovery: Promise<RecoveryReport> | undefined;
  const inspect = async (identity:import('../shared/tasks').RunIdentity,id:string) => {
    const c=chat(id);if(c.cli!=='codex')return 'unknown' as const;
    let client:CodexClient|undefined;
    try {
      const config=await loadConfig(),context=conversationContext(config,c,join(home,'workspaces','conversations',id));
      client=await startClient(c.cli,{cwd:context.project.cwd,...runtimeOptions(c.cli,context,config),signal:lifetime.signal,onEvent(){},onApproval(){},onExit(){}},context,id,config,'inspect');
      return await client.inspectInvocation?.(identity) ?? 'unknown';
    } catch {return 'unknown' as const;} finally {await client?.close();}
  };
  const progressMonitor=createTaskMonitor({store,listRuns:()=>tasks.listTasks(root).flatMap(task=>tasks.listRunControls(root,task.id)),inspect:async(identity,id)=>{
    const c=chat(id);if(c.cli!=='codex')return 'unknown';let client:CodexClient|undefined;
    try{const config=await loadConfig(),context=conversationContext(config,c,join(home,'workspaces','conversations',id));client=await startClient(c.cli,{cwd:context.project.cwd,...runtimeOptions(c.cli,context,config),signal:lifetime.signal,onEvent(){},onApproval(){},onExit(){}},context,id,config,'inspect');return await client.inspectInvocation?.(identity)??'unknown';}catch{return 'unreachable';}finally{await client?.close();}
  }});
  const conversationGoals=(id:string)=>{
    const principal={...root,agentId:chat(id).agentId},visible=tasks.listTasks(principal),owned=new Set(coordination.list().filter(own=>own.conversationId===id).map(own=>own.taskId));
    return visible.filter(task=>task.conversationIds.includes(id)||owned.has(task.id)).slice(0,20).map(task=>({id:task.id,goal:task.goal.slice(0,1000),state:task.state}));
  };
  const continuity=createMandalaContinuity({store,closed:()=>closed,
    inputs:id=>scheduler.listUserInputs(id),authorize:authorizeExecutionHistory,
    goals:id=>mandalaContextBoundary(store,id)?[]:conversationGoals(id),
    busy:id=>queuedSendPending(id)||branching.has(id)||!!live.get(id)?.preparing||!!live.get(id)?.invocation||!['idle','error'].includes(chat(id).status)||hasUnprovenNativeOccupancy(store,id)||
      !!store.database.prepare("SELECT id FROM task_user_inputs WHERE conversation_id=? AND state IN ('running','unknown')").get(id)||
      !!store.database.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? AND state IN ('starting','running','approval','unknown')").get(id)||
      !!store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id),
    lock:id=>branching.add(id),unlock:id=>branching.delete(id),wake:id=>{void pump(id);},
    async client(id){
      const c=chat(id),runtime=live.get(id);
      if(runtime?.client){runtime.usage?.event({method:'mandala/usageBaseline',params:{threadId:c.nativeId,fresh:false}});return {client:runtime.client,release:async()=>{}};}
      const config=await loadConfig(),context=conversationContext(config,c,join(home,'workspaces','conversations',id));
      if(c.cli!=='codex'&&c.cli!=='omp'){
        // ACP prompts are terminal before their process is retired; no autonomous follow-up capability is exposed.
        const terminal=store.listEvents(id,0).filter(e=>e.kind==='status').at(-1);
        return {client:{inspectContext:async()=>({settled:(terminal?.data as {status?:string})?.status==='idle'})},release:async()=>{}};
      }
      const callbacks={cwd:context.project.cwd,...runtimeOptions(c.cli,context,config),signal:lifetime.signal,
        onEvent:(event:RpcMessage)=>{continuity.event(id,event);},onApproval(){},onExit(){}};
      const client=await startClient(c.cli,{...callbacks,...(c.cli==='omp'?{resume:c.nativeId!}:{})},context,id,config,'inspect');
      clients.add(client);
      try{if(c.cli==='codex'&&(await client.inspectContext?.(c.nativeId!))?.settled)await client.resumeThread(c.nativeId!);}
      catch(error){await client.close();clients.delete(client);throw error;}
      return {client,release:async()=>{await client.close();clients.delete(client);}};
    },
    async retire(id){
      const runtime=live.get(id);if(runtime){revokeBusinessCli(runtime);runtime.generation++;live.delete(id);runtime.controller.abort();await runtime.client?.close();}
    },
  });
  const progressTimer=setInterval(()=>{if(!closed){void progressMonitor.tick().catch(()=>{});void continuity.tick().catch(()=>{});}},60000);progressTimer.unref();
  const prepareAutomation = async(taskId:string,input:AutomationRun) => {
    const commandKey=`automation:${input.id}`;
    const prior=tasks.findStart(root,taskId,commandKey);if(prior)return prior;
    const executionConfig=await loadConfig();assertExecutionAvailable(executionConfig,input);
    const task=tasks.getTask(root,taskId),goal=input.goalId?tasks.getTask(root,input.goalId):undefined;
    if(input.executionMode&&!input.goalId&&(task.projectId!==(input.projectId||null)||task.assigneeAgentId!==input.agentId))throw new DomainError('rule_task_binding_conflict',422,'Execution Task no longer matches the accepted scope');
    const owner=goal?coordination.ownership(goal.id):undefined;
    if(goal&&(!owner||owner.agentId!==executionConfig.mandala?.agentId||task.id!==goal.id||['cancelled','completed'].includes(goal.state)))throw new DomainError('goal_not_active',409,'Goal is no longer active');
    const {project,agent,workspace}=conversationContext(executionConfig,{...input,projectId:input.executionMode?input.projectId:task.projectId??''},'');
    const continuation=goal?{taskId:goal.id,conversationId:owner!.conversationId,epoch:goal.continuationEpoch,policy:'notify' as const}:undefined;
    if(!enabledRuntimes(await loadConfig()).includes(input.cli))throw new Error('Runtime disabled');
    const validateConversation=(id:string)=>{const target=chat(id);if(target.purpose==='mandala-main')throw new DomainError('primary_conversation',422,'Primary chat cannot execute tasks');if(target.agentId!==agent.id||target.projectId!==project.id||input.executionMode&&(target.cli!==input.cli||(target.workspaceId??null)!==(input.workspaceId??null)))throw new DomainError('invalid_conversation_scope',422,'Conversation must match the Agent, Project, runtime and workspace');};
    if(input.conversationId)validateConversation(input.conversationId);
    const memory=await recallMemory(home,{projectId:project.id,agentId:agent.id,query:input.instructions,documentIds:[...(project.knowledgeIds??[]),...(agent.knowledgeIds??[])]},store);
    prepared.set(taskId,{...(continuation?{continuation}:{}),agentId:agent.id,projectId:project.id||null,hostId:'local',input:[input.instructions,memory.instructions].filter(Boolean).join('\n\n'),sourceVersions:[...boundFileVersions(project.id,agent.id),...memory.entries.flatMap(e=>e.assetId&&e.versionId?[{assetId:e.assetId,versionId:e.versionId}]:[])],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'});
    routes.set(taskId,()=>{
      const conversationId=store.createConversation({...(agent.systemRole==='mandala'?{purpose:'mandala-background' as const,...(!project.id?{cwd:agent.managedWorkspace}:{})}:{}),projectId:project.id,agentId:agent.id,cli:input.cli,model:agent.models[input.cli]??null,executionLocation:workspaceExecutionLocation(executionConfig,workspace),workspaceId:workspace?.id??null,...(workspace?{cwd:workspace.cwd,workspaceName:workspace.name}:{})}).id;
      const occurrence=store.database.prepare('SELECT data FROM automation_occurrences WHERE id=?').get(input.id)!;
      store.database.prepare('UPDATE automation_occurrences SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(occurrence.data as string),conversationId}),input.id);
      return {executionConversationId:conversationId,mode:'dedicated' as const,destinationConversationId:continuation?.conversationId??task.originConversationId??input.reportConversationId??null};
    });
    if(store.database.prepare('SELECT disposition FROM automation_occurrences WHERE id=?').get(input.id)?.disposition!=='queued')throw new DomainError('occurrence_not_pending',409,'Occurrence is no longer pending');
    const run=await scheduler.dispatchTask(taskId,commandKey,undefined,{selection:prepared.get(taskId),agentId:agent.id,projectId:project.id||null,request:input.instructions,criteria:input.criteria??task.criteria});setImmediate(()=>{if(!closed)void pump(run.routing!.executionConversationId);});return run;
  };
  const manager: SessionManager = {
    maintainMandalaContext:()=>continuity.tick(),
    setAutomationService(service){automationService=service;},
    reconcileRuns(hostId) {
      // One startup pass; a later caller cannot classify this process's live work as lost.
      if(!recovery){
        reconcileArtifactCommands(store,assets);
        for(const c of store.listConversations())for(const e of store.listEvents(c.id,0)){
          const d=e.data as {coordinationTaskId?:string;sourceUserEventId?:number};
          if(e.kind!=='metadata'||!d.coordinationTaskId||!d.sourceUserEventId)continue;
          const user=store.listEvents(c.id,0).find(event=>event.id===d.sourceUserEventId&&event.kind==='user');
          if(!user)continue;
          const task=tasks.getTask(root,d.coordinationTaskId);
          if(!task.futureAutoResume||task.assigneeAgentId!==c.agentId||task.projectId!==(c.projectId||null))continue;
          const prior=tasks.listRuns(root,task.id).filter(run=>run.routing?.executionConversationId===c.id).at(-1),snapshot=prior?tasks.getContextSnapshot(root,prior.id):null;
          coordinatorPrepared.set(task.id,{agentId:c.agentId,projectId:task.projectId,hostId,input:snapshot?.input??task.goal,sourceVersions:snapshot?.sourceVersions??knownSources(c.id),requiredOutputAssetIds:snapshot?.requiredOutputAssetIds??[],effectiveCapabilities:snapshot?.effectiveCapabilities??[],nativeVisibility:'partial'});
        }
        for(const row of store.database.prepare("SELECT DISTINCT json_extract(continuation,'$.taskId') parent_id,json_extract(continuation,'$.conversationId') conversation_id FROM task_runs WHERE continuation IS NOT NULL").all()){
          const parent=tasks.getTask(root,row.parent_id as string),c=chat(row.conversation_id as string);
          if(!parent.futureAutoResume||parent.assigneeAgentId!==c.agentId||parent.projectId!==(c.projectId||null))continue;
          const prior=tasks.listRuns(root,parent.id).filter(run=>run.routing?.executionConversationId===c.id).at(-1),snapshot=prior?tasks.getContextSnapshot(root,prior.id):null;
          coordinatorPrepared.set(parent.id,{agentId:c.agentId,projectId:parent.projectId,hostId,input:snapshot?.input??parent.goal,sourceVersions:[...new Map([...(snapshot?.sourceVersions??[]),...knownSources(c.id)].map(ref=>[ref.versionId,ref])).values()],requiredOutputAssetIds:snapshot?.requiredOutputAssetIds??[],effectiveCapabilities:snapshot?.effectiveCapabilities??[],nativeVisibility:'partial'});
        }
        recovery=createTaskRecovery({store,tasks,scheduler,inspect,wake:pump,onInputReconciled:(inputId,outcome,invocationId)=>{const marker=messages.metadata(inputId);if(!marker)return;const message=messages.get(marker.id),id=marker.direction==='request'?message.targetConversationId:message.sourceConversationId;finishMessageInput(inputId,outcome==='succeeded'||outcome==='failed'?outcome:'unknown',invocationAnswer(id,invocationId,true));}})(hostId).then(async report=>{
          for(const row of store.database.prepare('SELECT * FROM task_directory_claims').all()){
            if(!row.submitted){resources.releaseUnsubmitted(row.kind as DirectoryOwner['kind'],row.owner_id as string);continue;}
            if(!row.conversation_id||!row.native_session_id||!row.native_turn_id)continue;
            const id=row.conversation_id as string,identity={runId:row.invocation_id as string,hostId,nativeSessionId:row.native_session_id as string,nativeTurnId:row.native_turn_id as string};
            const status=await inspect(identity,id);
            if(!['succeeded','failed'].includes(status))continue;
            resources.confirmTerminal(row.kind as DirectoryOwner['kind'],row.owner_id as string,{invocationId:identity.runId,nativeSessionId:identity.nativeSessionId,nativeTurnId:identity.nativeTurnId});
            const latest=store.listEvents(id,0).filter(e=>e.kind==='metadata'&&(e.data as {execution?:string}).execution==='started').at(-1)?.data as {runId?:string}|undefined;
            if(latest?.runId===identity.runId&&!hasUnprovenNativeOccupancy(store,id)&&!store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=?').get(id)&&chat(id).status==='interrupted')store.updateConversation(id,{status:'idle',turnId:null});
          }
          await wakeDirectories();for(const id of new Set(coordination.list().map(own=>own.conversationId)))await pump(id);return report;
        });
      }
      return recovery;
    },
    startAutomationTask:prepareAutomation,
    taskService: tasks,
    coordination,
    presentTaskDecision(taskId){
      const task=tasks.getTask(root,taskId),last=tasks.listRunControls(root,taskId).at(-1),id=last?.routing?.executionConversationId;
      if(!id)return;
      if(['completed','cancelled'].includes(task.state))messages.stop(id,taskId);
      presentTaskReceipts(taskId,id,task.state==='completed');
    },
    listReferenceSummary: async (id,outputsOnly=false)=>createConversationReferences({store,assets,attachments:attachmentAssets,tasks,memory:memoryRuntime?.memory,authorize:authorizeConversationRead})(id,!outputsOnly&&memoryRuntime?await memoryRuntime.reading():[],outputsOnly),
    fileMaintenance,
    knowledgeBase,
    codeGraph,
    async startDurableTask(taskId,expectedRevision,commandKey,conversationId,coordinationRun) {
      const prior=tasks.findStart(root,taskId,commandKey,expectedRevision);if(prior)return prior;
      const task=tasks.getTask(root,taskId);if(task.revision!==expectedRevision)throw new DomainError('revision_conflict',409,'revision_conflict');
      const executor=coordinationRun?.agentId??task.assigneeAgentId,executionProject=coordinationRun&&Object.hasOwn(coordinationRun,'projectId')?coordinationRun.projectId??null:task.projectId,request=coordinationRun?.request??task.goal;
      if(!executor)throw new DomainError('assignee_required',422,'assignee_required');
      const old=tasks.listRunControls(root,taskId).at(-1);
      const oldExecution=old?task.executions.find(item=>item.id===old.executionId):undefined;
      if(!coordinationRun&&!conversationId&&old?.routing&&oldExecution?.agentId===executor&&oldExecution.projectId===executionProject&&['failed','interrupted','unknown'].includes(old.state))return this.retryTask(taskId,expectedRevision,commandKey);
      const oldChat=old?.routing?chat(old.routing.executionConversationId):null,sameProject=oldChat?.projectId===(executionProject??''),sameScope=oldChat?.agentId===executor&&sameProject;
      const previousContext=!coordinationRun&&old&&sameProject?tasks.getContextSnapshot(root,old.id):null;
      const config=await loadConfig();assertExecutionAvailable(config,{projectId:executionProject??'',agentId:executor});const {project,agent,workspace}=conversationContext(config,{projectId:executionProject??'',agentId:executor},'');
      if(!enabledRuntimes(config).includes(agent.defaultCli))throw new DomainError('runtime_disabled',422,'runtime_disabled');
      if(conversationId){const target=chat(conversationId);if(target.purpose==='mandala-main')throw new DomainError('primary_conversation',422,'Primary chat cannot execute tasks');if(target.agentId!==agent.id||target.projectId!==project.id)throw new DomainError('invalid_conversation_scope',422,'Conversation must match the Agent and project');}
      const memory=await recallMemory(home,{projectId:project.id,agentId:agent.id,query:request,documentIds:[...(project.knowledgeIds??[]),...(agent.knowledgeIds??[])]},store);
      prepared.set(taskId,{agentId:agent.id,projectId:executionProject,hostId:'local',input:[request,memory.instructions].filter(Boolean).join('\n\n'),sourceVersions:[...new Map([...(previousContext?.sourceVersions??[]),...boundFileVersions(project.id,agent.id),...memory.entries.flatMap(e=>e.assetId&&e.versionId?[{assetId:e.assetId,versionId:e.versionId}]:[])].map(ref=>[ref.versionId,ref])).values()],requiredOutputAssetIds:previousContext?.requiredOutputAssetIds??[],effectiveCapabilities:[],nativeVisibility:'partial',...(coordinationRun?{continuation:coordinationRun.continuation}:{})});
      coordinationRun?.assertActive();
      routes.set(taskId,()=>conversationId?({executionConversationId:conversationId,mode:'existing',destinationConversationId:task.originConversationId??conversationId}):({executionConversationId:store.createConversation({...(agent.systemRole==="mandala"?{purpose:"mandala-background" as const,...(!project.id?{cwd:agent.managedWorkspace}:{})}:{}),projectId:project.id,agentId:agent.id,cli:agent.defaultCli,model:agent.models[agent.defaultCli]??null,executionLocation:workspaceExecutionLocation(config,workspace),workspaceId:workspace?.id??null,...(workspace?{cwd:workspace.cwd,workspaceName:workspace.name}:{})}).id,mode:'dedicated',destinationConversationId:coordinationRun?.continuation.conversationId??(sameScope?old?.routing?.destinationConversationId??null:null)}));
      const current=tasks.getTask(root,taskId);
      if(coordinationRun&&(current.continuationEpoch!==task.continuationEpoch||current.originConversationId!==task.originConversationId||current.goal!==task.goal||current.acceptance!==task.acceptance||current.projectId!==task.projectId||JSON.stringify(current.criteria)!==JSON.stringify(task.criteria)||['completed','cancelled'].includes(current.state)))throw new DomainError('revision_conflict',409,'revision_conflict');
      const run=await scheduler.dispatchTask(taskId,commandKey,coordinationRun?current.revision:expectedRevision,{selection:prepared.get(taskId),agentId:agent.id,projectId:executionProject,request,criteria:coordinationRun?.criteria??task.criteria,createdByAgentId:coordinationRun?chat(coordinationRun.continuation.conversationId).agentId:null});setImmediate(()=>{if(!closed)void pump(run.routing!.executionConversationId);});return run;
    },
    async stopDurableTask(taskId,expectedRevision,cancel=false) {
      const revision=expectedRevision??tasks.getTask(root,taskId).revision;
      const previous=tasks.listRunControls(root,taskId).at(-1);
      let waitingConversation:string|undefined;
      if(previous?.routing)try{if(tasks.findInquiryWait(root,previous.id,previous.routing.executionConversationId))waitingConversation=previous.routing.executionConversationId;}catch(error){if(!(error instanceof DomainError)||error.code!=='inquiry_resume_unavailable')throw error;}
      const result=cancel?scheduler.cancelTask(taskId,revision):scheduler.stopTask(taskId,revision);
      if(waitingConversation){messages.stop(waitingConversation,taskId);presentTaskReceipts(taskId,waitingConversation,false);}
      const run=result.run;
      for(const executionRun of result.runs??(run?[run]:[]))if(executionRun.routing&&live.get(executionRun.routing.executionConversationId)?.durableRun?.id===executionRun.id)await stopInvocation(executionRun.routing.executionConversationId);
      if(!run) {
        // A source chat's coordination goal can precede its first durable Run.
        const source=[...live].find(([,runtime])=>!runtime.durableRun&&runtime.runId&&goalByInvocation.get(runtime.runId)===taskId);
        if(source&&chat(source[0]).purpose!=='mandala-main'&&['running','approval'].includes(chat(source[0]).status))await stopInvocation(source[0]);
      }
      return {taskId,status:result.status,runId:run?.id??null};
    },
    resolveUnknownInput(id,action,key) {
      const input=scheduler.resolveUnknownInput(id,action,key);
      const c=chat(input.conversationId);
      const released=canReleaseNativeOccupancy(store,c.id);
      if(c.status==='interrupted'&&released)store.updateConversation(c.id,{status:'idle',turnId:null});
      else if(!released&&['idle','error'].includes(c.status))store.updateConversation(c.id,{status:'interrupted'});
      setImmediate(()=>{if(!closed)void pump(c.id);});return input;
    },
    async retryTask(taskId,expectedRevision,commandKey) {
      const replay=tasks.findStart(root,taskId,commandKey,expectedRevision);if(replay)return replay;
      const task=tasks.getTask(root,taskId);
      if(task.revision!==expectedRevision)throw new DomainError('revision_conflict',409,'revision_conflict');
      const old=tasks.listRunControls(root,taskId).at(-1);if(!old?.routing)throw new Error('Task route missing');
      if(!['failed','interrupted','unknown'].includes(old.state))throw new DomainError('run_not_retryable',409,'run_not_retryable');
      const execution=tasks.listExecutions(root,taskId).find(item=>item.id===old.executionId)!;
      const delegated=execution.createdByAgentId!==null;
      const executor=delegated?execution.agentId:task.assigneeAgentId??execution.agentId,executionProject=delegated?execution.projectId:task.projectId,request=delegated?execution.request:task.goal;
      const c=chat(old.routing.executionConversationId),sameProject=c.projectId===(executionProject??''),sameScope=c.purpose!=='mandala-main'&&c.agentId===executor&&sameProject;
      const continuation=sameScope?old.continuation:null;
      const previousRule=sameScope?tasks.getRun(root,old.id).snapshot?.rule:undefined;
      const reportRule=previousRule?.reportConversationId===old.routing.destinationConversationId?previousRule:undefined;
      const checkContinuation=()=>{
        if(!continuation)return;
        const parent=tasks.getTask(root,continuation.taskId);
        if(parent.continuationEpoch!==continuation.epoch||['cancelled','completed'].includes(parent.state)||continuation.policy==='resume'&&!parent.futureAutoResume)throw new DomainError('continuation_conflict',409,'continuation_conflict');
      };
      checkContinuation();
      const previousContext=sameProject?tasks.getContextSnapshot(root,old.id):null;
      const executionConfig=await loadConfig();assertExecutionAvailable(executionConfig,{projectId:executionProject??'',agentId:executor});
      const context=conversationContext(executionConfig,sameScope?c:{projectId:executionProject??'',agentId:executor!},'');
      const memory=await recallMemory(home,{projectId:context.project.id,agentId:context.agent.id,query:request,documentIds:[...(context.project.knowledgeIds??[]),...(context.agent.knowledgeIds??[])]},store);
      prepared.set(taskId,{agentId:executor!,projectId:executionProject,hostId:'local',input:[request,memory.instructions].filter(Boolean).join('\n\n'),sourceVersions:[...new Map([...(previousContext?.sourceVersions??[]),...(sameScope?knownSources(c.id):[]),...boundFileVersions(context.project.id,context.agent.id),...memory.entries.flatMap(e=>e.assetId&&e.versionId?[{assetId:e.assetId,versionId:e.versionId}]:[])].map(ref=>[ref.versionId,ref])).values()],requiredOutputAssetIds:previousContext?.requiredOutputAssetIds??[],effectiveCapabilities:[],nativeVisibility:'partial',...(reportRule?{reportRule}:{}),...(continuation?{continuation}:{})});
      if(tasks.getTask(root,taskId).revision!==expectedRevision)throw new DomainError('revision_conflict',409,'revision_conflict');
      checkContinuation();
      if(old.state==='unknown')tasks.abandonUnknown(root,old.id,expectedRevision);
      routes.set(taskId,()=>{
        checkContinuation();
        if(!sameScope){
          const {project,agent,workspace}=context;
          return {executionConversationId:store.createConversation({...(agent.systemRole==="mandala"?{purpose:"mandala-background" as const,...(!project.id?{cwd:agent.managedWorkspace}:{})}:{}),projectId:project.id,agentId:agent.id,cli:agent.defaultCli,model:agent.models[agent.defaultCli]??null,executionLocation:context.executionLocation,workspaceId:workspace?.id??null,...(workspace?{cwd:workspace.cwd,workspaceName:workspace.name}:{})}).id,mode:'dedicated',destinationConversationId:null};
        }
        if(old.state==='unknown'||hasUnprovenNativeOccupancy(store,c.id)||chat(c.id).status==='error'||chat(c.id).status==='interrupted'&&!canReleaseNativeOccupancy(store,c.id)){
          // Explicit retry gets a fresh native session; never inherit uncertain history/turn.
          if(!canReleaseNativeOccupancy(store,c.id)&&chat(c.id).status==='idle')store.updateConversation(c.id,{status:'interrupted'});
          const execution=store.createConversation({...(context.agent.systemRole==="mandala"?{purpose:"mandala-background" as const}:{}),projectId:c.projectId,agentId:c.agentId,cli:c.cli,model:c.model,approvalMode:c.approvalMode,workspaceId:c.workspaceId,cwd:c.cwd,workspaceName:c.workspaceName,executionLocation:c.executionLocation});
          return {...old.routing!,executionConversationId:execution.id,mode:'dedicated'};
        }
        return old.routing!;
      });
      const run=await scheduler.dispatchTask(taskId,commandKey,undefined,{selection:prepared.get(taskId),agentId:executor,projectId:executionProject,request,criteria:execution.criteria,createdByAgentId:execution.createdByAgentId,supersedesExecutionId:execution.id});
      if(chat(c.id).status==='interrupted'&&canReleaseNativeOccupancy(store,c.id))store.updateConversation(c.id,{status:'idle',turnId:null});
      setImmediate(()=>{if(!closed)void pump(run.routing!.executionConversationId);});return run;
    },
    async getCliStatus(projectId, cli = "codex", environment, scope = "runtime") {
      // Discovery needs runtime routing, not executable Skill bodies or their history.
      const config = await loadConfig({hydrateSkills:false});
      const context = projectId || environment ? conversationContext(config, { projectId: projectId ?? "", ...environment }, "") : undefined;
      const project = context?.project;
      const cwd = project?.cwd || await mkdtemp(join(tmpdir(), "mana-catalog-"));
      const catalogId='catalog-'+randomUUID();
      let client: CodexClient | undefined;
      try {
        client = await startClient(cli,{
          cwd,
          model:config.chatDefaults?.[cli]?.model,
          ...runtimeOptions(cli,context,config,scope),
          signal: lifetime.signal,
          onEvent() {},
          onApproval() {},
          onExit() {},
          ...(cli === "omp" ? { ephemeral: true } : {}),
        },context,catalogId,config);
        return await client.getStatus();
      } catch {
          return { status: "unavailable", version: null };
      } finally {
        await client?.close();
        if (!project?.cwd) await rm(cwd, { recursive: true, force: true });
      }
    },
    async listModels(projectId, cli = "codex", environment, scope = "runtime") {
      if (closed) throw new Error("service closed");
      // Discovery needs runtime routing, not executable Skill bodies or their history.
      const config = await loadConfig({hydrateSkills:false});
      const context = projectId || environment ? conversationContext(config, { projectId: projectId ?? "", ...environment }, "") : undefined;
      const project = context?.project;
      const cwd = project?.cwd || await mkdtemp(join(tmpdir(), "mana-catalog-"));
      const catalogId='catalog-'+randomUUID();
      let client: CodexClient | undefined;
      try {
        client = await startClient(cli,{
          cwd, model:config.chatDefaults?.[cli]?.model, ...runtimeOptions(cli,context,config,scope), signal: lifetime.signal,
          onEvent() {}, onApproval() {}, onExit() {},
          ...(cli === "omp" ? { ephemeral: true } : {}),
        },context,catalogId,config);
        if (closed) throw new Error("service closed");
        return await client.listModels();
      } finally {
        await client?.close();
        if (!project?.cwd) await rm(cwd, { recursive: true, force: true });
      }
    },
    async create(projectId, agentId, model, cli, environment = {}) {
      if (environment.approvalMode !== undefined && !["default", "strict", "auto"].includes(environment.approvalMode)) throw new Error("invalid approval mode");
      if (environment.cwd !== undefined && (!isAbsolute(environment.cwd) ||
          !(await stat(environment.cwd).catch(() => null))?.isDirectory())) throw new Error("invalid workspace directory");
      if (projectId && environment.cwd !== undefined) throw new Error("invalid workspace selection");
      const config = await loadConfig();
      assertExecutionAvailable(config,{projectId,agentId});
      const { agent, workspace, executionLocation } = conversationContext(config, { projectId, agentId, ...environment }, "");
      const selectedCli = cli ?? (agent.id ? agent.defaultCli : enabledRuntimes(config)[0]);
      if (!isCli(selectedCli)) throw new Error("CLI unavailable");
      if (!enabledRuntimes(await loadConfig()).includes(selectedCli)) throw new Error("Runtime disabled");
      if (environment.effort !== undefined) validateEffort(environment.effort);
      const defaults = config.chatDefaults?.[selectedCli];
      const chosenModel = model || agent.models[selectedCli] || (isSystemAgent(config,agent.id) ? null : defaults?.model) || null;
      return store.createConversation({
        projectId,
        agentId,
        ...(isSystemAgent(config,agent.id) ? {purpose:"mandala-background" as const,...(!projectId?{cwd:agent.managedWorkspace}:{})} : {}),
        cli: selectedCli,
        model: chosenModel,
        effort: environment.effort ?? (!chosenModel || chosenModel === defaults?.model ? defaults?.effort : undefined) ?? null,
        ...(environment.approvalMode ? { approvalMode: environment.approvalMode } : {}),
        workspaceId: workspace?.id ?? null,
        executionLocation,
        ...(workspace?.cwd || environment.cwd ? { cwd: workspace?.cwd || environment.cwd } : {}),
        ...(workspace ? { workspaceName: workspace.name } : {}),
      });
    },
    getVerification(id) {
      chat(id);
      const runtime = live.get(id);
      return runtime?.verification && runtime.loadedSignature
        ? { ...runtime.verification, loadedSignature: runtime.loadedSignature, loadedRuntimeSignature: runtime.loadedRuntimeSignature } : null;
    },
    async createTask(sourceId, targetAgentId, request, targetId, options = {}) {
      if (!request.trim()) throw new Error("invalid empty message");
      if (options.policy !== undefined && !["notify", "resume"].includes(options.policy)) throw new Error("invalid continuation policy");
      const source = chat(sourceId), sourceRuntime = live.get(sourceId);
      if (options.boundInvocationId && (sourceRuntime?.runId !== options.boundInvocationId || !sourceRuntime.invocation)) throw new DomainError("forbidden",403,"Expired tool binding");
      const sourceVersions = knownSources(sourceId);
      if (!source.projectId || !source.agentId) throw new Error("invalid task source: Project and Agent required");
      const key = options.commandKey ?? randomUUID();
      const delegateKey=`delegate:${sourceId}:${key}`;
      const prior=store.database.prepare('SELECT task_id,run_id FROM task_command_dedup WHERE command_key=?').get(delegateKey);
      if(prior?.run_id){
        const run=tasks.getRunControl(root,prior.run_id as string),execution=tasks.listExecutions(root,run.taskId).find(item=>item.id===run.executionId)!;
        if(execution.request!==request.trim()||execution.agentId!==targetAgentId||targetId&&execution.conversationId!==targetId||(run.continuation?.policy??'notify')!==(options.policy??run.continuation?.policy??'notify'))throw new DomainError('idempotency_conflict',409,'idempotency_conflict');
        return this.listTasks().find(item=>item.id===run.taskId&&item.targetConversationId===execution.conversationId)!;
      }
      const policy=options.policy??'resume';
      const user=store.listEvents(sourceId,0).filter(e=>e.kind==='user'&&!(e.data as {task?:unknown}).task&&!(e.data as {agentMessage?:unknown}).agentMessage).at(-1);
      let goalId=sourceRuntime?.durableRun?.taskId??tasks.executionForConversation(root,sourceId)?.taskId??(targetId?tasks.executionForConversation(root,targetId)?.taskId:undefined)??(sourceRuntime?.runId?goalByInvocation.get(sourceRuntime.runId):undefined);
      if(!goalId){
        if(policy==='resume'&&!user)throw new Error('Resume requires an actual submitted user request');
        const goal=tasks.createTask(root,{goal:user?(user.data as {text:string}).text:request.trim(),criteria:[],acceptance:'delivery',projectId:source.projectId,assigneeAgentId:source.agentId,originConversationId:sourceId},`coordinate:${sourceId}:${user?.id??key}`,'system');
        goalId=goal.id;
        coordinatorPrepared.set(goal.id,{agentId:source.agentId,projectId:source.projectId,hostId:'local',input:goal.goal,sourceVersions,requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'});
        store.appendEvent(sourceId,'metadata',{coordinationTaskId:goal.id,sourceUserEventId:user?.id});
        if(sourceRuntime?.runId)goalByInvocation.set(sourceRuntime.runId,goal.id);
      }
      let task=tasks.getTask(root,goalId);
      if(!task.originConversationId)task=tasks.updateTask(root,task.id,task.revision,{originConversationId:sourceId},`origin:${sourceId}:${key}`);
      if(policy==='resume'&&!task.futureAutoResume)task=scheduler.enableContinuation(task.id,task.revision);
      if(!coordinatorPrepared.has(task.id))coordinatorPrepared.set(task.id,{agentId:source.agentId,projectId:source.projectId,hostId:'local',input:task.goal,sourceVersions,requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'});
      const continuation:Continuation={taskId:task.id,conversationId:task.originConversationId??sourceId,epoch:task.continuationEpoch,policy};
      const { project, agent } = await selection(source.projectId, targetAgentId);
      const memory = await recallMemory(home, {projectId: project.id, agentId: agent.id, query: request, documentIds: [...(project.knowledgeIds ?? []), ...(agent.knowledgeIds ?? [])]}, store);
      let target = targetId ? chat(targetId) : undefined;
      if(target?.purpose==='mandala-main')throw new DomainError('primary_conversation',422,'Primary chat cannot execute tasks');
      if (target && (target.projectId !== project.id || target.agentId !== agent.id)) throw new Error("invalid target conversation");
      prepared.set(task.id, {agentId:agent.id,projectId:project.id,hostId:"local",input:[request.trim(),memory.instructions].filter(Boolean).join("\n\n"),
        sourceVersions:[...new Map([...sourceVersions, ...(target ? knownSources(target.id) : []), ...boundFileVersions(project.id,agent.id), ...memory.entries.flatMap(e => e.assetId && e.versionId ? [{assetId:e.assetId,versionId:e.versionId}] : [])].map(ref => [ref.versionId,ref])).values()],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:"partial",...(continuation ? {continuation} : {})});
      const routeConfig = await loadConfig();
      const workspace = conversationContext(routeConfig,{...source,agentId:agent.id},"").workspace;
      if (!target && !enabledRuntimes(routeConfig).includes(agent.defaultCli)) throw new Error("Runtime disabled");
      routes.set(task.id,() => {
        // Create the dedicated transcript in the same transaction as queued Run acceptance.
        const execution = target ?? store.createConversation({...(agent.systemRole==="mandala"?{purpose:"mandala-background" as const,...(!project.id?{cwd:agent.managedWorkspace}:{})}:{}),projectId:project.id,agentId:agent.id,cli:agent.defaultCli,model:agent.models[agent.defaultCli] ?? null,executionLocation:source.executionLocation,workspaceId:workspace?.id ?? null,...(source.cwd ? {cwd:source.cwd,workspaceName:source.workspaceName} : workspace ? {cwd:workspace.cwd,workspaceName:workspace.name} : {})});
        return {executionConversationId:execution.id,mode:targetId ? "existing" : "dedicated",destinationConversationId:sourceId};
      });
      if (continuation) continuation.epoch = tasks.getTask(root, continuation.taskId).continuationEpoch;
      const accepted = await scheduler.dispatchTask(task.id,delegateKey,undefined,{selection:prepared.get(task.id),agentId:agent.id,projectId:project.id,request:request.trim(),criteria:[],createdByAgentId:source.agentId});
      target = chat(accepted.routing!.executionConversationId);
      store.appendEvent(sourceId, "task", {taskId:task.id,status:"queued",from:sourceId,to:target.id,request:task.goal});
      setImmediate(() => { if (!closed) void pump(target!.id); });
      return this.listTasks().find(item => item.id === task.id&&item.targetConversationId===target!.id)!;
    },
    async askAgent(sourceId,input,options){
      if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['targetAgentId','text','targetConversationId','policy'].includes(k))||typeof input.targetAgentId!=='string'||typeof input.text!=='string'||!input.text.trim()||input.text.length>65536||input.targetConversationId!==undefined&&typeof input.targetConversationId!=='string'||input.policy!==undefined&&!['notify','resume'].includes(input.policy)||!options.commandKey?.trim()||options.commandKey.length>200)throw new DomainError('invalid_message',422,'Invalid Agent message');
      const source=chat(sourceId);
      const validate=()=>{if(closed)throw new Error('service closed');if(options.boundInvocationId){const runtime=live.get(sourceId);if(runtime?.runId!==options.boundInvocationId||!runtime.invocation||runtime.stopRequested)throw new DomainError('forbidden',403,'Expired tool binding');}};
      validate();if(!source.projectId||!source.agentId)throw new DomainError('invalid_message_source',422,'Project and Agent required');
      const {agent,project}=await selection(source.projectId,input.targetAgentId);validate();
      if(!project.agentIds.includes(source.agentId)&&!isSystemAgent(await loadConfig(),source.agentId))throw new DomainError('forbidden',403,'Source unavailable');
      const previous=messages.prior(sourceId,options.commandKey,input);if(previous)return previous;
      const runtime=live.get(sourceId),origin=runtime?.queuedInputId?messages.metadata(runtime.queuedInputId):undefined;
      const event=origin?.direction==='reply'?store.listEvents(sourceId,0).find(e=>e.id===origin.sourceRequestEventId):store.listEvents(sourceId,0).filter(e=>e.kind==='user'&&(!runtime?.runId||(e.data as {runId?:string}).runId===runtime.runId)).at(-1);
      if(!event)throw new DomainError('message_source_missing',422,'Submitted source request required');
      let target=input.targetConversationId?chat(input.targetConversationId):undefined;
      if(target?.purpose==='mandala-main')throw new DomainError('primary_conversation',422,'Primary chat cannot execute messages');
      if(target&&(target.projectId!==source.projectId||target.agentId!==agent.id))throw new DomainError('forbidden',403,'Target unavailable');
      const config=await loadConfig();validate();
      conversationContext(config,{projectId:source.projectId,agentId:source.agentId},'');conversationContext(config,{projectId:source.projectId,agentId:agent.id},'');
      if(!target&&!enabledRuntimes(config).includes(agent.defaultCli))throw new Error('Runtime disabled');
      // No awaits between the last binding check and atomic acceptance.
      const message=store.transaction(()=>{
        target??=store.createConversation({...(agent.systemRole==="mandala"?{purpose:"mandala-background" as const,...(!project.id?{cwd:agent.managedWorkspace}:{})}:{}),projectId:project.id,agentId:agent.id,cli:agent.defaultCli,model:agent.models[agent.defaultCli]??null,workspaceId:source.workspaceId??null,executionLocation:source.executionLocation,...(source.cwd?{cwd:source.cwd,workspaceName:source.workspaceName}: {})});
        const accepted=messages.create(sourceId,target.id,input,{eventId:event.id,invocationId:runtime?.runId??String(event.id)},options.commandKey);
        if(input.targetConversationId&&messages.isDedicated(target.id))markConversationProgress(store,target.id,false);
        return accepted;
      });
      setImmediate(()=>{if(!closed)void pump(message.targetConversationId);});return message;
    },
    getAgentMessage(id,agentId){
      const message=messages.get(id),source=chat(message.sourceConversationId),target=chat(message.targetConversationId);
      if(agentId&&agentId!==source.agentId&&agentId!==target.agentId)throw new DomainError('forbidden',403,'Message unavailable');
      authorizeConversationRead(agentId===target.agentId?target.id:source.id,true);return message;
    },
    listTasks(projectId, controlOnly = false) {
      const projected = store.database.prepare("SELECT id FROM work_tasks WHERE owner_user_id=? ORDER BY created_at DESC").all(root.userId).flatMap(row => {
        const task = tasks.getTask(root, row.id as string);
        if (projectId && task.projectId !== projectId) return [];
        return tasks.listRunControls(root,task.id).filter(run=>run.routing&&task.executions.some(execution=>execution.latestRun?.id===run.id)).flatMap(run=>{
        const execution=task.executions.find(item=>item.id===run.executionId);
        let summary:string|null=null;
        if(!controlOnly)try {summary=tasks.getRun(root,run.id).summary;}catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;}
        const old = task.legacyId ? store.getTask(task.legacyId) : null;
        const continuation = run.continuation;
        const parent = continuation ? tasks.getTask(root,continuation.taskId) : null;
        const autoResume = Boolean(continuation?.policy === "resume" && parent?.futureAutoResume && coordinatorPrepared.has(parent.id) && parent.continuationEpoch === continuation.epoch && ['todo','running','waiting'].includes(parent.state) && continuation.conversationId === run.routing?.destinationConversationId);
        return [{id:task.id, projectId:task.projectId ?? "",sourceConversationId:run.routing?.destinationConversationId ?? old?.sourceConversationId ?? "",targetConversationId:run.routing?.executionConversationId ?? old?.targetConversationId ?? "",kind:"dispatch" as const,request:execution?.request??task.goal,status:run.state === "queued" ? "queued" as const : ["starting","running","approval"].includes(run.state) ? "running" as const : run.state === "succeeded" ? "completed" as const : "failed" as const,result:summary,startEventId:0,autoResume,createdAt:run.createdAt}];
        });
      });
      if(controlOnly)return projected;
      const receipts: Task[] = store.database.prepare("SELECT id FROM task_receipts ORDER BY created_at").all().flatMap(row => {
        let receipt:import('../shared/tasks').Receipt;
        try{receipt=tasks.authorizeReceipt(root,row.id as string);}catch(error){if(error instanceof DomainError&&error.status===403)return [];throw error;}
        const sourceTask = receipt.taskId ? tasks.getTask(root,receipt.taskId) : null;
        if (projectId && sourceTask?.projectId !== projectId) return [];
        const sourceRun = receipt.sourceRunId ? tasks.getRunControl(root,receipt.sourceRunId) : null;
        const parent = receipt.taskId ? tasks.getTask(root,receipt.taskId) : null;
        return [{id:receipt.id,projectId:sourceTask?.projectId ?? "",sourceConversationId:sourceRun?.routing?.executionConversationId ?? "",targetConversationId:receipt.destinationConversationId ?? "",kind:"return" as const,request:receipt.summary,status:receipt.deliveryState === "consumed" ? "completed" as const : receipt.claimedByRunId && ["starting","running","approval"].includes(tasks.getRunControl(root,receipt.claimedByRunId).state) ? "running" as const : "queued" as const,result:receipt.summary,startEventId:0,autoResume:Boolean(parent?.futureAutoResume && coordinatorPrepared.has(parent.id) && receipt.policy === "resume" && receipt.deliveryState !== "parked"),continuationEpoch:receipt.capturedEpoch ?? undefined,createdAt:receipt.createdAt}];
      });
      return [...projected,...receipts];
    },
    async listComposerReferences(id, preview) {
      return listComposerReferences({ home, store, manager, config: await loadConfig(), principal: root, conversationId: id, preview });
    },
    enqueueUserInput(id, text, commandKey, attachments = [], references = []) {
      authorizeHumanContinuation(id);
      const c=chat(id);
      const input = scheduler.enqueueUserInput(id, text, commandKey, attachments, references);
      if(attachments.length)attachmentAssets.accept(root,id,attachments,input.id,{agentId:c.agentId||undefined,projectId:c.projectId||undefined});
      store.appendEvent(id,"metadata",{queuedInputId:input.id,state:input.state});
      setImmediate(() => { if (!closed) void pump(id); });
      return input;
    },
    enqueueTelegramInput(id,text,requestId,attachments) {
      const c=chat(id);
      if(c.purpose!=='mandala-main'||c.executionLocation)throw new DomainError('telegram_scope',403,'此对话不在 Telegram 的 Mandala 范围内。');
      authorizeHumanContinuation(id);
      const enqueue=()=>{
        const input=scheduler.enqueueSystemInput(id,text,'telegram:'+requestId,{kind:'telegram',requestId},attachments);
        if(attachments.length)attachmentAssets.accept(root,id,attachments,input.id,{agentId:c.agentId||undefined,projectId:c.projectId||undefined});
        return input;
      };
      const input=store.database.isTransaction?enqueue():store.transaction(enqueue);
      setImmediate(()=>{if(!closed)void pump(id);});
      return input;
    },
    async interruptAndSend(id,text,commandKey,expectedExecutionId,attachments,references) {
      authorizeHumanContinuation(id);
      const prior=scheduler.listUserInputs(id).find(input=>input.commandKey===commandKey);
      if(prior){
        scheduler.enqueueUserInput(id,text,commandKey,attachments,references);
        return manager.listUserInputs(id).find(input=>input.id===prior.id)!;
      }
      if(manager.executionId(id)!==expectedExecutionId)throw new DomainError('execution_changed',409,'Execution changed; refresh before sending');
      if(queuedSendUnavailable(id)||continuity.blocked(id)||branching.has(id))throw new DomainError('conversation_busy',409,'Conversation is not available to send');
      const input=manager.enqueueUserInput(id,text,commandKey,attachments,references);
      try{await manager.sendQueuedInput(id,input.id,expectedExecutionId);}
      catch(error){
        const retained=manager.listUserInputs(id).find(item=>item.id===input.id);
        if(retained?.state!=='queued')throw error;
        store.appendEvent(id,'error',{message:(error as Error).message,queuedInputId:input.id,nativeTurnSubmitted:false});
        return retained;
      }
      return manager.listUserInputs(id).find(item=>item.id===input.id)!;
    },
    async sendQueuedInput(id,inputId,expectedExecutionId) {
      authorizeHumanContinuation(id);
      if(closed||continuity.blocked(id)||branching.has(id))throw new DomainError('conversation_busy',409,'Conversation is not available to send');
      const read=()=>scheduler.listUserInputs(id).find(input=>input.id===inputId);
      let input=read();
      if(!input||!isHumanInput(input))throw new DomainError('input_not_found',404,'Queued user message not found');
      if(input.unrecorded||!['queued','running','completed'].includes(input.state))throw new DomainError('input_not_queued',409,'Message is not available to send');
      if(input.state!=='queued')return; // A retry acknowledges this same accepted message without interrupting newer work.
      if(backgroundSends.get(id)?.inputId===inputId)return;
      if(queuedSendUnavailable(id,inputId))throw new DomainError('conversation_busy',409,'A queued message is already being started');
      queueStarts.add(id);
      try {
        const attachments=await loadAttachments(home,id,input.attachments??[]);
        input=read();if(!input||input.state!=='queued')return;
        const executionId=manager.executionId(id);
        if(expectedExecutionId!==undefined&&executionId!==expectedExecutionId)throw new DomainError('execution_changed',409,'Execution changed; refresh before sending');
        const interrupting=live.get(id)?.preparing||['running','approval'].includes(chat(id).status);
        if(interrupting){
          if(!await manager.stop(id,expectedExecutionId))throw new DomainError('stop_unconfirmed',409,'Stop not confirmed; queued message is preserved');
        }
        if(live.get(id)?.preparing||['running','approval'].includes(chat(id).status)||manager.executionId(id)!==null&&manager.executionId(id)!==executionId)throw new DomainError('execution_changed',409,'Execution changed; refresh before sending');
        if(live.get(id)?.invocation||hasUnprovenNativeOccupancy(store,id)||store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id))throw new DomainError('stop_unconfirmed',409,'Stop not confirmed; queued message is preserved');
        authorizeHumanContinuation(id);
        if(closed||continuity.blocked(id)||branching.has(id))throw new DomainError('conversation_busy',409,'Conversation is not available to send');
        const nativeId=chat(id).nativeId,client=live.get(id)?.client;
        // The foreground turn can acknowledge interruption before its background commands exit.
        if(nativeId&&client?.assertReloadable){
          try{await client.assertReloadable(nativeId);}
          catch(error){
            if(!backgroundNotConfirmed(error))throw error;
            if(!closed&&read()?.state==='queued'&&live.get(id)?.client===client&&chat(id).nativeId===nativeId)
              waitForQueuedBackground(id,inputId,client,nativeId);
            return;
          }
          if(closed)return;
          if(live.get(id)?.client!==client||chat(id).nativeId!==nativeId)throw new DomainError('execution_changed',409,'Execution changed; refresh before sending');
          authorizeHumanContinuation(id);
        }
        input=read();if(!input||input.state!=='queued')return;
        store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=? AND state='queued'").run(input.id);
        await run(id,input.text,true,false,undefined,input.id,attachments,input.references,true);
      } finally {
        queueStarts.delete(id);
        if(!closed&&!backgroundSends.has(id))queueMicrotask(()=>{void pump(id);});
      }
    },
    listUserInputs: id => {
      const waiting=new Set(store.database.prepare("SELECT w.owner_id FROM task_directory_waits w JOIN task_user_inputs i ON i.id=w.owner_id WHERE w.kind='input' AND i.conversation_id=?").all(id).map(row=>row.owner_id));
      const background=backgroundSends.get(id)?.inputId;
      return scheduler.listUserInputs(id).map(input=>{
        if(input.state!=='queued')return input;
        if(input.id===background)return {...input,waitingReason:'background' as const};
        return waiting.has(input.id)?{...input,waitingReason:'directory' as const}:input;
      });
    },
    cancelUserInput: id => {
      const input=scheduler.cancelUserInput(id);
      messages.cancel(id);
      const pending=backgroundSends.get(input.conversationId);
      if(pending?.inputId===id){
        clearTimeout(pending.timer);
        backgroundSends.delete(input.conversationId);
        queueMicrotask(()=>{void pump(input.conversationId);});
      }
      return input;
    },
    authorizeConversationRead,
    authorizeConversationReference(id,recipientAgentId) {
      authorizeConversationRead(id);
      const source=chat(id);
      authorizeConversationRuns(store.listConversationTaskRuns(id),recipientAgentId);
      authorizeReceiptHistory(id,recipientAgentId);
      if(memoryRuntime)memoryRuntime.memory.history({...root,agentId:recipientAgentId},{projectId:source.projectId||null,items:memoryHistoryReferences(store,id)});
    },
    isDedicatedConversation: id => Boolean(store.database.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? AND json_extract(routing,'$.mode')='dedicated'").get(id)),
    async callBoundTool(token, name, args, commandKey) {
      const bound = tools.get(token), runtime = bound && live.get(bound.conversationId);
      if (!bound || !runtime || runtime.runId !== bound.invocationId || !runtime.invocation || runtime.stopRequested || runtime.controller.signal.aborted) throw new DomainError("forbidden",403,"Expired tool binding");
      if(name.startsWith('mandala_')){
        const source={agentId:bound.agentId,conversationId:bound.conversationId,invocationId:bound.invocationId,humanEventId:runtime.humanEventId,assertActive:()=>assertActive()};
        const assertActive=()=>{if(tools.get(token)!==bound||live.get(bound.conversationId)!==runtime||runtime.runId!==bound.invocationId||!runtime.invocation||runtime.stopRequested||runtime.controller.signal.aborted)throw new DomainError('forbidden',403,'Expired tool binding');};
        await coordination.verify(source);assertActive();
        const fields:Record<string,string[]>={mandala_directory:[],mandala_discover_capabilities:['runtimes','directories','query','limit'],mandala_discover_work:['runtimes','includePaths','excludePaths','limit'],mandala_planning_guide:[],mandala_goals:[],mandala_receipts:['taskId'],mandala_create:['goal','criteria','projectId'],mandala_takeover:['taskId','expectedRevision','criteria'],mandala_request:['taskId','expectedRevision','text','blocked'],mandala_configure:['change','mode'],mandala_temporary:['templateAgentId','name','projectId'],mandala_delegate:['taskId','targetAgentId','projectId','request','criteria']};
        if(!fields[name]||!args||Array.isArray(args)||Object.keys(args).some(k=>!fields[name].includes(k)))throw new DomainError('invalid_tool_arguments',422,'Unknown coordination argument');
        if(Object.hasOwn(args,'criteria'))args={...args,criteria:boundTaskCriteria(args.criteria)};
        if(name==='mandala_planning_guide')return mandalaPlanningSkill;
        if(name==='mandala_discover_work'||name==='mandala_discover_capabilities'){
          if(chat(bound.conversationId).purpose!=='mandala-main')throw new DomainError('forbidden',403,'Work discovery requires the primary coordinator chat');
          const config=await coordination.verify(source,true);assertActive();
          const result=name==='mandala_discover_work'?await discoverWorkDirectories(config,args as WorkDiscoveryInput):await discoverTeamCapabilities(config,args as TeamCapabilityInput);assertActive();return result;
        }
        if(name==='mandala_directory'){const config=await loadConfig();assertActive();return {...mandalaDirectory(config),invocation:{tasks:true,automations:!!automationService,project:!!bound.projectId,assets:!!runtime.artifacts,memory:!!memoryRuntime,skills:!!skillTools,wiki:!!(bound.projectId||bound.agentId),codeGraph:!!runtime.codeGraphScope?.bindings.length,coordinator:true}};}
        if(name==='mandala_goals')return coordination.list().map(own=>({...own,task:tasks.getTask({...root,agentId:source.agentId},own.taskId)}));
        if(name==='mandala_receipts'){coordination.requireOwned(source,String(args.taskId));const p={...root,agentId:source.agentId};return tasks.listReceipts(p,String(args.taskId));}
        if(name==='mandala_create')return coordination.create(source,args as unknown as Parameters<typeof coordination.create>[1],commandKey);
        if(name==='mandala_takeover')return coordination.takeover(source,args as unknown as Parameters<typeof coordination.takeover>[1],commandKey);
        if(name==='mandala_request')return coordination.request(source,args as unknown as Parameters<typeof coordination.request>[1],commandKey);
        if(name==='mandala_configure')return coordination.configure(source,args.change as import('../shared/mandala-coordination').ManagedChange,args.mode as 'direct'|'propose',commandKey,assertActive);
        if(name==='mandala_temporary')return coordination.temporary(source,args as unknown as Parameters<typeof coordination.temporary>[1],commandKey,assertActive);
        if(name==='mandala_delegate'){
          const task=coordination.requireOwned(source,String(args.taskId));
          if(!Object.hasOwn(args,'projectId')||args.projectId!==null&&typeof args.projectId!=='string'||typeof args.targetAgentId!=='string'||typeof args.request!=='string'||!Array.isArray(args.criteria)||!args.criteria.length)throw new DomainError('invalid_delegation',422,'Explicit executor, project (null allowed), request and criteria required');
          const config=await loadConfig(),context=conversationContext(config,{projectId:args.projectId as string??'',agentId:args.targetAgentId},'');assertActive();
          if(context.agent.systemRole&&!isSystemAgent(config,context.agent.id))throw new DomainError('invalid_executor',422,'Select an execution Agent');
          assertExecutionAvailable(config,{projectId:args.projectId as string??'',agentId:args.targetAgentId});
          const startKey='mandala-start:'+source.conversationId+':'+commandKey,prior=tasks.findStart(root,task.id,startKey);
          if(prior){const execution=tasks.listExecutions(root,task.id).find(item=>item.id===prior.executionId)!;if(execution.agentId!==args.targetAgentId||execution.projectId!==args.projectId||execution.request!==args.request||JSON.stringify(execution.criteria)!==JSON.stringify(args.criteria))throw new DomainError('idempotency_conflict',409,'idempotency_conflict');return prior;}
          if(['completed','cancelled'].includes(tasks.getTask(root,task.id).state))throw new DomainError('goal_not_active',409,'Goal is no longer active');
          goalByInvocation.set(source.invocationId,task.id);
          return manager.startDurableTask(task.id,task.revision,startKey,undefined,{agentId:args.targetAgentId,projectId:args.projectId as string|null,request:args.request,criteria:args.criteria as import('../shared/tasks').Criterion[],continuation:{taskId:task.id,conversationId:coordination.ownership(task.id)!.conversationId,epoch:task.continuationEpoch,policy:'notify'},assertActive});
        }
      }
      if(name==='progress_report'){
        if(!commandKey||commandKey.length>200||!commandKey.trim()||!args||Array.isArray(args)||Object.keys(args).some(k=>!['text','steps'].includes(k))||typeof args.text!=='string'||!args.text.trim()||args.text.length>2000||args.steps!==undefined&&(!Array.isArray(args.steps)||args.steps.length>50||args.steps.some(step=>!step||typeof step!=='object'||Array.isArray(step)||Object.keys(step).some(k=>!['text','status'].includes(k))||typeof step.text!=='string'||!step.text.trim()||step.text.length>500||!['pending','running','completed','blocked'].includes(step.status))))throw new DomainError('invalid_progress_report',422,'Provide public progress text and optional explicit steps');
        return store.transaction(()=>{
          const previous=store.database.prepare("SELECT id,data,createdAt FROM events WHERE conversationId=? AND kind='progress' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.commandKey')=?").get(bound.conversationId,bound.invocationId,commandKey);
          const report={text:args.text,...(args.steps!==undefined?{steps:(args.steps as {text:string;status:string}[]).map(step=>({text:step.text,status:step.status}))}:{})};
          if(previous){const data=JSON.parse(previous.data as string);if(JSON.stringify({text:data.text,...(data.steps!==undefined?{steps:data.steps}:{})})!==JSON.stringify(report))throw new DomainError('command_conflict',409,'Progress key already used with different input');return {id:Number(previous.id),conversationId:bound.conversationId,kind:'progress',data,createdAt:previous.createdAt};}
          return appendEvent(bound.conversationId,'progress',{...report,source:'cli',agentId:chat(bound.conversationId).agentId||null,commandKey});
        });
      }
      if(name.startsWith('code_graph_')){
        const scope=runtime.codeGraphScope;
        if(!scope)throw new DomainError('forbidden',403,'CodeGraph read scope unavailable');
        const assertActive=()=>{const source=chat(bound.conversationId);if(tools.get(token)!==bound||live.get(bound.conversationId)!==runtime||runtime.runId!==bound.invocationId||!runtime.invocation||runtime.stopRequested||runtime.controller.signal.aborted||source.agentId!==scope.agentId||source.projectId!==scope.projectId||source.workspaceId!==undefined&&source.workspaceId!==scope.workspaceId||source.cwd!==scope.cwd)throw new DomainError('forbidden',403,'Expired CodeGraph invocation');};
        if(name==='code_graph_status'){if(Object.keys(args).length)throw new DomainError('invalid_tool_arguments',422,'Status takes no arguments');return codeGraph.boundStatus(scope,assertActive);}
        if(name==='code_graph_refresh'){if(Object.keys(args).some(key=>key!=='bindingId')||typeof args.bindingId!=='string')throw new DomainError('invalid_tool_arguments',422,'Binding required');return codeGraph.boundRefresh(scope,args.bindingId,assertActive);}
        return codeGraph.query(scope,name.slice('code_graph_'.length),args,assertActive);
      }
      if(name.startsWith('wiki_')){
        const source=chat(bound.conversationId);
        if(source.projectId!==bound.projectId||source.agentId!==bound.agentId)throw new DomainError('forbidden',403,'Invocation context changed');
        if(!source.projectId&&!source.agentId)throw new DomainError('wiki_project_required',422,'Choose a Project for Wiki knowledge');
        const fields:Record<string,string[]>={wiki_list:[],wiki_create:['name','purpose','projectId','maintainerAgentId','automatic','reception'],wiki_get:['baseId'],wiki_read:['baseId','pageId','versionId'],wiki_search:['baseId','query'],wiki_add_source:['baseId','assetId','versionId','replace'],wiki_remove_source:['baseId','sourceId'],wiki_configure:['baseId','expectedRevision','automatic','reception','purpose','maintainerAgentId'],wiki_refresh:['baseId'],wiki_edit:['baseId','pageId','body','expectedHeadVersionId'],wiki_versions:['baseId'],wiki_restore:['baseId','versionId','expectedHeadVersionId']};
        if(!fields[name]||!args||Object.keys(args).some(key=>!fields[name].includes(key)))throw new DomainError('invalid_tool_arguments',422,'Invalid Wiki arguments');
        const assertActive=()=>{if(tools.get(token)!==bound||live.get(bound.conversationId)!==runtime||runtime.runId!==bound.invocationId||!runtime.invocation||runtime.stopRequested||runtime.controller.signal.aborted||chat(bound.conversationId).agentId!==source.agentId||chat(bound.conversationId).projectId!==source.projectId)throw new DomainError('forbidden',403,'Expired tool binding');};
        const p=knowledgeBase.bindPrincipal({...root,agentId:source.agentId,runId:bound.invocationId},source.projectId,assertActive);
        assertActive();
        if(args.projectId!==undefined&&args.projectId!==source.projectId)throw new DomainError('forbidden',403,'Wiki Project is bound by the host');
        const {baseId,...input}=args;
        if(name==='wiki_list')return knowledgeBase.list(p);
        if(name==='wiki_create')return knowledgeBase.command(p,name,args,commandKey,assertActive,()=>knowledgeBase.create(p,{...input,projectId:source.projectId} as Parameters<KnowledgeBase['create']>[1],assertActive));
        if(typeof baseId!=='string')throw new DomainError('invalid_tool_arguments',422,'baseId required');
        if(name==='wiki_get')return knowledgeBase.get(p,baseId);
        if(name==='wiki_read')return knowledgeBase.readPage(p,baseId,String(args.pageId),args.versionId as string|undefined);
        if(name==='wiki_search')return knowledgeBase.search(p,baseId,String(args.query??''));
        if(name==='wiki_versions')return knowledgeBase.versions(p,baseId);
        return knowledgeBase.command(p,name,args,commandKey,assertActive,async()=>{
          if(name==='wiki_refresh')return knowledgeBase.refresh(p,baseId,assertActive);
          if(name==='wiki_remove_source')return knowledgeBase.removeSource(p,baseId,String(args.sourceId),assertActive);
          if(name==='wiki_add_source')return knowledgeBase.addSource(p,baseId,input as Parameters<KnowledgeBase['addSource']>[2],assertActive);
          if(name==='wiki_configure')return knowledgeBase.configure(p,baseId,input as Parameters<KnowledgeBase['configure']>[2],assertActive);
          if(name==='wiki_edit')return knowledgeBase.editPage(p,baseId,input as Parameters<KnowledgeBase['editPage']>[2],assertActive);
          return knowledgeBase.restore(p,baseId,String(args.versionId),String(args.expectedHeadVersionId),assertActive);
        });
      }
      if(name==='message_ask')return this.askAgent(bound.conversationId,args as unknown as AgentMessageInput,{commandKey,boundInvocationId:bound.invocationId});
      if(name==='message_read'){if(Object.keys(args).some(k=>k!=='messageId')||typeof args.messageId!=='string')throw new DomainError('invalid_message',422,'Message ID required');return this.getAgentMessage(args.messageId,chat(bound.conversationId).agentId);}
      if (name.startsWith('skill_')) {
        const source = chat(bound.conversationId);
        if (!skillTools || !source.agentId) throw new DomainError('forbidden', 403, 'Skill tools require a configured Agent');
        return skillTools(source.agentId, name, args, commandKey, () => {
          if (chat(bound.conversationId).agentId!==source.agentId || chat(bound.conversationId).projectId!==source.projectId || tools.get(token) !== bound || live.get(bound.conversationId) !== runtime || runtime.runId !== bound.invocationId || !runtime.invocation || runtime.stopRequested || runtime.controller.signal.aborted)
            throw new DomainError('forbidden', 403, 'Expired tool binding');
        },undefined,{projectId:source.projectId});
      }
      if(name.startsWith('automation_')) {
        const service=automationService;if(!service)throw new DomainError('automation_unavailable',503,'Automation service unavailable');
        const source=chat(bound.conversationId),p={...root,agentId:source.agentId};
        const allowed:Record<string,string[]>={automation_list:[],automation_create:['executionMode','goalId','missedPolicy','overlapPolicy','taskId','conversationId','name','instructions','projectId','agentId','cli','workspaceId','enabled','schedule'],automation_update:['executionMode','missedPolicy','overlapPolicy','automationId','expectedRevision','conversationId','name','instructions','projectId','agentId','cli','workspaceId','enabled','schedule'],automation_remove:['automationId','expectedRevision'],automation_run:['automationId'],automation_stop:['automationId']};
        if(!allowed[name]||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed[name].includes(k)))throw new DomainError('invalid_tool_arguments',422,'Invalid automation arguments');
        const config=await loadConfig(),isMain=config.mandala?.agentId===source.agentId&&config.agents.some(a=>a.id===source.agentId&&a.systemRole==='mandala');
        const assertActive=()=>{if(tools.get(token)!==bound||live.get(bound.conversationId)!==runtime||runtime.runId!==bound.invocationId||!runtime.invocation||runtime.stopRequested||runtime.controller.signal.aborted)throw new DomainError('forbidden',403,'Expired tool binding');};
        const authorizeHuman=()=>coordination.verify({agentId:source.agentId,conversationId:source.id,invocationId:bound.invocationId,humanEventId:runtime.humanEventId,assertActive},true);
        const state=await service.list();assertActive();
        const readable=(id:string|null|undefined)=>{if(!id)return false;try{tasks.getTask(p,id);return true;}catch{return false;}};
        const ownStandalone=(a:import('../shared/automations').Automation)=>!a.goalId&&!a.taskId&&(a.createdByAgentId??a.agentId)===source.agentId&&(isMain||(a.createdFromProjectId??a.projectId)===source.projectId);
        const accessible=(a:import('../shared/automations').Automation)=>a.goalId||a.taskId?readable(a.goalId??a.taskId):ownStandalone(a);
        if(name==='automation_list'){const rules=state.automations.filter(accessible),ids=new Set(rules.map(a=>a.id));return {...state,automations:rules,runs:state.runs.filter(r=>ids.has(r.automationId))};}
        if(name==='automation_create'){
          if(isMain)await authorizeHuman();
          if(args.goalId!==undefined){
            if(!isMain||typeof args.goalId!=='string'||coordination.ownership(args.goalId)?.agentId!==source.agentId||!readable(args.goalId))throw new DomainError('forbidden',403,'Owned goal required');
            return service.create(args,commandKey,assertActive,{agentId:source.agentId,projectId:source.projectId,conversationId:source.id});
          }
          if(args.taskId===undefined||args.taskId===null){
            if(!isMain&&(args.agentId!==source.agentId||args.projectId!==source.projectId))throw new DomainError('forbidden',403,'Matching Agent and Project required');
            return service.create(args,commandKey,assertActive,{agentId:source.agentId,projectId:source.projectId,conversationId:source.id});
          }
          if(typeof args.taskId!=='string'||!readable(args.taskId))throw new DomainError('forbidden',403,'Explicit accessible Task required');
          const task=tasks.getTask(p,args.taskId),unassigned=args.agentId===''&&task.assigneeAgentId===null&&args.enabled===false;
          if(args.agentId!==source.agentId&&!unassigned)throw new DomainError('forbidden',403,'Matching Agent or disabled unassigned rule required');
          return service.create(args,commandKey,assertActive,{agentId:source.agentId,projectId:source.projectId,conversationId:source.id});
        }
        const {automationId,...patch}=args,a=state.automations.find(a=>a.id===automationId);
        if(!a||!accessible(a)||a.goalId&&(!isMain||coordination.ownership(a.goalId)?.agentId!==source.agentId))throw new DomainError('forbidden',403,'Automation unavailable to this Agent');
        if(name==='automation_update'){
          if(isMain&&!(Object.keys(patch).every(key=>['expectedRevision','enabled'].includes(key))&&(patch.enabled===false||patch.enabled===true&&a.enabled)))await authorizeHuman();
          if(ownStandalone(a)&&!isMain&&patch.projectId!==undefined&&patch.projectId!==source.projectId)throw new DomainError('forbidden',403,'Project mismatch');
          if(patch.agentId!==undefined&&patch.agentId!==source.agentId&&!(isMain&&a.goalId&&coordination.ownership(a.goalId)?.agentId===source.agentId))throw new DomainError('forbidden',403,'Agent mismatch');
          return service.update(a.id,patch,assertActive);
        }
        if(name==='automation_remove'){await service.remove(a.id,Number(patch.expectedRevision));return {ok:true};}
        if(name==='automation_run'){if(isMain&&!a.enabled)await authorizeHuman();return service.runNow(a.id,commandKey,assertActive);}
        if(name==='automation_stop'){const active=state.runs.filter(r=>r.automationId===a.id&&['queued','starting','running','approval','unknown'].includes(r.status));return Promise.all(active.map(r=>service.stopRun(r.id)));}
      }
      if (name.startsWith('task_') || name.startsWith('conversation_')) {
        const source=chat(bound.conversationId),p={...root,...(source.agentId?{agentId:source.agentId}:{})};
        const fields:Record<string,string[]>={task_review:['taskId','expectedRevision'],task_mark_completed:['taskId','expectedRevision'],task_accept:['taskId','expectedRevision'],task_reopen:['taskId','expectedRevision','reason','expectedOutput'],task_request_changes:['taskId','expectedRevision','reason','expectedOutput'],task_assign:['taskId','expectedRevision','agentId'],task_cancel:['taskId','expectedRevision'],task_start:['taskId','expectedRevision','conversationId'],task_stop:['taskId','expectedRevision'],task_runs:['taskId'],task_context:[],task_list:['query','projectId','conversationId'],task_read:['taskId'],task_create:['goal','criteria','projectId','assigneeAgentId','participantAgentIds','originConversationId','acceptance'],task_update:['taskId','expectedRevision','goal','criteria','projectId','assigneeAgentId','participantAgentIds','originConversationId','state'],task_execution_add:['taskId','expectedRevision','conversationId'],task_execution_remove:['taskId','expectedRevision','executionId'],conversation_list:['query','projectId','agentId'],conversation_read:['conversationId'],conversation_history:['conversationId','after']};
        const allowed=fields[name];if(!allowed)throw new DomainError('forbidden',403,'Command unavailable to Agents');
        if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))throw new DomainError('invalid_tool_arguments',422,'Unknown Task or conversation argument');
        if(Object.hasOwn(args,'criteria'))args={...args,criteria:boundTaskCriteria(args.criteria)};
        const config=await loadConfig();
        if(tools.get(token)!==bound||runtime.invocation===undefined||runtime.stopRequested||runtime.controller.signal.aborted)throw new DomainError('forbidden',403,'Expired tool binding');
        const canRead=(id:string)=>{const c=chat(id);if(source.agentId!==c.agentId)throw new DomainError('forbidden',403,'Conversation unavailable to this Agent');authorizeConversationRead(id,true);if(memoryRuntime)memoryRuntime.memory.history(p,{projectId:c.projectId||null,items:memoryHistoryReferences(store,id)});return c;};
        const listConversations=()=>store.listConversations().filter(c=>{try{canRead(c.id);return (!args.projectId||c.projectId===args.projectId)&&(!args.agentId||c.agentId===args.agentId)&&(!args.query||(c.title??'').toLowerCase().includes(String(args.query).toLowerCase()));}catch(error){if(error instanceof DomainError&&error.status===403)return false;throw error;}}).slice(0,100).map(({id,title,projectId,agentId,status})=>({id,title,projectId,agentId,status}));
        if(name==='task_context')return {conversationId:source.id,project:config.projects.find(v=>v.id===source.projectId)?{id:source.projectId,name:config.projects.find(v=>v.id===source.projectId)!.name}:null,agent:config.agents.find(v=>v.id===source.agentId)?{id:source.agentId,name:config.agents.find(v=>v.id===source.agentId)!.name}:null};
        if(name==='conversation_list')return listConversations();
        if(name==='conversation_read'||name==='conversation_history'){
          if(typeof args.conversationId!=='string')throw new DomainError('invalid_tool_arguments',422,'Conversation ID required');
          const c=canRead(args.conversationId),after=args.after??0;if(!Number.isSafeInteger(after)||Number(after)<0)throw new DomainError('invalid_tool_arguments',422,'Invalid event cursor');
          const events=store.listAgentHistory(c.id,Number(after),name==='conversation_read');
          return name==='conversation_read'?{conversation:{id:c.id,title:c.title,projectId:c.projectId,agentId:c.agentId,status:c.status},events}:events;
        }
        if(name==='task_list'&&isSystemAgent(config,source.agentId)){const observed=await tasks.observeTasks(p);return observed.filter(t=>(!args.projectId||t.projectId===args.projectId)&&(!args.query||t.goal.toLowerCase().includes(String(args.query).toLowerCase()))&&(!args.conversationId||tasks.listTasks(p).some(own=>own.id===t.id&&own.conversationIds.includes(String(args.conversationId))))).slice(0,100);}
        if(name==='task_read'&&isSystemAgent(config,source.agentId)){if(typeof args.taskId!=='string')throw new DomainError('invalid_tool_arguments',422,'Task ID required');const observed=await tasks.observeTasks(p);const task=observed.find(t=>t.id===args.taskId);if(!task)throw new DomainError('task_not_found',404,'task_not_found');return task;}
        if(name==='task_runs'&&isSystemAgent(config,source.agentId)){if(typeof args.taskId!=='string')throw new DomainError('invalid_tool_arguments',422,'Task ID required');return tasks.observeRuns(p,args.taskId);}
        if(name==='task_list')return tasks.listTasks(p).filter(t=>(!args.projectId||t.projectId===args.projectId)&&(!args.conversationId||t.conversationIds.includes(String(args.conversationId)))&&(!args.query||t.goal.toLowerCase().includes(String(args.query).toLowerCase()))).slice(0,100);
        if(name==='task_runs'){if(typeof args.taskId!=='string')throw new DomainError('invalid_tool_arguments',422,'Task ID required');return tasks.listRuns(p,args.taskId);}
        if(name==='task_read'){if(typeof args.taskId!=='string')throw new DomainError('invalid_tool_arguments',422,'Task ID required');return tasks.getTask(p,args.taskId);}
        if(name==='task_create'){
          if(!Object.hasOwn(args,'projectId'))throw new DomainError('invalid_tool_arguments',422,'Explicit projectId required; null is allowed');
          validateTaskConfiguration(config,args);if(args.projectId!==null&&source.agentId&&!isSystemAgent(config,source.agentId)&&!config.projects.find(v=>v.id===args.projectId)?.agentIds.includes(source.agentId))throw new DomainError('forbidden',403,'Project unavailable to this Agent');
          return tasks.createTask(p,args as unknown as import('../shared/tasks').TaskInput,commandKey);
        }
        if(typeof args.taskId!=='string')throw new DomainError('invalid_tool_arguments',422,'Task ID required');
        const {taskId,expectedRevision,...patch}=args;
        if(!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<1)throw new DomainError('invalid_tool_arguments',422,'Valid expectedRevision required');
        if(name==='task_start'||name==='task_stop'){tasks.getTask(p,taskId);return name==='task_start'?manager.startDurableTask(taskId,expectedRevision as number,commandKey,args.conversationId as string|null|undefined):manager.stopDurableTask(taskId,expectedRevision as number);}
        if(name==='task_mark_completed'&&runtime.durableRun?.taskId===taskId)return tasks.requestCompletion({...p,runId:runtime.durableRun.id},taskId,Number(expectedRevision),commandKey);
        if(name==='task_cancel'){tasks.getTask(p,taskId);const result=await manager.stopDurableTask(taskId,Number(expectedRevision),true);manager.presentTaskDecision(taskId);return result;}
        if(name==='task_mark_completed'){const result=tasks.moveTask(p,taskId,Number(expectedRevision),'completed',null,commandKey);manager.presentTaskDecision(taskId);return result;}
        if(['task_review','task_accept','task_reopen','task_request_changes','task_assign'].includes(name)){
          if(name==='task_assign'){if(!Object.hasOwn(args,'agentId'))throw new DomainError('invalid_tool_arguments',422,'agentId required; null clears assignment');validateTaskConfiguration(config,{assigneeAgentId:args.agentId});}
          const action=name==='task_review'?'complete':name.slice(5) as 'accept'|'reopen'|'request_changes'|'assign';
          const result=tasks.userCommand(p,taskId,Number(expectedRevision),action,(name==='task_assign'?args.agentId:args.reason??null) as string|null,args.expectedOutput as import('../shared/tasks').ExpectedOutput|undefined,commandKey);
          if(name==='task_accept')manager.presentTaskDecision(taskId);
          return result;
        }
        if(name==='task_execution_add'){
          if(typeof args.conversationId!=='string')throw new DomainError('invalid_tool_arguments',422,'Conversation ID required');
          canRead(args.conversationId);return tasks.attachExecution(p,taskId,Number(expectedRevision),args.conversationId,commandKey);
        }
        if(name==='task_execution_remove'){
          if(typeof args.executionId!=='string')throw new DomainError('invalid_tool_arguments',422,'Execution ID required');
          return tasks.removeExecution(p,taskId,Number(expectedRevision),args.executionId,commandKey);
        }
        validateTaskConfiguration(config,patch);if(patch.projectId&&source.agentId&&!isSystemAgent(config,source.agentId)&&!config.projects.find(v=>v.id===patch.projectId)?.agentIds.includes(source.agentId))throw new DomainError('forbidden',403,'Project unavailable to this Agent');
        const previous=tasks.getTask(p,taskId),result=tasks.updateTask(p,taskId,expectedRevision as number,patch as import('../shared/tasks').TaskPatch,commandKey);
        return {...result,unchanged:isDeepStrictEqual({...previous,revision:result.revision,activityAt:result.activityAt,live:result.live},result)};
      }
      if(name==="memory_search"||name==="memory_read") {
        if(!memoryRuntime)throw new DomainError("memory_unavailable",503,"Memory unavailable");
        const allowed=name==="memory_search"?["query"]:["recordId"];
        if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))throw new DomainError("invalid_tool_arguments",422,"Unknown memory argument");
        const c=chat(bound.conversationId),run=runtime.durableRun;
        const p={...root,...(c.agentId?{agentId:c.agentId}:{}),...(run?{runId:run.id}:{})};
        const projectId=c.projectId||null;
        const kinds=await memoryRuntime.reading(p);
        if(!kinds.length)throw new DomainError('memory_read_disabled',409,'memory_read_disabled');
        let items:MemoryHit[],searchStatus={indexLag:0,degraded:false};
        if(name==="memory_search") {if(typeof args.query!=="string"||args.query.length>2000)throw new DomainError("invalid_tool_arguments",422,"Invalid query");const result=await memoryRuntime.recall.contextSearch(p,{projectId,query:args.query,kinds});items=result.items;searchStatus={indexLag:result.indexLag,degraded:result.degraded};}
        else {
          if(typeof args.recordId!=="string")throw new DomainError("invalid_tool_arguments",422,"Invalid record ID");
          // Human native chats use their trusted project, never the human HTTP global index.
          const record=memoryRuntime.memory.list(p,{projectId,status:"active"}).find(r=>r.recordId===args.recordId);
          if(!record||!kinds.some(kind=>record.pipelines?.includes(kind)??kind==='request'))throw new DomainError("forbidden",403,"Memory unavailable in this conversation");
          if(record.layer==='L3'&&(!record.profileScope||record.profileScope.projectId!==projectId||record.profileScope.agentId!==(p.agentId??null)||record.recordId!==memoryRuntime.memory.profileId(record.profileScope)))throw new DomainError("forbidden",403,"Memory unavailable in this conversation");
          items=[{...record,reason:"按需读取；历史来源，不代表当前状态"}];
        }
        const query=name==="memory_search"?args.query as string:"record:"+args.recordId;
        const used=items.map(({recordId,revision,reason})=>({recordId,revision,reason}));
        memoryRuntime.memory.validateReferences(p,{projectId,items:used});
        if(run)memoryRuntime.recall.recordUse(p,{runId:run.id,query,items:used});
        store.appendEvent(c.id,"metadata",{memoryUse:"acknowledged",invocationId:bound.invocationId,items:used,query,reason:"native_tool_response",causality:"not_established"});
        return name==="memory_search"?{items:items.map(hit=>summarizeMemoryHit(hit,args.query as string)),...searchStatus}:items[0];
      }
      if (name === "project_agents") {
        const source = chat(bound.conversationId), config = await loadConfig(), project = config.projects.find(p => p.id === source.projectId);
        return config.agents.filter(a => project?.agentIds.includes(a.id)).map(({id,name})=>({id,name}));
      }
      if (name === "delegate" && Object.keys(args).some(key=>!["targetAgentId","request","targetConversationId","policy"].includes(key))) throw new DomainError("invalid_tool_arguments",422,"Unknown delegation argument");
      if (name === "delegate") {
        if(chat(bound.conversationId).purpose==='mandala-main')throw new DomainError('coordinator_delegation_required',422,'Use mandala create then mandala delegate for a tracked goal with an explicit executor and projectId (null allowed); use messages ask for a conversation-only inquiry. tasks delegate requires a Project and Agent execution context.');
        const {id,targetConversationId,status} = await this.createTask(bound.conversationId, String(args.targetAgentId ?? ""), String(args.request ?? ""), args.targetConversationId as string | undefined, {policy:args.policy as "notify" | "resume" | undefined,commandKey,boundInvocationId:bound.invocationId});
        return {id,targetConversationId,status};
      }
      if ((name === "artifact_publish" || name === "artifact_update") && runtime.artifacts) {
        const lineage=attachmentAssets.lineage(root,bound.conversationId,sourceId=>authorizeExecutionHistory(sourceId),mandalaContextBoundary(store,bound.conversationId));
        if(!lineage.complete||lineage.refs.some(ref=>!runtime.sourceVersions?.some(source=>source.assetId===ref.assetId&&source.versionId===ref.versionId)))throw new DomainError('attachment_lineage_pending',409,'Recover submitted attachments in Files, then start a new turn before publishing');
        for(const ref of lineage.refs){try{assets.getAuthorizedVersion({...root,agentId:chat(bound.conversationId).agentId,runId:bound.invocationId},ref);}catch(error){if(error instanceof DomainError&&error.status===403)throw new DomainError('attachment_source_forbidden',403,'Grant this Agent access to the submitted attachment in Files, or use a new conversation before publishing');throw error;}}
        return name === "artifact_update"?runtime.artifacts.update(args,commandKey):runtime.artifacts.publish(args,commandKey);
      }
      if (name === "artifact_read" && runtime.artifacts) return runtime.artifacts.read(args);
      throw new DomainError("forbidden",403,"Unknown bound tool");
    },
    branch: (id, eventId, text) => revise(id, eventId, text, false),
    edit: (id, eventId, text) => revise(id, eventId, text, true),
    fork: async (id, eventId) => {
      if (chat(id).purpose === 'mandala-main') throw new DomainError('primary_conversation', 422, 'Primary chat is one continuous conversation and cannot be forked');
      if (eventId === undefined) {
        authorizeConversationRead(id, true);
        if (continuity.blocked(id) || branching.has(id) || live.get(id)?.preparing || ["running", "approval"].includes(chat(id).status))
          throw new Error("conversation busy");
        const events = store.listEvents(id, 0);
        const checkpoint = [...events].reverse().find(event => event.kind === "status" && (event.data as {status?: string}).status === "idle");
        const lastUser = [...events].reverse().find(event => event.kind === "user");
        if (chat(id).status !== "idle" || !checkpoint || !lastUser || checkpoint.id < lastUser.id)
          throw new Error("No completed reply to fork");
        eventId = checkpoint.id;
      }
      return revise(id, eventId, "", false, true);
    },
    send: (id, text, attachments, references) => {authorizeHumanContinuation(id);
      if(queuedSendPending(id)||continuity.blocked(id)){manager.enqueueUserInput(id,text,randomUUID(),attachments?.map(item=>item.id),references);return Promise.resolve();}
      return run(id, text, false, false, undefined, undefined, attachments, references);},
    async continue(id, text, attachments = [], references = [], commandKey) {
      authorizeHumanContinuation(id);
      if (commandKey === undefined) {
        if(queuedSendPending(id)||continuity.blocked(id)){manager.enqueueUserInput(id,text,randomUUID(),attachments.map(item=>item.id),references);return;}
        return run(id, text, true, false, undefined, undefined, attachments, references);
      }
      const prior = scheduler.listUserInputs(id).find(input => input.commandKey === commandKey);
      // Validate an existing key against the original payload before acknowledging it.
      if (prior) {
        scheduler.enqueueUserInput(id,text,commandKey,attachments.map(item=>item.id),references);
        if(prior.state==='cancelled'||prior.unrecorded)throw new DomainError('submission_not_executed',409,'Submission was not executed; revise the input before retrying');
        if(prior.state==='unknown')throw new DomainError('submission_unknown',409,'Submission status is uncertain; check the original task');
        return;
      }
      if(queuedSendPending(id)||continuity.blocked(id)){manager.enqueueUserInput(id,text,commandKey,attachments.map(item=>item.id),references);return;}
      const c = chat(id);
      if (branching.has(id) || live.get(id)?.preparing || c.status === 'running' || c.status === 'approval') throw new Error('conversation busy');
      // Persist acceptance before asynchronous native setup, using the queue's existing identity.
      const input = scheduler.enqueueUserInput(id,text,commandKey,attachments.map(item=>item.id),references);
      store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(input.id);
      return run(id,text,true,false,undefined,input.id,attachments,references);
    },
    executionId(id) { return live.get(id)?.runId ?? null; },
    async stop(id, expectedExecutionId, continueQueued=false) {
      if (expectedExecutionId !== undefined && (live.get(id)?.runId ?? null) !== expectedExecutionId)
        throw new DomainError('execution_changed', 409, 'Execution changed; refresh before stopping');
      if(chat(id).purpose==='mandala-main'){
        coordination.pauseDelivery(id);
        if(live.get(id)?.preparing||['running','approval'].includes(chat(id).status))await stopInvocation(id);
        const confirmed=!live.get(id)?.invocation&&!hasUnprovenNativeOccupancy(store,id)&&!store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id);
        if(confirmed&&continueQueued){const next=scheduler.listUserInputs(id).find(input=>input.state==='queued'&&isHumanInput(input));if(next)await manager.sendQueuedInput(id,next.id,manager.executionId(id));}
        return confirmed;
      }
      const stoppedExecutionId=manager.executionId(id);
      const runtime=live.get(id);
      let goalId=runtime?.durableRun?.taskId??(runtime?.runId?goalByInvocation.get(runtime.runId):undefined),inquiryRunId:string|undefined;
      const sourceInvocation=runtime?.runId??stoppedExecutionId;
      if(!goalId&&sourceInvocation)try{const wait=tasks.findInquiryWait(root,sourceInvocation,id);goalId=wait?.taskId;inquiryRunId=wait?.runId;}catch(error){if(!(error instanceof DomainError)||error.code!=='inquiry_resume_unavailable')throw error;}
      const revoke=(taskId:string)=>store.transaction(()=>{
        const previous=tasks.getTask(root,taskId);
        store.database.prepare('UPDATE work_tasks SET continuation_epoch=continuation_epoch+1,future_auto_resume=0,revision=revision+1 WHERE id=?').run(taskId);
        // A source stop revokes result delivery, while another execution can still finish its own inquiry.
        store.database.prepare("UPDATE task_inquiry_waits SET task_revision=?,continuation_epoch=? WHERE task_revision=? AND continuation_epoch=? AND resumed_by_run_id IS NULL AND run_id IN (SELECT id FROM task_runs WHERE task_id=? AND json_extract(routing,'$.executionConversationId')<>?)").run(previous.revision+1,previous.continuationEpoch+1,previous.revision,previous.continuationEpoch,taskId,id);
        store.database.prepare("UPDATE task_receipts SET delivery_state='parked' WHERE task_id=? AND delivery_state<>'consumed'").run(taskId);
        store.enqueueOutbox({type:'task.continuation_revoked',aggregateId:taskId,aggregateRevision:previous.revision+1,causationId:stoppedExecutionId??randomUUID(),payload:{taskId}});
      });
      if(goalId){const task=tasks.getTask(root,goalId);if(task.originConversationId===id)revoke(goalId);if(inquiryRunId)tasks.stopInquiryWait(root,inquiryRunId);presentTaskReceipts(goalId,id,false);}
      const waitingRequests=store.database.prepare("SELECT m.request_input_id FROM agent_messages m JOIN task_user_inputs i ON i.id=m.request_input_id WHERE m.target_conversation_id=? AND m.state='running' AND i.state='completed'").all(id);
      const stoppedMessages=messages.stop(id)+waitingRequests.length;
      for(const request of waitingRequests)finishMessageInput(request.request_input_id as string,'failed','询问已停止');
      // Also works while the source has yielded its native turn to wait for a helper.
      let stoppedGoal=!!goalId;
      for(const row of store.database.prepare("SELECT DISTINCT json_extract(continuation,'$.taskId') AS id FROM task_runs WHERE json_extract(continuation,'$.conversationId')=? AND json_extract(continuation,'$.policy')='resume'").all(id)){
        if(row.id===goalId)continue;const task=tasks.getTask(root,row.id as string);if(task.futureAutoResume){revoke(task.id);stoppedGoal=true;}
      }
      if(runtime?.preparing||['running','approval'].includes(chat(id).status))await stopInvocation(id);
      else if(!stoppedMessages&&!stoppedGoal)throw new Error('conversation not running');
      const releasedExecutionId=manager.executionId(id);
      if(live.get(id)?.preparing||['running','approval'].includes(chat(id).status)||releasedExecutionId!==null&&releasedExecutionId!==stoppedExecutionId)throw new DomainError('execution_changed',409,'Execution changed; refresh before stopping');
      const confirmed=!live.get(id)?.invocation && !hasUnprovenNativeOccupancy(store,id) &&
        !store.database.prepare('SELECT owner_id FROM task_directory_claims WHERE conversation_id=? AND submitted=1').get(id);
      if(confirmed&&continueQueued){const next=scheduler.listUserInputs(id).find(input=>input.state==='queued'&&isHumanInput(input));if(next)await manager.sendQueuedInput(id,next.id,releasedExecutionId);}
      return confirmed;
    },
    submitAsyncQuestion(id,approvalId,answers,telegramRequestId) {
      authorizeExecutionHistory(id);
      const submit=()=>{
        const approval=asyncQuestions(store,id).find(a=>a.id===approvalId);
        if(!approval)throw new Error('question expired');
        const text=asyncQuestionReply(approval,answers);
        const input=telegramRequestId?manager.enqueueTelegramInput(id,text,telegramRequestId,[]):manager.enqueueUserInput(id,text,approval.id);
        store.appendEvent(id,'metadata',{answeredQuestionId:approval.id,queuedInputId:input.id});
        return input;
      };
      return store.database.isTransaction?submit():store.transaction(submit);
    },
    async answerQuestions(id, approvalId, answers) {
      authorizeExecutionHistory(id);
      if(approvalId.startsWith('async:')){manager.submitAsyncQuestion(id,approvalId,answers);return;}
      const c=chat(id),r=live.get(id),approval=r?.approvals.get(approvalId);
      if(!r?.client||!approval||r.stopRequested||!["running","approval"].includes(c.status)||
         approval.method!=="item/tool/requestUserInput"||(approval.params as {turnId?:string}).turnId!==r.invocation?.nativeTurnId)
        throw new Error("question expired");
      const response=questionResponse(approval,answers);
      r.client.replyApproval(approval.nativeRequestId,response);
      r.approvals.delete(approvalId);
      store.appendEvent(id,"metadata",{answeredQuestionId:approvalId});
      state(id,hasBlockingApprovals(r.approvals.values())?"approval":"running");
    },
    async approve(id, approvalId, decision) {
      const c = chat(id),
        r = live.get(id),
        approval = r?.approvals.get(approvalId);
      const invocation = r?.invocation, params = approval?.params as {threadId?:string;turnId?:string|null} | undefined;
      if (!r?.client || !approval || !invocation || r.stopRequested || r.controller.signal.aborted || c.status !== "approval" ||
          approval.conversationId !== id || invocation.conversationId !== id || invocation.invocationId !== r.runId ||
          invocation.generation !== r.generation || params?.threadId !== invocation.nativeSessionId ||
          (params.turnId !== invocation.nativeTurnId && !(approval.method === "mcpServer/elicitation/request" && params.turnId == null)))
        throw new Error("approval expired");
      if (
        ![
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "omp/confirm",
          "acp/permission",
          "mcpServer/elicitation/request",
        ].includes(approval.method)
      )
        throw new Error(
          "unsupported approval; use the native CLI or stop this turn",
        );
      const response=nativeApprovalResponse(approval, decision);
      if(decision === "approve-conversation") {
        if(!r.approvalScope)throw new Error("approval expired");
        conversationApprovals.allow(r.approvalScope);
        store.appendEvent(id,"metadata",{approval:"conversation_authorization_granted",approvalId});
      }
      r.client.replyApproval(approval.nativeRequestId, response);
      store.appendEvent(id,"metadata",{runId:invocation.invocationId,approvalDecision:{approvalId,decision}});
      r.approvals.delete(approvalId);
      state(id, hasBlockingApprovals(r.approvals.values()) ? "approval" : "running");
    },
    async setModel(id, model, effort) {
      if (chat(id).purpose === "mandala-main") throw new Error("Mandala execution settings are system managed");
      if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("invalid model");
      if (effort !== undefined) validateEffort(effort);
      authorizeConversationRead(id,true);
      const c = chat(id);
      if (branching.has(id) || live.get(id)?.preparing || ["running", "approval"].includes(c.status)) throw new Error("conversation busy");
      store.updateConversation(id, { model, effort: effort ?? null });
      store.appendEvent(id, "metadata", { model, effort: effort ?? null, status: "saved" });
    },
    async setApprovalMode(id, mode) {
      if (chat(id).purpose === "mandala-main") throw new Error("Mandala execution settings are system managed");
      if (mode !== null && !["default", "strict", "auto"].includes(mode)) throw new Error("invalid approval mode");
      const c = chat(id);
      if (branching.has(id) || ["running", "approval"].includes(c.status)) throw new Error("conversation busy");
      store.updateConversation(id, { approvalMode: mode });
      store.appendEvent(id, "metadata", { approvalMode: mode, status: "saved" });
    },
    async conversationApproval(id) {
      authorizeConversationRead(id,true);
      const c=chat(id),config=await loadConfig(),context=conversationContext(config,c,join(home,'workspaces','conversations',id));
      return {granted:conversationApprovals.has({conversationId:id,agentId:c.agentId,projectId:c.projectId,cli:c.cli,cwd:context.project.cwd,hostId:context.executionLocation?.host})};
    },
    revokeConversationApproval(id) {
      authorizeConversationRead(id,true);conversationApprovals.revoke(id);
      store.appendEvent(id,"metadata",{approval:"conversation_authorization_revoked"});
    },
    getApprovals(id) {
      chat(id);
      return [...(live.get(id)?.approvals.values() ?? []),...asyncQuestions(store,id)];
    },
    hasActiveWork() {
      const db = store.database;
      return !!(branching.size || queuePumps.size || queueStarts.size || backgroundSends.size || initializations.size ||
        continuity.hasActiveWork() || progressMonitor.hasActiveWork() || skillLearning?.hasActiveWork() ||
        fileMaintenance.hasActiveWork() || knowledgeBase.hasActiveWork() || codeGraph.hasActiveWork() ||
        [...live.values()].some(runtime => runtime.preparing || runtime.invocation || runtime.stopping || runtime.approvals.size) ||
        db.prepare("SELECT 1 FROM task_runs WHERE state IN ('queued','starting','running','approval','unknown') LIMIT 1").get() ||
        db.prepare("SELECT 1 FROM task_user_inputs WHERE state IN ('queued','running','unknown') LIMIT 1").get() ||
        db.prepare("SELECT 1 FROM task_directory_claims WHERE submitted=1 LIMIT 1").get() ||
        db.prepare("SELECT 1 FROM task_native_uncertainty LIMIT 1").get() ||
        db.prepare("SELECT 1 FROM conversations WHERE json_extract(data,'$.status') IN ('running','approval') LIMIT 1").get());
    },
    async checkNativeBackgroundWork() {
      const threads = [...live].flatMap(([id, runtime]) => {
        if (!runtime.client) return [];
        const { cli, nativeId } = chat(id);
        return [{ id, client: runtime.client, cli, nativeId }];
      });
      if (!threads.length) return 'idle';
      const controller = new AbortController();
      const deadline = delay(3000, 'unknown' as const, { signal: controller.signal, ref: false });
      try {
        const checks = await Promise.all(threads.map(async ({ client, cli, nativeId }) => {
          if (!nativeId) return 'unknown';
          const check = async () => {
            try {
              if (client.assertReloadable) { await client.assertReloadable(nativeId); return 'idle'; }
              if (cli === 'omp' && client.inspectContext) return (await client.inspectContext(nativeId)).settled ? 'idle' : 'busy';
            } catch (error) {
              if (error instanceof DomainError && error.code === 'native_background_active') return 'busy';
            }
            return 'unknown';
          };
          return Promise.race([check(), deadline]);
        }));
        if (checks.includes('busy')) return 'busy';
        if (checks.includes('unknown')) return 'unknown';
        const changed = [...live.values()].filter(runtime => runtime.client).length !== threads.length ||
          threads.some(({ id, client, nativeId }) => live.get(id)?.client !== client || chat(id).nativeId !== nativeId);
        return changed ? 'busy' : 'idle';
      } finally { controller.abort(); }
    },
    close() {
      if(closing)return closing;
      closed = true;releaseSkillAuthority();clearInterval(progressTimer);progressMonitor.close();
      for(const {timer} of backgroundSends.values())clearTimeout(timer);
      backgroundSends.clear();
      // Abort callbacks may remove live entries synchronously; retain the writers first.
      const entries=[...live.entries()],runtimes=entries.map(([,runtime])=>runtime),nativeClients=[...clients];
      for(const [id] of entries)if(['running','approval'].includes(chat(id).status)){
        appendEvent(id,'error',{message:'Mandala service closed; native outcome is unconfirmed and this execution will not restart automatically.',code:'service_closed'});
        state(id,'interrupted','service_closed');
      }
      for (const runtime of runtimes) {
        if(runtime.queuedInputId&&messages.metadata(runtime.queuedInputId))messages.finish(runtime.queuedInputId,'unknown','');
        if(runtime.durableRun)tasks.markUnknown(runtime.durableRun.id);
        if(runtime.queuedInputId)scheduler.reconcileInput(runtime.queuedInputId,false);
        runtime.usage?.finish('interrupted',undefined,'service_closed');revokeBusinessCli(runtime);
      }
      lifetime.abort();
      for(const r of runtimes)r.finishStop?.();
      const stops=[...(skillLearning?[skillLearning.close()]:[]),...nativeClients.map(async client=>{
        const inputs=entries.filter(([id,runtime])=>!chat(id).executionLocation&&chat(id).cli==='omp'&&runtime.client===client&&!runtime.durableRun&&runtime.queuedInputId&&runtime.invocation?.nativeTurnId);
        await client.close();
        // OMP close waits for its process to exit. Its outcome remains unconfirmed,
        // but an ordinary human input must not hold the directory after shutdown.
        for(const [id,runtime] of inputs){
          const invocation=runtime.invocation!,inputId=runtime.queuedInputId!;
          const input=scheduler.listUserInputs(id).find(input=>input.id===inputId);
          if(!input||input.agentMessage||input.source)continue;
          store.transaction(()=>{
            const changed=store.database.prepare("UPDATE task_user_inputs SET state='cancelled' WHERE id=? AND state='unknown' AND EXISTS (SELECT 1 FROM task_input_invocations WHERE input_id=? AND invocation_id=? AND native_session_id=? AND native_turn_id=?)").run(inputId,inputId,invocation.invocationId,invocation.nativeSessionId,invocation.nativeTurnId).changes;
            if(!changed)return;
            resources.confirmTerminal('input',inputId,{...invocation,nativeTurnId:invocation.nativeTurnId!});
            store.database.prepare("DELETE FROM task_native_uncertainty WHERE kind='input' AND claim_id=?").run(inputId);
            store.appendEvent(id,'metadata',{runId:invocation.invocationId,nativeRuntimeStopped:true,nativeOutcome:'unconfirmed'});
            if(chat(id).nativeId===invocation.nativeSessionId&&chat(id).turnId===invocation.nativeTurnId)store.updateConversation(id,{turnId:null});
          });
        }
      })];
      live.clear();
      for(const connection of remoteExecutions.values())void connection.then(remote=>remote.close()).catch(()=>{});
      remoteExecutions.clear();
      // Failed factories report through their send; still await their cancellation/cleanup.
      closing=Promise.allSettled([codeGraph.close(),knowledgeBase.close(),fileMaintenance.close(),...stops,continuity.close(),...queuePumps,...[...initializations].map(p=>p.catch(()=>{}))]).then(results=>{const failure=results.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;});
      return closing;
    },
  };
  const invoke=manager.callBoundTool.bind(manager);
  manager.callBoundTool=async(token,name,args,commandKey)=>{
    const bound=tools.get(token),runtime=bound&&live.get(bound.conversationId);
    if(!bound||!runtime||!hasOperationOutcome(name))return invoke(token,name,args,commandKey);
    const id=name+':'+commandKey,sourceEventId=runtime.humanEventId??null;
    const prior=store.listEvents(bound.conversationId,0).map(event=>(event.data as {operationResult?:OperationResult}).operationResult).reverse().find(result=>result?.id===id);
    const record=(outcome:NonNullable<ReturnType<typeof projectOperationOutcome>>,state:OperationResult['state'],errorCode?:string)=>{
      if(prior?.state==='succeeded')return;
      const operationResult:OperationResult={...outcome,id,command:name,state,sourceEventId,invocationId:bound.invocationId,createdAt:prior?.createdAt??new Date().toISOString(),...(errorCode?{errorCode}:{})};
      store.appendEvent(bound.conversationId,'metadata',{operationResult,runId:bound.invocationId});
    };
    try{const result=await invoke(token,name,args,commandKey);const outcome=projectOperationOutcome(name,args,result);if(outcome)record(outcome,'succeeded');return result;}
    catch(error){
      const active=tools.get(token)===bound&&live.get(bound.conversationId)===runtime&&runtime.runId===bound.invocationId&&!!runtime.invocation&&!runtime.stopRequested&&!runtime.controller.signal.aborted;
      if(!(error instanceof DomainError&&error.status===403)||active){const outcome=projectOperationOutcome(name,{},null);if(outcome)record(outcome,error instanceof DomainError&&[400,403,404,409,422].includes(error.status)?'failed':'unknown',error instanceof DomainError?error.code:'result_unconfirmed');}
      throw error;
    }
  };
  return manager;
}
