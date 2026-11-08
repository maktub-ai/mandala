import type { Cli } from './types';

export type UsageCategory = 'conversation' | 'task' | 'title' | 'memory' | 'taskProgress' | 'fileMaintenance' | 'skillLearning' | 'wikiMaintenance';
export type UsageCoverage = 'observed' | 'partial' | 'unknown';
// Null means no trustworthy value was reported. Cache/reasoning are subsets,
// never added to input + output a second time. Totals sum only recorded values.
export type UsageTokens = { inputTokens:number|null; outputTokens:number|null; totalTokens:number|null; cachedInputTokens:number|null; cacheWriteInputTokens:number|null; reasoningOutputTokens:number|null };
export type UsageContext = { executionId:string; category:UsageCategory; cli:Cli; model?:string|null; projectId?:string|null; agentId?:string|null; conversationId?:string|null; taskId?:string|null; runId?:string|null; systemJobId?:string|null; stage?:'extract'|'conflict'|'scene'|'profile'|'consolidate'|'verify'|null; reviewStage?:'extract'|'conflict'|'scene'|'profile'|'consolidate'|null; callKind?:'initial'|'retry'|'repair'|null };
export type UsageExecution = UsageContext & { model:string|null; startedAt:string; updatedAt:string; status:'running'|'completed'|'failed'|'interrupted'; nativeSessionId:string|null; nativeTurnId:string|null; source:'codex:session-delta'|'omp:message_end'|null; coverage:UsageCoverage; totals:UsageTokens; reasons:string[] };
export type UsageCoverageCounts = { observed:number; partial:number; unknown:number; total:number };
export type UsageGroup = { key:string|null; totals:UsageTokens; coverage:UsageCoverageCounts };
export type UsageQuery = { period:'today'|'week'; timeZone:string; projectId?:string; agentId?:string; cli?:Cli; model?:string; now?:string };
export type UsageSummary = {
 window:{start:string;end:string;timeZone:string;period:'today'|'week'};
 generatedAt:string;
 // Execution counts for calls with activity in the selected window. Historical
 // CLI usage is not scanned; coverage does not claim pre-collection completeness.
 coverage:UsageCoverageCounts;
 totals:UsageTokens;
 daily:{date:string;totals:UsageTokens;coverage:UsageCoverageCounts}[];
 groups:{category:UsageGroup[];cli:UsageGroup[];model:UsageGroup[];project:UsageGroup[];agent:UsageGroup[];stage:UsageGroup[];reviewStage:UsageGroup[];callKind:UsageGroup[]};
 // Most recent 100 executions; totals above cover every matching execution.
 recent:UsageExecution[];
};
