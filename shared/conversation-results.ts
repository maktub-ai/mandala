import type {RunState,Task} from './tasks';
export type ConversationResult={
 id:string;taskId:string;runId:string;conversationId?:string;agentId?:string;title:string;summary:string;
 state:RunState;taskRevision:number;awaitingReview:boolean;createdAt:string;artifactCount:number;
 reportAccessBlocked?:boolean;
 taskState?:Task['state'];completion?:Pick<NonNullable<Task['completion']>,'completedBy'|'acceptedAt'|'sourceRunId'>|null;
};
export type ChatTaskReview={taskId:string;goal:string;revision:number;runId:string|null};
export type ChatDeliveries={items:ConversationResult[];reviews:ChatTaskReview[]};
export function executionResultHref(conversationId:string,runId?:string){
 return '/?'+new URLSearchParams({conversation:conversationId,...(runId?{run:runId}:{})});
}
