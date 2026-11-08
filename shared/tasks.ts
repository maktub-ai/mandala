import type { Conversation } from './types';
import type {AgentMessageOrigin} from './agent-messages';
import type { ManifestFile } from './assets';
import type { VersionRef } from './workspace-contracts';
import type { ComposerReferenceSelection } from './composer-references';
export type Criterion = { id: string; text: string; checkRef: string | null };
export type TaskInput = {
 goal: string; criteria?: Criterion[]; acceptance?: 'delivery' | 'checks' | 'human';
 projectId?: string | null; assigneeAgentId?: string | null; originConversationId?: string | null;
 participantAgentIds?: string[]; automaticProgress?: boolean;
};
export type TaskState = 'todo' | 'running' | 'waiting' | 'review' | 'completed' | 'cancelled';
export type WaitingReason = 'host_offline' | 'approval' | 'input' | 'run_failed' | 'interrupted' | 'delivery_missing' | 'check_failed';
export type CompletionEvidence = { completedBy: 'delivery' | 'checks' | 'user' | 'agent'; completedByAgentId?: string; sourceRunId: string | null; artifactVersions: VersionRef[]; acceptedAt: string; checks?: {checkRef:'artifact:integrity';identity:RunIdentity;artifactVersions:VersionRef[]}[] };
export type Task = Required<TaskInput> & {
 activityAt?: string; live?: boolean;
 executionTitle?: string|null;
 conversationIds: string[];
 executions: TaskExecution[];
 creationSource?: 'user'|'agent'|'system'|'unknown';
 id: string; ownerUserId: string; creatorAgentId: string | null; state: TaskState; waitingReason: WaitingReason | null;
 revision: number; continuationEpoch: number; futureAutoResume: boolean; completion: CompletionEvidence | null;
 legacyId: string | null; createdAt: string;
};
export type TaskProgressState = Exclude<TaskState, 'completed' | 'cancelled'>;
export type TaskPatch = Partial<Pick<Task, 'goal' | 'criteria' | 'projectId' | 'assigneeAgentId' | 'originConversationId' | 'participantAgentIds' | 'automaticProgress'>> & { state?: TaskProgressState };
export type TaskProgressSnapshot = { task: Pick<Task, 'id' | 'goal' | 'criteria' | 'state' | 'revision' | 'conversationIds'>; executions: Pick<TaskExecution, 'id' | 'conversationId' | 'request' | 'latestRun'>[] };
export type RunIdentity = { runId: string; hostId: string; nativeSessionId: string; nativeTurnId: string };
export type TerminalRunEvent = RunIdentity & { eventKey: string; outcome: 'succeeded' | 'failed' | 'interrupted'; summary: string; artifactVersions: VersionRef[] };
export type Continuation = { taskId: string; conversationId: string; epoch: number; policy: 'notify' | 'resume' };
export type RunState = 'queued' | 'starting' | 'running' | 'approval' | 'unknown' | 'succeeded' | 'failed' | 'interrupted' | 'legacy_unverified';
export type RunRouting = { executionConversationId: string; mode: 'dedicated' | 'existing'; destinationConversationId: string | null };
// Absent source is a desktop/legacy human input. The host explicitly tags Telegram human input.
export type QueuedInputSource = {kind:'coordination';receiptIds:string[]} | {kind:'schedule';automationId:string} | {kind:'idle'} | {kind:'telegram';requestId:string};
export const isHumanInput = (input:{source?:unknown;agentMessage?:unknown;task?:unknown}) =>
 (input.source===undefined || (input.source as QueuedInputSource|null)?.kind==='telegram') && input.agentMessage===undefined && input.task===undefined;
export type QueuedInput = { source?:QueuedInputSource; waitingReason?:'directory'|'background'; agentMessage?:AgentMessageOrigin; commandKey?: string; unrecorded?: boolean; id: string; conversationId: string; text: string; attachments?: string[]; references?: ComposerReferenceSelection[]; state: 'queued' | 'running' | 'completed' | 'cancelled' | 'unknown'; createdAt: string };
export type ExecutionMonitor = { lastCheckedAt?: string; nativeState?: 'running'|'succeeded'|'failed'|'unknown'|'unreachable'; lastProgressAt: string | null; reason: 'queued'|'directory'|'approval'|'unknown'|'run_failed'|'interrupted'|'host_offline'|null; attention: boolean };
export type Run = {
 monitor?: ExecutionMonitor;
 snapshot?: { goal: string; criteria: Criterion[]; acceptance: Task['acceptance']; rule?: { reportConversationId?: string; automationId: string; revision: number; executionMode?: import('./automations').AutomationInput['executionMode']; schedule: import('./automations').Schedule } };
 completion?: CompletionEvidence | null;
 id: string; taskId: string; executionId: string; attempt: number; state: RunState; waitingForDirectory?: boolean; hostId: string | null;
 nativeSessionId: string | null; nativeTurnId: string | null; contextSnapshotId: string | null;
 routing: RunRouting | null; continuation: Continuation | null; terminalEventKey: string | null; summary: string | null;
 artifactVersions: VersionRef[]; legacyId: string | null; createdAt: string;
};
// Ownership-checked control metadata; never contains terminal bodies or Version references.
export type RunControl = Pick<Run, 'monitor' | 'id' | 'taskId' | 'executionId' | 'attempt' | 'state' | 'hostId' | 'nativeSessionId' | 'nativeTurnId' | 'routing' | 'continuation' | 'createdAt' | 'waitingForDirectory'>;
// Selected input is what the platform can prove it prepared. It does not assert native loading.
export type ContextSnapshot = {
 id: string; runId: string; input: string; inputHash: string;
 sourceVersions: (VersionRef & { files: ManifestFile[]; accessRevision: number })[];
 effectiveCapabilities: { name: string; state: 'saved' | 'materialized' | 'verified' | 'unverified' }[];
 nativeVisibility: 'partial'; requiredOutputAssetIds: string[]; createdAt: string;
};
export type Receipt = {
 id: string; taskId: string | null; sourceRunId: string | null; destinationConversationId: string | null;
 executionId: string | null; capturedEpoch: number | null; policy: 'notify' | 'resume';
 deliveryState: 'pending' | 'presented' | 'consumed' | 'parked'; claimedByRunId: string | null;
 claimError: string | null; claimEpoch: number | null; summary: string; artifactVersions: VersionRef[]; legacyId: string | null; createdAt: string;
};

export type RunContextTrace = { contextSnapshotId: string; actualUse: 'prepared' | 'acknowledged'; sourceVersions: VersionRef[]; nativeVisibility: 'partial' };

export type PlanStepInput = { key: string; taskId: string | null; goal: string };
export type TaskExecutionInput = { conversationId: string; agentId: string; projectId: string | null; request: string; criteria?: Criterion[]; createdByAgentId?: string | null };
export type TaskExecution = Required<TaskExecutionInput> & { id: string; taskId: string; supersededByExecutionId?: string | null; commandKey: string | null; createdAt: string; title: string | null; latestRun: RunControl | null };
export type ReadableAssociatedChat = Pick<Conversation, 'id'|'title'|'agentId'|'projectId'|'cli'|'status'|'updatedAt'> & {executionId?:string|null};
export type TaskDetail = { readableAssociatedChats: ReadableAssociatedChat[]; task: Task; runs: Run[]; receipts: Receipt[]; contexts: ContextSnapshot[]; executions: TaskExecution[]; planVersions: VersionRef[] };

// Authorized exact output membership. Current output requires the latest Run and current Asset head.
export type TaskSource = { task: Pick<Task,'id'|'goal'|'state'|'revision'|'projectId'>; run: Pick<Run,'id'|'state'|'routing'>; currentOutput: boolean };

export type ExpectedOutput = VersionRef & { runId: string };
