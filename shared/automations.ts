import type { Cli } from "./types";

export type Schedule = { kind: "once"; at: string } |
  { kind: "interval"; minutes: number; anchor: string } |
  { kind: "daily"; time: string; timeZone: string } |
  { kind: "weekly"; time: string; timeZone: string; weekday?: number; weekdays?: number[] };
export type AutomationInput = {
  taskId?: string | null; goalId?: string | null; conversationId?: string | null;
  executionMode?: 'continuous' | 'independent';
  name: string; instructions: string; projectId: string; agentId: string; cli: Cli;
  workspaceId?: string | null; enabled: boolean; schedule: Schedule;
  missedPolicy?: 'manual' | 'latest' | 'each'; overlapPolicy?: 'queue' | 'coalesce';
};
export type Automation = AutomationInput & { reportConversationId?: string; bindingGeneration?: string; createdByAgentId?: string; createdFromProjectId?: string; executionTaskId?: string; executionConversationId?: string; id: string; revision: number; createdAt: string; updatedAt: string; nextRunAt: string | null; catchingUp?: boolean; pendingThroughAt?:string; pendingFromAt?:string };
export type AutomationRun = {
  id: string; automationId: string; name: string; projectId: string; agentId: string; cli: Cli;
  instructions: string; workspaceId?: string | null;
  scheduledAt: string; createdAt: string; startedAt?: string; finishedAt?: string; conversationId?: string;
  status: "queued" | "starting" | "running" | "approval" | "succeeded" | "completed" | "interrupted" | "failed" | "unknown" | "missed" | "legacy_unverified";
  taskId?:string; runId?:string; ruleRevision?:number; taskState?:import('./tasks').TaskState; waitingReason?:import('./tasks').WaitingReason|null; legacyStatus?:string;
  goal?: string; criteria?: import('./tasks').Criterion[]; acceptance?: import('./tasks').Task['acceptance'];
  schedule?: Schedule;
  bindingGeneration?: string; goalId?: string; sourceTaskId?: string; executionMode?: AutomationInput['executionMode']; executionTaskId?: string; overlapPolicy?: AutomationInput['overlapPolicy'];
  coverage?: {firstDueAt:string;latestDueAt:string;count?:number};
  reportConversationId?: string;
  error?: string;
};
export type AutomationState = { version: 1; automations: Automation[]; runs: AutomationRun[] };
