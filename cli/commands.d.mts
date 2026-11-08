export interface Command {
  name: string; method: string; path: string; idParams: string[];
  boundTool?: 'automation_list' | 'automation_create' | 'automation_update' | 'automation_remove' | 'automation_run' | 'automation_stop' | 'progress_report' | 'message_ask' | 'message_read' | 'project_agents' | 'delegate' | 'artifact_publish' | 'artifact_read' | 'memory_search' | 'memory_read' | 'task_context' | 'task_list' | 'task_read' | 'task_create' | 'task_update' | 'task_start' | 'task_stop' | 'task_cancel' | 'task_review' | 'task_mark_completed' | 'task_accept' | 'task_reopen' | 'task_assign' | 'task_request_changes' | 'task_execution_add' | 'task_execution_remove' | 'conversation_list' | 'conversation_read' | 'conversation_history' | 'skill_find' | 'skill_read' | 'skill_register';
  boundFields?: string[]; transport?: 'upload' | 'binary' | 'headers' | 'events';
  configEntity?: string; configAction?: string; bodyKey?: boolean; readOnly?: boolean; invocationOnly?: boolean;
}
export const COMMANDS: Command[];
export function findCommand(name: string): Command | undefined;
export function boundArguments(command: Command, ids: string[], data?: Record<string, unknown>): Record<string, unknown>;
export function resolveRequest(command: Command, args?: { ids?: string[]; data?: Record<string, unknown>; query?: Record<string, unknown>; key?: string }): { method: string; path: string; data: Record<string, unknown>; parameters: Record<string, string> };
