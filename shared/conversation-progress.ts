import type {Conversation} from './types';
export type ConversationProgressState='running'|'queued'|'waiting'|'attention'|'recent'|'completed';
export type ConversationProgress=Pick<Conversation,'id'|'title'|'agentId'|'projectId'|'cli'> & {
 executionStatus?:Conversation['status']|null; latestProgress?:LatestProgress|null; state:ConversationProgressState; reopenState:Exclude<ConversationProgressState,'completed'>; active:boolean; live?:boolean; withinWindow:boolean; activityAt:string; completedAt:string|null;
 requestPreview:string|null; hasNewActivity:boolean; taskIds:string[]; relatedConversationIds:string[];
};
export type ConversationProgressAction={action:'visit'|'complete'|'reopen'};

export type ProgressStep={text:string;status:'pending'|'running'|'completed'|'blocked'};
export type ExplicitProgress={text:string;updatedAt:string;source:'cli';runId:string;sourceEventId:number;steps?:ProgressStep[];historical:boolean};
export type LatestProgress=Omit<ExplicitProgress,'source'>&{source:'cli'|'commentary'|'output'};

// Missing legacy execution data must not manufacture a current runtime state.
export function runningConversationCount(rows:readonly ConversationProgress[]){return rows.filter(row=>row.executionStatus==='running').length;}
