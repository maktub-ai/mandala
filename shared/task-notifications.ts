export type TaskNotice = {id:string;taskId:string;runId:string|null;executionConversationId?:string;title?:string;goal:string;state:string;createdAt:string};
export type TaskNotices = {cursor:number;items:TaskNotice[]};
