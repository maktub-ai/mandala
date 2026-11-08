export type WorkbenchExecutionState = 'running' | 'approval' | 'queued' | 'unknown';
export type WorkbenchExecution = {
 id: string; kind: 'conversation' | 'run' | 'input'; conversationId: string | null; taskId: string | null;
 projectId: string | null; agentId: string | null; state: WorkbenchExecutionState;
 title: string | null; href: string | null; time: string; accessible: boolean;
};
export type WorkbenchAgent = {
 id: string | null; name: string; executions: WorkbenchExecution[];
 counts: Record<WorkbenchExecutionState, number>;
};
export type WorkbenchPending = {
 kind: 'input' | 'approval' | 'review' | 'skill' | 'error'; id: string; title: string;
 href: string; time: string; projectId: string | null; agentId: string | null;
};
export type WorkbenchRecentConversation = { id: string; title: string; href: string; time: string; projectId: string | null; agentId: string | null };
export type WorkbenchRecentKnowledge = { kind: 'memory' | 'skill'; id: string; title: string; href: string; time: string; projectId: string | null; agentId: string | null; sourceHref: string | null };
export type WorkbenchSnapshot = {
 generatedAt: string; projectId: string | null; agents: WorkbenchAgent[]; agentOptions: {id: string | null; name: string}[]; pending: WorkbenchPending[];
 recentConversations: WorkbenchRecentConversation[]; recentKnowledge: WorkbenchRecentKnowledge[];
 errors: ('tasks' | 'knowledge' | 'memory')[];
};
