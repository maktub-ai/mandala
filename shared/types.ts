import type { ResponseStyle } from "./response-style";
import { skillIdentity, skillResources, type SkillResource } from "./skills";
import type { ChatDefaults, ReasoningEffort } from "./chat-input";
import type { MarketInstallation } from "./market";
import type { ProjectIcon } from "./identity";
export type ApprovalMode = "default" | "strict" | "auto";
export type Cli = typeof import('./runtimes').runtimeIds[number];
export type Resource = {
  id: string;
  label: string;
  kind: "local" | "remote-git";
  location: string;
  codeGraph?: import("./code-graph").CodeGraphSettings;
};
export type McpServer = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
};
export type Skill = { name: string; path: string; content?: string; [skillResources]?:SkillResource[]; [skillIdentity]?:{id:string;versionRef?:import("./workspace-contracts").VersionRef} };
export type McpConnection = McpServer & { id: string };
export type SkillSource = { agentId?:string; projectId?:string; conversationId?: string; eventIds?: number[]; eventFingerprints?: Record<string,string>; sourceVersions?: import("./workspace-contracts").VersionRef[]; verification: "draft" | "verified"; method: "agent" | "dialogue" | "manual" };
export type SkillDefinition = Skill & { id: string; versionRef?: import("./workspace-contracts").VersionRef; creatorAgentId?: string; humanMaintained?: boolean; externalSource?: string; source?: SkillSource; unavailable?: boolean };
export type KnowledgeAccess = { mode: "owner" | "private" | "selected" | "all"; agentIds?: string[]; projectIds?: string[] };
export type RuntimeConfig = Partial<Record<Cli, { args?: string[]; env?: Record<string, string>; approvalMode?: ApprovalMode; fullAccess?: boolean; gateway?: 'native' | 'unavailable' }>>;
export type SystemTaskConfig = { cli: Cli; model?: string };
export type SystemConfig = Partial<SystemTaskConfig> & {
  skillLearning?: boolean; automaticTitles?: boolean; automaticTaskProgress?: boolean; memoryCapture?: boolean;
  memory?: { language?: "zh-CN" | "en"; request?: { generate?: boolean; read?: boolean }; session?: { generate?: boolean; read?: boolean }; idleHours?: number };
  tasks?: Partial<Record<"title" | "memory" | "taskProgress", SystemTaskConfig>>;
};
export type KnowledgeEntry = {
  id: string; kind: "memory" | "document" | "skill"; title: string; content: string;
  scope: "global" | "project" | "agent"; projectId?: string; agentId?: string;
  level?: "L1" | "L2" | "L3" | "L4"; status: "candidate" | "active";
  access?: KnowledgeAccess;
  sourceConversationId?: string; sourceEventId?: number; createdAt: string; updatedAt: string;
};
export type ExecutionMachine = { id: string; name: string; host: string };
export type ExecutionLocation = { machineId: string; machineName: string; host: string; cwd: string };
export type Workspace = { id: string; name: string; cwd: string; machineId?: string; resources: Resource[]; codeGraph?: import("./code-graph").CodeGraphSettings };
export type Project = {
  archivedAt?: string;
  id: string;
  name: string;
  icon?: ProjectIcon;
  emoji?: string;
  cwd: string;
  workspaces?: Workspace[];
  background?: string;
  legacyRuntime?: RuntimeConfig;
  agentIds: string[];
  resources: Resource[];
  mcp: McpServer[];
  skills: Skill[];
  runtime?: RuntimeConfig;
  connectionIds?: string[];
  skillIds?: string[];
  disabledConnectionIds?: string[];
  disabledSkillIds?: string[];
  knowledgeIds?: string[];
  color?: string;
  avatarSeed?: string;
};
export type Agent = {
  maxParallel?: number;
  archivedAt?: string;
  temporary?: boolean;
  systemRole?: "mandala";
  managedWorkspace?: string;
  responseStyle?: ResponseStyle;
  id: string;
  name: string;
  instructions: string;
  defaultCli: Cli;
  models: Partial<Record<Cli, string>>;
  mcp: McpServer[];
  skills: Skill[];
  runtime?: RuntimeConfig;
  connectionIds?: string[];
  skillIds?: string[];
  disabledConnectionIds?: string[];
  disabledSkillIds?: string[];
  knowledgeIds?: string[];
  color?: string;
  avatarSeed?: string;
  icon?: ProjectIcon;
  emoji?: string;
};
export type MandalaSettings = { agentId: string; soul: string; maxParallel: number };
export type Config = { version: 2; mandala?: MandalaSettings; responseStyle?: ResponseStyle; projects: Project[]; agents: Agent[]; executionMachines?: ExecutionMachine[]; system?: SystemConfig; runtimes?: Cli[]; runtimeDefaults?: RuntimeConfig; connections?: McpConnection[]; skillLibrary?: SkillDefinition[]; chatDefaults?: ChatDefaults; marketInstallations?: MarketInstallation[] };
export type LegacyConfig = {
  version: 1;
  projects: Pick<Project, "id" | "name" | "cwd">[];
  agents: (Pick<Agent, "id" | "name" | "instructions"> & {
    defaultCli: "codex";
    models: { codex?: string };
  })[];
};
export type ConversationStatus =
  | "idle"
  | "running"
  | "approval"
  | "interrupted"
  | "error";
export type Conversation = {
  origin?: "chat" | "task";
  purpose?: "mandala-main" | "mandala-background";
  continuityPending?: boolean;
  id: string;
  workspaceId?: string | null;
  cwd?: string;
  workspaceName?: string;
  executionLocation?: ExecutionLocation;
  projectId: string;
  agentId: string;
  title: string | null;
  cli: Cli;
  model: string | null;
  effort?: ReasoningEffort | null;
  approvalMode?: ApprovalMode | null;
  branchedFrom?: { conversationId: string; eventId: number };
  nativeId: string | null;
  turnId: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  titleSource?: "user" | "message" | "automatic";
};
export type EventKind =
  | "user"
  | "text"
  | "tool"
  | "hook"
  | "status"
  | "approval"
  | "error"
  | "task"
  | "metadata"
  | "progress";
export type DisplayEvent = {
  id: number;
  conversationId: string;
  kind: EventKind;
  data: unknown;
  createdAt: string;
};
export type Task = {
  id: string;
  projectId: string;
  sourceConversationId: string;
  targetConversationId: string;
  kind: "dispatch" | "return";
  continuationEpoch?: number;
  autoResume?: boolean;
  request: string;
  status: "queued" | "running" | "completed" | "failed";
  result: string | null;
  startEventId: number;
  createdAt: string;
};
export type Approval = {
  conversationApproval?: boolean;
  id: string;
  conversationId: string;
  nativeRequestId: string | number;
  method: string;
  params: unknown;
};
export type ModelChoice = { id: string; label: string; isDefault?: boolean; defaultReasoningEffort?: ReasoningEffort; supportedReasoningEfforts?: ReasoningEffort[] };
export type CliStatus = {
  status: "ready" | "login-required" | "unavailable";
  version: string | null;
};

export type MandalaContextMaintenance = {
  status:'pending'|'unknown'|'completed'|'noop'|'fallback'|'failed'; reason:'idle'|'context-limit'|'native-auto';
  nativeId:string; turnId?:string; nativeCompleted?:boolean; watermark:number; limitEventId:number;
  afterEventId:number; throughEventId:number; goalIds:string[]; handoff:string;
};
