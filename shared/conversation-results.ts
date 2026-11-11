import type {RunState,Task} from './tasks';
export type ConversationResult={
 id:string;taskId:string;runId:string;conversationId?:string;agentId?:string;title:string;summary:string;
 state:RunState;awaitingReview:boolean;createdAt:string;artifactCount:number;
 reportAccessBlocked?:boolean;
 taskState?:Task['state'];completion?:Pick<NonNullable<Task['completion']>,'completedBy'|'acceptedAt'>|null;
};
export function executionResultHref(conversationId:string,runId?:string){
 return '/?'+new URLSearchParams({conversation:conversationId,...(runId?{run:runId}:{})});
}
