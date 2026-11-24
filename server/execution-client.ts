import type { TurnOptions } from '../shared/chat-input';
import type { RunIdentity } from '../shared/tasks';
import type { ApprovalMode, CliStatus, McpServer, ModelChoice } from '../shared/types';
import type { RpcMessage } from './rpc';
import { bindLocalCatalogLauncher } from './runtime';

export type RuntimeOptions = {
  signal?: AbortSignal;
  cwd: string;
  extraArgs?: string[];
  fullAccess?: boolean;
  safeSystem?: boolean;
  model?: string;
  gateway?: 'native' | 'unavailable';
  /** Internal opt-in set only by the local catalog session manager. */
  [bindLocalCatalogLauncher]?: true;
  env?: Record<string, string>;
  onEvent: (event: RpcMessage) => void;
  onApproval: (request: RpcMessage) => void;
  onExit: (reason: string) => void;
};
export interface ExecutionClient {
  inspectContext?(nativeId:string):Promise<{settled:boolean;completedCompactions?:string[]}>;
  compactThread?(nativeId:string):Promise<'started'|'completed'|'noop'|'unsupported'>;
  getStatus(explain?:boolean): Promise<CliStatus & {nativeAccountPresent?:boolean;nativeVersion?:string;capabilityIssue?:NonNullable<CliStatus['diagnostics']>['capabilityIssue']}>;
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
  nameEmptyThread?(nativeId: string, name: string): Promise<void>;
  readEmptyNamedThread?(nativeId: string, name: string): Promise<boolean>;
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
