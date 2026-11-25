import type { Cli, DisplayEvent } from './types';

export type SubagentStatus = 'dispatching' | 'dispatched' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type NativeSubagent = {
  id: string; turnId: string; status: SubagentStatus; agentId?: string; name?: string; task?: string; text?: string;
};
type Update = Partial<Omit<NativeSubagent, 'id' | 'turnId'>>;
type ObjectFields = Record<string, unknown>;
const object = (value: unknown): ObjectFields | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectFields : undefined;
const string = (value: unknown) => typeof value === 'string' && value.length ? value : undefined;
const statuses: ReadonlySet<string> = new Set<SubagentStatus>(['dispatching','dispatched','running','completed','failed','interrupted','unknown']);
function nativeStatus(value: unknown) {
  return typeof value === 'string' && statuses.has(value) ? value as SubagentStatus : undefined;
}

/** Read only the native task shapes also present in older stored tool events. */
export function nativeTaskUpdates(cli: Cli | undefined, item: ObjectFields): Update[] {
  if (item.type !== 'mcpToolCall') return [];
  const result = object(item.result);
  if (cli === 'cursor' && item.server === 'cursor' && item.tool === 'taskToolCall') {
    const args = object(item.arguments);
    const role = object(args?.subagentType);
    const name = string(args?.subagentType) ?? string(object(role?.custom)?.name)
      ?? Object.keys(role ?? {}).find(key => key !== 'unspecified' && key !== 'custom');
    const success = object(result?.success), error = object(result?.error);
    const agentId = success && (string(success.agentId) ?? string(args?.agentId) ?? string(args?.resume));
    const messages = Array.isArray(success?.conversationSteps) ? success.conversationSteps
      .map(step => string(object(object(step)?.assistantMessage)?.text)).filter(Boolean) : [];
    let status: SubagentStatus = item.status === 'inProgress' ? 'dispatching' : 'unknown';
    if (success) status = success.isBackground || !agentId ? 'dispatched' : 'completed';
    if (error) status = 'failed';
    return [{agentId, name, task:string(args?.description), status, text:string(error?.error) ?? (messages.join('\n') || undefined)}];
  }
  if (cli === 'omp' && item.server === 'OMP' && item.tool === 'task') {
    const results = object(result?.details)?.results;
    if (!Array.isArray(results)) return [];
    return results.flatMap(entry => {
      const child = object(entry), agentId = string(child?.id);
      if (!agentId || typeof child?.exitCode !== 'number') return [];
      const status = child.aborted ? 'interrupted' : child.exitCode === 0 ? 'completed' : 'failed';
      return [{agentId, name:string(child.agent), task:string(child.description) ?? string(child.task), status,
        text:string(child.error) ?? string(child.output)}];
    });
  }
  return [];
}

function updates(item: ObjectFields, cli?: Cli, parentThreadId?: string): Update[] {
  if (item.type === 'mcpToolCall') return nativeTaskUpdates(cli, item);
  if (item.type === 'nativeSubagent') return [{
    agentId: string(item.agentId), name: string(item.name), task: string(item.task), text: string(item.text), status: nativeStatus(item.status),
  }];
  if (item.type === 'subAgentActivity') {
    const agentId = string(item.agentThreadId);
    if (!agentId || agentId === parentThreadId) return [];
    const status = item.kind === 'started' ? 'running' : item.kind === 'interrupted' || item.kind === 'completed' ? item.kind : undefined;
    return [{ agentId, name: string(item.agentPath), status }];
  }
  if (item.type !== 'collabAgentToolCall') return [];
  const states = object(item.agentsStates) ?? {};
  const receivers = new Set<string>(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => !!string(id)) : []);
  for (const id of Object.keys(states)) if (id) receivers.add(id);
  const targetedParent = parentThreadId !== undefined && receivers.delete(parentThreadId);
  const spawn = item.tool === 'spawnAgent';
  const task = spawn ? string(item.prompt) : undefined;
  const dispatch = item.status === 'failed' ? 'failed' : item.status === 'interrupted' ? 'interrupted'
    : item.status === 'completed' ? 'dispatched' : 'dispatching';
  if (!receivers.size) return spawn && !targetedParent ? [{ task, status: dispatch }] : [];
  return Array.from(receivers, agentId => {
    const state = object(states[agentId]);
    let status: SubagentStatus | undefined;
    switch (state?.status) {
      case 'running': case 'completed': case 'interrupted': status = state.status; break;
      case 'errored': status = 'failed'; break;
      case 'pendingInit': status = 'dispatched'; break;
      default: if (spawn) status = dispatch;
    }
    return { agentId, status, task, text: string(state?.message) };
  });
}

/** Project stored native events so historical and live views use the same identity and attribution. */
export function nativeSubagents(events: readonly DisplayEvent[], cli?: Cli): NativeSubagent[] {
  const rows = new Set<NativeSubagent>();
  const members = new Map<string, NativeSubagent>();
  const calls = new Map<string, NativeSubagent>();
  for (const event of events.filter(event => event.kind === 'tool').sort((a, b) => a.id - b.id)) {
    const data = object(event.data), params = object(data?.params), item = object(params?.item);
    if (data?.method !== 'item/started' && data?.method !== 'item/completed') continue;
    const turnId = string(params?.turnId), itemId = string(item?.id);
    if (!item || !turnId || !itemId) continue;
    const entries = updates(item, cli, string(params?.threadId));
    const key = (kind: string, value: string) => JSON.stringify([event.conversationId, turnId, kind, value]);
    const callKey = key('call', itemId);
    for (const entry of entries) {
      const memberKey = entry.agentId && key('agent', entry.agentId);
      const receipt = calls.get(callKey);
      let row = memberKey ? members.get(memberKey) : receipt;
      if (receipt && !receipt.agentId && entry.agentId) {
        if (row && row !== receipt) {
          rows.delete(row);
          for (const [call, owner] of calls) if (owner === row) calls.set(call, receipt);
          Object.assign(receipt, row, { id: receipt.id });
        }
        row = receipt;
      }
      if (!row) {
        row = { id: memberKey || callKey, turnId, status: 'unknown' };
        rows.add(row);
      }
      if (memberKey) members.set(memberKey, row);
      if (entries.length === 1) calls.set(callKey, row);
      if (entry.agentId) row.agentId = entry.agentId;
      for (const field of ['name', 'task', 'text'] as const) {
        if (entry[field]) row[field] = entry[field];
        else if (item.type === 'nativeSubagent' && (item[field] === null || item[field] === '')) delete row[field];
      }
      const receiptOnly = entry.status === 'dispatched' || entry.status === 'dispatching';
      if (entry.status === 'unknown' && (item.type === 'nativeSubagent' || (data.method === 'item/completed' && row.status === 'dispatching'))) row.status = 'unknown';
      if (entry.status && entry.status !== 'unknown' && (!receiptOnly || ['unknown', 'dispatching', 'dispatched'].includes(row.status))) row.status = entry.status;
    }
  }
  return [...rows];
}
