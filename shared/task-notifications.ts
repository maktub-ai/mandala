import type {WaitingReason} from './tasks';

export type TaskNotice = {
 sequence?:number;id:string;taskId:string;runId:string|null;executionConversationId?:string;replyConversationId?:string;
 title?:string;goal:string;state:string;createdAt:string;detail?:string;reason?:WaitingReason;decisionScope?:string;
};
export type TaskNotices = {cursor:number;items:TaskNotice[];retired?:string[];rechecked?:number[]};
