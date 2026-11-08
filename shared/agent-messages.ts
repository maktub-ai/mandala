export type AgentMessageInput = {
 targetAgentId:string; text:string; targetConversationId?:string; policy?:'notify'|'resume';
};
export type AgentMessage = {
 sourceRequestEventId?:number;sourceAgentId?:string;targetAgentId?:string;createdAt?:string;
 id:string; sourceConversationId:string; targetConversationId:string; text:string; policy:'notify'|'resume';
 state:'queued'|'running'|'succeeded'|'failed'|'unknown'; reply:string|null;
 replyState:'pending'|'queued'|'consumed'|'parked';
};
export type AgentMessageOrigin = {id:string; direction:'request'|'reply'; sourceRequestEventId:number};
