import { expect, it } from 'vitest';
import { nativeSubagents } from '../shared/native-subagents';
import type { DisplayEvent } from '../shared/types';

function event(id: number, item: Record<string, unknown>, turnId = 't'): DisplayEvent {
  return { id, kind: 'tool', conversationId: 'chat', createdAt: '', data: { method: 'item/completed', params: { turnId, item } } };
}
const spawn = {
  type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', prompt: '核对文档',
  status: 'inProgress', receiverThreadIds: [], agentsStates: {},
};
it('updates a Codex dispatch in place and keeps its task and avatar identity through waits and replay', () => {
  const receipt = event(1, spawn);
  const started = event(2, { ...spawn, status: 'completed', receiverThreadIds: ['child'] });
  const finished = event(3, { ...spawn, id: 'wait', tool: 'wait', prompt: null, receiverThreadIds: ['child'],
    agentsStates: { child: { status: 'completed', message: '已核对' }, other: { status: 'errored', message: '连接失败' } } });
  expect(nativeSubagents([receipt])[0]).toMatchObject({ status: 'dispatching' });
  expect(nativeSubagents([receipt, started])[0]).toMatchObject({ agentId: 'child', status: 'dispatched' });
  const members = nativeSubagents([finished, receipt, started, finished]);
  expect(members).toHaveLength(2);
  expect(members[0]).toMatchObject({ id: nativeSubagents([receipt])[0].id, agentId: 'child', task: '核对文档', status: 'completed', text: '已核对' });
  expect(members[1]).toMatchObject({ agentId: 'other', status: 'failed', text: '连接失败' });
});
it('keeps rounds separate and never infers success from a tool completion or missing target', () => {
  const one = event(1, { type: 'subAgentActivity', id: 'a', agentThreadId: 'child', agentPath: '/root/check', kind: 'completed' });
  const closed = event(2, { ...spawn, tool: 'closeAgent', status: 'completed', receiverThreadIds: ['child'], agentsStates: { child: { status: 'shutdown' } } });
  const next = event(3, { ...spawn, receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } }, 'next');
  const empty = event(4, { ...spawn, tool: 'wait', status: 'completed' }, 'next');
  const members = nativeSubagents([one, closed, next, empty]);
  expect(members.map(m => [m.turnId, m.agentId, m.status])).toEqual([['t', 'child', 'completed'], ['next', 'child', 'running']]);
  expect(members[0].name).toBe('/root/check');
});
it('matches native snapshots to members, keeps anonymous receipts anonymous, and ignores generic tool text', () => {
  const member = { type: 'nativeSubagent', id: 'member-event', agentId: 'member', name: 'Reviewer' };
  const members = nativeSubagents([
    event(1, { ...member, status: 'running', task: 'Read' }),
    event(2, { ...member, id: 'another-call', status: 'completed', text: 'Done' }),
    event(3, { type: 'nativeSubagent', id: 'dispatch-1', task: 'Search', status: 'dispatched' }),
    event(4, { type: 'mcpToolCall', id: 'fake', tool: 'Agent', result: 'another member completed' }),
  ]);
  expect(members).toHaveLength(2);
  expect(members[0]).toMatchObject({ agentId: 'member', task: 'Read', text: 'Done', status: 'completed' });
  expect(members[1]).toMatchObject({ task: 'Search', status: 'dispatched' });
  expect(members[1].agentId).toBeUndefined();
});
it('reconciles an early child activity with its pending spawn even when activity arrives before the receipt gets the id', () => {
  const receipt = event(1, spawn);
  const activity = event(2, { type: 'subAgentActivity', id: 'notice', agentThreadId: 'child', agentPath: '/root/read', kind: 'started' });
  const known = event(3, { ...spawn, status: 'completed', receiverThreadIds: ['child'] });
  const rows = nativeSubagents([receipt, activity, known]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: nativeSubagents([receipt])[0].id, name: '/root/read', task: '核对文档', status: 'running' });
});
it('retires the dispatch spinner when the CLI finishes without an outcome', () => {
  const receipt = { type: 'nativeSubagent', id: 'anonymous' };
  const rows = nativeSubagents([event(1,{...receipt,status:'dispatching'}),event(2,{...receipt,status:'unknown'})]);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('unknown');
});
it('clears withdrawn ACP titles and reports, and honors an explicitly unknown state', () => {
  const item = {type:'nativeSubagent',id:'a',agentId:'reader'};
  const rows = nativeSubagents([
    event(1,{...item,name:'Reader',task:'Read',status:'running',text:'Earlier report'}),
    event(2,{...item,name:null,task:null,status:'unknown',text:''}),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('unknown');
  expect(rows[0].name).toBeUndefined();expect(rows[0].task).toBeUndefined();expect(rows[0].text).toBeUndefined();
});
