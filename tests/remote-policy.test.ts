import { expect, it } from 'vitest';
import type { Config } from '../shared/types';

const modulePath = '../server/remote-policy';
const policy = await import(modulePath).catch(() => null);
function allowed(method: string, path: string, body?: unknown) {
  expect(policy, 'host remote policy must exist').not.toBeNull();
  return policy.remoteRequestAllowed(method, path, body);
}

it('allows chat, attachment, approval, question and individual stop workflows', () => {
  for (const path of ['/api/remote/config', '/api/conversations', '/api/conversations/chat-1', '/api/conversations/chat-1/history?after=0&limit=50', '/api/conversations/chat-1/events?after=3', '/api/conversations/chat-1/queue', '/api/v2/tasks', '/api/v2/tasks/task-1/control', '/api/conversations/chat-1/attachments/file-1?download=1', '/api/v2/assets/asset-1/versions/version-1/files/0'])
    expect(allowed('GET', path), path).toBe(true);
  expect(allowed('POST', '/api/conversations', {agentId: 'a', projectId: 'p'})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/queue', {text: 'hello', commandKey: 'send-1', attachments: []})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/continue', {text: '', commandKey: 'send-1', attachments: []})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/attachments?name=%E6%96%87%E4%BB%B6.bin')).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/approvals/approval-1', {decision: 'approve'})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/questions/question-1', {answers: {q: ['answer']}})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/stop', {expectedExecutionId: 'run-1'})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/stop', {expectedExecutionId: null})).toBe(true);
  expect(allowed('POST', '/api/conversations/chat-1/stop', {})).toBe(false);
  expect(allowed('POST', '/api/v2/tasks/task-1/stop', {expectedRevision: 3})).toBe(true);
});

it('denies administration, secret-bearing configuration, shell and filesystem APIs by default', () => {
  for (const path of ['/api/config', '/api/cli/config/agents/upsert', '/api/cli/invoke', '/api/task-tools', '/api/capabilities', '/api/effective', '/api/folders', '/api/market', '/api/automations', '/api/system-tasks/chat-1/title/run', '/api/conversations/chat-1/terminal', '/api/conversations/chat-1/workspace', '/api/conversations/chat-1/local-file', '/api/v2/tasks/task-1', '/api/conversations/chat-1/references', '/api/skill-learning', '/api/skills/skill-1', '/api/skills/skill-1/suggestions/suggestion-1/accept', '/api/v2/knowledge-bases', '/api/projects/project-1/workspaces/workspace-1/code-graph', '/api/projects/project-1/workspaces/workspace-1/code-graph/refresh', '/api/unknown-future-endpoint'])
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(allowed(method, path, {}), method + path).toBe(false);
  expect(allowed('PUT', '/api/remote/config', {})).toBe(false);
});

it('rejects URL aliases, unknown queries and runtime configuration smuggled through chat', () => {
  for (const path of ['https://host/api/conversations', '//host/api/conversations', '/api/conversations/../config', '/api/conversations/%2e%2e/config', '/api/conversations%2fchat-1', '/api\\conversations', '/api/conversations#fragment', '/api/conversations?secret=1', '/api/conversations?projectId=p&projectId=q'])
    expect(allowed('GET', path), path).toBe(false);
  for (const field of ['cwd', 'workspaceId', 'approvalMode', 'runtime', 'env', 'cli', 'instructions', 'mcp'])
    expect(allowed('POST', '/api/conversations', {agentId: 'a', [field]: 'injected'}), field).toBe(false);
  for (const decision of ['approve-always', 'approve-rule', 'approve-session'])
    expect(allowed('POST', '/api/conversations/chat-1/approvals/request-1', {decision})).toBe(false);
  expect(allowed('POST', '/api/conversations/chat-1/queue', {text: 'hello', commandKey: 'key', env: {TOKEN: 'secret'}})).toBe(false);
  expect(allowed('POST', '/api/conversations/chat-1/stop', {conversationId: 'other'})).toBe(false);
});

it('projects safe config with no paths, instructions, secrets or future fields', () => {
  expect(policy, 'host remote policy must exist').not.toBeNull();
  const config = {version: 2, agents: [{id: 'a', name: 'Agent', defaultCli: 'codex', models: {codex: 'model'}, instructions: 'SECRET', runtime: {codex: {env: {TOKEN: 'SECRET'}}}, futureSecret: 'SECRET'}], projects: [{id: 'p', name: 'Project', agentIds: ['a'], cwd: '/SECRET', background: 'SECRET', mcp: [{url: 'https://SECRET'}]}], connections: [{env: {TOKEN: 'SECRET'}}], system: {futureSecret: 'SECRET'}} as unknown as Config;
  const summary = policy.remoteConfigSummary(config);
  expect(summary).toEqual({agents: [{id: 'a', name: 'Agent', defaultCli: 'codex', models: {codex: 'model'}}], projects: [{id: 'p', name: 'Project', agentIds: ['a']}], settings: {localExecution: true, remoteConfiguration: 'read-only'}});
  expect(JSON.stringify(summary)).not.toContain('SECRET');
});
